// Card review (docs/specs/2026-11-27-card-review.md): a card's purchases are
// read from Plaid only when its owner opens a review, picked, and added as
// expenses of their own. On a shared card they are taken out of the payment
// they came in (card-payments.ts); on a personal card they are added and the
// card is marked reviewed to the end of the range.
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { addDays, isIsoDate, todayIn } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { formatCents } from "@abacus/core/money";
import type { Rule } from "@abacus/core/split";
import { account, bankConnection, bankTransaction, cardPayment, expense, household, type Account, type BankConnection, type CardMode, type BankTransaction, type CardPayment, type Expense, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";
import { BILL_DAYS, fittingExpenses, tieTransaction } from "./bank-match.ts";
import { billSuggestions, description, isCardPayment, NEEDS_KIND, plaidCents, type BankDeps } from "./bank.ts";
import { lockPayment, lockShare, setStillShared } from "./card-payments.ts";
import { createExpense, enterAmount, isLive } from "./expenses.ts";
import { isUuid } from "./ids.ts";
import { isPlaidError, needsRelinkError, type PlaidTransaction } from "./plaid.ts";
import { openSecret } from "./secret-box.ts";

// How far back a first review starts, and how far back one can be widened.
// Plaid holds 90 days for a card connected without asking for more.
export const REVIEW_DAYS = 30;
export const WIDEST_DAYS = 730;
// How far back a payment can be shared by hand after the card is made shared.
export const PAST_PAYMENT_DAYS = 90;
const PAGE = 500;

const notYours = () => new UserError("that card is not one of yours");

type Card = { a: Account; c: BankConnection; groupKind: string; timezone: string };

// The actor's own connected card, locked when `lock`. Another member's card
// reads as not found.
async function ownCard(tx: Db, actor: Member, accountId: string, lock = false): Promise<Card> {
  if (!isUuid(accountId)) throw notYours();
  const q = tx
    .select({ a: account, c: bankConnection, groupKind: household.kind, timezone: household.timezone })
    .from(account)
    .innerJoin(bankConnection, eq(bankConnection.id, account.bankConnectionId))
    .innerJoin(household, eq(household.id, account.householdId))
    .where(and(eq(account.id, accountId), eq(account.householdId, actor.householdId), eq(bankConnection.ownerId, actor.id), isNull(account.archivedAt)));
  const [row] = lock ? await q.for("update", { of: account }) : await q;
  if (!row || !row.a.cardMode) throw notYours();
  return row;
}

function reviewable(card: Card) {
  if (card.c.removedAt || !card.c.accessToken) throw new UserError("that bank is no longer connected");
  if (card.a.shareAll) throw new UserError("this card shares every purchase as it comes in; turn that off to review it");
}

// ---- Listing ----------------------------------------------------------------

export type PaymentLine = { id: string; accountId: string; date: string; amountCents: number; mode: CardMode; expenseId: string | null; stillSharedCents: number };

export type CardLine = {
  id: string;
  name: string;
  lastFour: string | null;
  institutionName: string;
  cardMode: CardMode;
  shareAll: boolean;
  reviewedThrough: string | null;
  needsRelink: boolean;
  latestPayment: PaymentLine | null;
};

async function paymentLines(db: Db, householdId: string, accountIds: string[], limit?: number, only?: string): Promise<PaymentLine[]> {
  if (accountIds.length === 0) return [];
  const q = db
    .select({ p: cardPayment, total: expense.totalCents, status: expense.status })
    .from(cardPayment)
    .leftJoin(expense, eq(expense.id, cardPayment.expenseId))
    .where(and(eq(cardPayment.householdId, householdId), inArray(cardPayment.accountId, accountIds), only ? eq(cardPayment.id, only) : undefined))
    .orderBy(desc(cardPayment.date), desc(cardPayment.createdAt));
  const rows = limit ? await q.limit(limit) : await q;
  return rows.map(({ p, total, status }) => ({
    id: p.id,
    accountId: p.accountId,
    date: p.date,
    amountCents: p.amountCents,
    mode: p.mode,
    expenseId: p.expenseId,
    stillSharedCents: status && isLive({ status }) ? (total ?? 0) : 0,
  }));
}

// One payment as the screens show it.
export async function paymentLine(db: Db, p: CardPayment): Promise<PaymentLine> {
  return (await paymentLines(db, p.householdId, [p.accountId], 1, p.id))[0]!;
}

// The cards the actor connected, with each one's latest payment. Never asks
// Plaid: counting a card's purchases would mean reading them unasked.
export async function listCardAccounts(db: Db, actor: Member): Promise<CardLine[]> {
  const rows = await db
    .select({ a: account, c: bankConnection })
    .from(account)
    .innerJoin(bankConnection, eq(bankConnection.id, account.bankConnectionId))
    .where(
      and(
        eq(account.householdId, actor.householdId),
        eq(bankConnection.ownerId, actor.id),
        isNull(bankConnection.removedAt),
        isNull(account.archivedAt),
        sql`${account.cardMode} is not null`,
      ),
    )
    .orderBy(account.name, account.lastFour);
  const payments = await paymentLines(db, actor.householdId, rows.map((r) => r.a.id));
  return rows.map(({ a, c }) => ({
    id: a.id,
    name: a.name,
    lastFour: a.lastFour,
    institutionName: c.institutionName,
    cardMode: a.cardMode!,
    shareAll: a.shareAll,
    reviewedThrough: a.reviewedThrough,
    needsRelink: c.status !== "ok",
    latestPayment: payments.find((p) => p.accountId === a.id) ?? null,
  }));
}

// One of the actor's cards, with its payments newest first.
export async function cardAccount(db: Db, actor: Member, accountId: string): Promise<CardLine & { payments: PaymentLine[] }> {
  const { a, c } = await ownCard(db, actor, accountId);
  if (c.removedAt) throw notYours();
  const payments = await paymentLines(db, actor.householdId, [a.id], 24);
  return {
    id: a.id,
    name: a.name,
    lastFour: a.lastFour,
    institutionName: c.institutionName,
    cardMode: a.cardMode!,
    shareAll: a.shareAll,
    reviewedThrough: a.reviewedThrough,
    needsRelink: c.status !== "ok",
    latestPayment: payments[0] ?? null,
    payments,
  };
}

// Whether a card's payments are shared. Payments the sync records from now on
// follow it; earlier ones stay as they were until shared by hand
// (sharePastPayment).
export async function setCardMode(db: Db, actor: Member, accountId: string, mode: CardMode): Promise<Account> {
  return db.transaction(async (tx) => {
    const { a, c } = await ownCard(tx, actor, accountId, true);
    if (c.removedAt) throw new UserError("that bank is no longer connected");
    if (a.cardMode === mode) return a;
    const [updated] = await tx.update(account).set({ cardMode: mode }).where(eq(account.id, a.id)).returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "account.card_mode_changed",
      entity: { type: "account", id: a.id },
      detail: { from: a.cardMode, to: mode },
    });
    return updated!;
  });
}

// ---- The range --------------------------------------------------------------

type Range = { from: string; to: string; payment: CardPayment | null };

// What a review covers. A shared card's is one payment: from the day after
// the payment before it (or REVIEW_DAYS back) to the payment's day. A
// personal card's runs from the day after it was last reviewed (or
// REVIEW_DAYS back) to today. `from` widens it back.
async function rangeOf(tx: Db, a: Account, today: string, opts: { payment?: string; from?: string }, lock: boolean): Promise<Range> {
  let range: Range;
  if (a.cardMode === "shared") {
    const payments = await tx
      .select()
      .from(cardPayment)
      .where(and(eq(cardPayment.accountId, a.id), eq(cardPayment.householdId, a.householdId)))
      .orderBy(desc(cardPayment.date), desc(cardPayment.createdAt));
    const at = opts.payment ? payments.findIndex((p) => p.id === opts.payment) : payments.findIndex((p) => p.mode === "shared");
    const chosen = payments[at];
    if (!chosen) throw new UserError(opts.payment ? "that payment is not one of this card's" : "this card has no shared payment to review yet");
    if (chosen.mode !== "shared") throw new UserError("that payment was made while the card was personal, so nothing of it is shared");
    const before = payments.slice(at + 1).find((p) => p.date < chosen.date);
    const p = lock ? (await lockPayment(tx, a.householdId, chosen.id))! : chosen;
    range = { from: before ? addDays(before.date, 1) : addDays(p.date, -REVIEW_DAYS), to: p.date, payment: p };
  } else {
    range = { from: a.reviewedThrough ? addDays(a.reviewedThrough, 1) : addDays(today, -REVIEW_DAYS), to: today, payment: null };
  }
  if (opts.from !== undefined) {
    if (!isIsoDate(opts.from)) throw new UserError("from must be a date like 2026-01-31");
    if (opts.from < addDays(today, -WIDEST_DAYS)) throw new UserError("a review can go back two years at most");
    if (opts.from > range.to) throw new UserError("from must be on or before the end of the review");
    range.from = opts.from;
  }
  return range;
}

// ---- Reading purchases from Plaid -------------------------------------------

type Fetched = {
  plaidTransactionId: string;
  date: string;
  amountCents: number;
  description: string;
  // Money in that is a payment to the card, not a refund.
  cardPayment: boolean;
};

// The card's posted dollar transactions in the range, newest first.
async function fetchRange(bank: BankDeps, c: BankConnection, a: Account, from: string, to: string): Promise<Fetched[]> {
  if (from > to) return [];
  const accessToken = openSecret(c.accessToken!, bank.key);
  const all: PlaidTransaction[] = [];
  try {
    for (let offset = 0; ; offset += PAGE) {
      const page = await bank.plaid.transactionsGet({ accessToken, startDate: from, endDate: to, accountIds: [a.plaidAccountId!], count: PAGE, offset });
      all.push(...page.transactions);
      if (page.transactions.length < PAGE || all.length >= page.total_transactions) break;
    }
  } catch (e) {
    if (isPlaidError(e, "PRODUCT_NOT_READY")) throw new UserError("the bank is still sending this card's transactions; try again in a few minutes");
    if (needsRelinkError(e)) throw new UserError("this bank needs to be signed in to again, in Settings → Bank");
    throw e;
  }
  const out: Fetched[] = [];
  for (const t of all) {
    const cents = plaidCents(t.amount);
    if (t.pending || t.iso_currency_code !== "USD" || !cents || t.account_id !== a.plaidAccountId || t.date < from || t.date > to) continue;
    out.push({ plaidTransactionId: t.transaction_id, date: t.date, amountCents: cents, description: description(t), cardPayment: cents < 0 && isCardPayment(t) });
  }
  return out.sort((x, y) => y.date.localeCompare(x.date) || x.plaidTransactionId.localeCompare(y.plaidTransactionId));
}

// ---- Opening a review -------------------------------------------------------

// A purchase may already be in the ledger: as a recurring cost, a bill
// waiting for its amount, or (on a shared card) as an expense of its own
// that no payment has taken out yet, made while the card was personal or
// shared every purchase. Picking it ties it, or takes it out of the payment,
// rather than adding it again.
export type Suggestion = { kind: "recurring" | "bill" | "added"; expenseId: string; name: string };

export type ReviewLine = Fetched & {
  // Money in (a refund or a payment) is shown, never picked.
  moneyIn: boolean;
  // The expense it already is, when added.
  addedExpenseId: string | null;
  // A recurring cost or a bill waiting for its amount it may be.
  suggestion: Suggestion | null;
  // Whether the page starts it ticked.
  ticked: boolean;
};

export type Review = {
  account: { id: string; name: string; lastFour: string | null; cardMode: CardMode };
  from: string;
  to: string;
  payment: PaymentLine | null;
  payments: PaymentLine[];
  lines: ReviewLine[];
};

export async function getReview(db: Db, bank: BankDeps, actor: Member, accountId: string, opts: { payment?: string; from?: string }, now: Date): Promise<Review> {
  const card = await ownCard(db, actor, accountId);
  reviewable(card);
  const today = todayIn(card.timezone, now);
  const range = await rangeOf(db, card.a, today, opts, false);
  const fetched = await fetchRange(bank, card.c, card.a, range.from, range.to);

  const ids = fetched.map((f) => f.plaidTransactionId);
  const stored = ids.length
    ? await db
        .select({
          plaidId: bankTransaction.plaidTransactionId,
          state: bankTransaction.state,
          expenseId: bankTransaction.expenseId,
          cardPaymentId: bankTransaction.cardPaymentId,
          status: expense.status,
          name: expense.description,
        })
        .from(bankTransaction)
        .leftJoin(expense, eq(expense.id, bankTransaction.expenseId))
        .where(and(eq(bankTransaction.householdId, actor.householdId), inArray(bankTransaction.plaidTransactionId, ids)))
    : [];
  const suggested = new Map<string, Suggestion>();
  // In the ledger on its own, and in this payment's range: counted twice
  // until it is taken out.
  const inLedger = range.payment
    ? stored.filter((s) => s.state === "added" && s.expenseId && !s.cardPaymentId && s.status && isLive({ status: s.status }))
    : [];
  for (const s of inLedger) suggested.set(s.plaidId, { kind: "added", expenseId: s.expenseId!, name: s.name! });
  const added = new Map(stored.filter((s) => s.state === "added" && s.expenseId && !suggested.has(s.plaidId)).map((s) => [s.plaidId, s.expenseId!]));

  const open = fetched.filter((f) => f.amountCents > 0 && !added.has(f.plaidTransactionId) && !suggested.has(f.plaidTransactionId));
  const taken = new Set<string>();
  for (const f of open) {
    const fits = await fittingExpenses(db, actor.id, { householdId: actor.householdId, accountId: card.a.id, amountCents: f.amountCents, date: f.date }, { lock: false });
    if (fits.length === 1 && !taken.has(fits[0]!.id)) {
      taken.add(fits[0]!.id);
      suggested.set(f.plaidTransactionId, { kind: "recurring", expenseId: fits[0]!.id, name: fits[0]!.description });
    }
  }
  const bills = await billSuggestions(
    db,
    actor,
    open.filter((f) => !suggested.has(f.plaidTransactionId)).map((f) => ({ id: f.plaidTransactionId, date: f.date, amountCents: f.amountCents })),
  );
  for (const [plaidId, near] of bills) {
    const bill = near.find((b) => !taken.has(b.expenseId));
    if (!bill) continue;
    taken.add(bill.expenseId);
    suggested.set(plaidId, { kind: "bill", expenseId: bill.expenseId, name: bill.name });
  }

  const payments = card.a.cardMode === "shared" ? await paymentLines(db, actor.householdId, [card.a.id], 24) : [];
  const shared = card.a.cardMode === "shared";
  return {
    account: { id: card.a.id, name: card.a.name, lastFour: card.a.lastFour, cardMode: card.a.cardMode! },
    from: range.from,
    to: range.to,
    payment: range.payment ? (payments.find((p) => p.id === range.payment!.id) ?? null) : null,
    payments,
    lines: fetched.map((f) => {
      const suggestion = suggested.get(f.plaidTransactionId) ?? null;
      return {
        ...f,
        moneyIn: f.amountCents < 0,
        addedExpenseId: added.get(f.plaidTransactionId) ?? null,
        suggestion,
        ticked: shared && !!suggestion,
      };
    }),
  };
}

// ---- Earlier payments -------------------------------------------------------

export type PastPayment = {
  plaidTransactionId: string;
  date: string;
  // Positive: what was paid.
  amountCents: number;
  description: string;
  // The recorded payment when the sync saw it while the card was personal.
  paymentId: string | null;
};

function sharedCard(card: Card) {
  reviewable(card);
  if (card.a.cardMode !== "shared") throw new UserError("earlier payments can be shared only on a shared card");
}

// The card's posted payments in the last PAST_PAYMENT_DAYS, read from Plaid.
async function fetchPayments(bank: BankDeps, card: Card, now: Date): Promise<Fetched[]> {
  const today = todayIn(card.timezone, now);
  return (await fetchRange(bank, card.c, card.a, addDays(today, -PAST_PAYMENT_DAYS), today)).filter((f) => f.cardPayment);
}

// Payments to a shared card that are not shared yet: the sync never saw them
// (it saw them before this feature, or the card was personal and they were
// missed), or it recorded them while the card was personal. Newest first.
export async function findPastPayments(db: Db, bank: BankDeps, actor: Member, accountId: string, now: Date): Promise<PastPayment[]> {
  const card = await ownCard(db, actor, accountId);
  sharedCard(card);
  const found = await fetchPayments(bank, card, now);
  if (found.length === 0) return [];
  const recorded = await db
    .select()
    .from(cardPayment)
    .where(and(eq(cardPayment.householdId, actor.householdId), inArray(cardPayment.plaidTransactionId, found.map((f) => f.plaidTransactionId))));
  const byPlaid = new Map(recorded.map((p) => [p.plaidTransactionId, p]));
  return found
    .filter((f) => byPlaid.get(f.plaidTransactionId)?.mode !== "shared")
    .map((f) => ({
      plaidTransactionId: f.plaidTransactionId,
      date: f.date,
      amountCents: -f.amountCents,
      description: f.description,
      paymentId: byPlaid.get(f.plaidTransactionId)?.id ?? null,
    }));
}

// Shares one earlier payment by hand: it becomes an expense the card's owner
// paid, split the usual way, and its review can then be opened. The payment
// is read from Plaid again; nothing is taken from the client.
export async function sharePastPayment(db: Db, bank: BankDeps, actor: Member, accountId: string, plaidTransactionId: string, now: Date): Promise<CardPayment> {
  const first = await ownCard(db, actor, accountId);
  sharedCard(first);
  const t = (await fetchPayments(bank, first, now)).find((f) => f.plaidTransactionId === plaidTransactionId);
  if (!t) throw new UserError(`that is not a payment to this card in the last ${PAST_PAYMENT_DAYS} days`);
  const amountCents = -t.amountCents;
  const by = { kind: "member" as const, memberId: actor.id };

  return db.transaction(async (tx) => {
    const card = await ownCard(tx, actor, accountId, true);
    sharedCard(card);
    const today = todayIn(card.timezone, now);
    // Plaid ids are unique across every group, so this looks in all of them.
    const lookup = async () => (await tx.select().from(cardPayment).where(eq(cardPayment.plaidTransactionId, t.plaidTransactionId)).for("update"))[0];
    let p = await lookup();
    let inserted = false;
    if (!p) {
      const [row] = await tx
        .insert(cardPayment)
        .values({ householdId: card.a.householdId, accountId: card.a.id, plaidTransactionId: t.plaidTransactionId, date: t.date, amountCents, mode: "shared" })
        .onConflictDoNothing({ target: cardPayment.plaidTransactionId })
        .returning();
      inserted = !!row;
      // When a sync stored it first, read what it stored.
      p = row ?? (await lookup());
    }
    if (!p) throw new UserError("that payment could not be shared; try again");
    if (p.householdId !== card.a.householdId || p.accountId !== card.a.id) throw new UserError("that payment is not on this card");
    if (inserted) {
      await writeAudit(tx, {
        householdId: p.householdId,
        actor: by,
        action: "card_payment.recorded",
        entity: { type: "card_payment", id: p.id },
        detail: { accountId: card.a.id, mode: "shared" },
      });
    } else {
      if (p.mode === "shared") throw new UserError("that payment is already shared");
      [p] = await tx.update(cardPayment).set({ mode: "shared" }).where(eq(cardPayment.id, p.id)).returning();
      await writeAudit(tx, {
        householdId: p!.householdId,
        actor: by,
        action: "card_payment.shared",
        entity: { type: "card_payment", id: p!.id },
        detail: { was: "personal" },
      });
    }
    await setStillShared(tx, p!, p!.amountCents, { a: card.a, owner: actor, by: actor, today });
    return (await lockPayment(tx, p!.householdId, p!.id))!;
  });
}

// ---- Submitting -------------------------------------------------------------

export type ReviewPick = {
  plaidTransactionId: string;
  description?: string;
  category?: string;
  rule?: Rule;
  // A recurring cost or a bill waiting for its amount this purchase is:
  // tied to it rather than added as an expense of its own.
  tieTo?: string;
};

export type ReviewResult = { expenses: Expense[]; paymentExpense: Expense | null; from: string; to: string };

// Adds the picked purchases, all or none. On a shared card they are taken out
// of the payment, which may not go below zero. Each purchase is read from
// Plaid again: a client cannot add one that is not on this card in this
// range, or change its amount.
export async function submitReview(
  db: Db,
  bank: BankDeps,
  actor: Member,
  accountId: string,
  opts: { payment?: string; from?: string; items: ReviewPick[] },
  now: Date,
): Promise<ReviewResult> {
  if (!Array.isArray(opts.items) || opts.items.length === 0) throw new UserError("pick at least one purchase");
  const seen = new Set<string>();
  for (const i of opts.items) {
    if (typeof i?.plaidTransactionId !== "string" || !i.plaidTransactionId) throw new UserError("each pick needs a plaidTransactionId");
    if (seen.has(i.plaidTransactionId)) throw new UserError("the same purchase was picked twice");
    seen.add(i.plaidTransactionId);
  }

  const first = await ownCard(db, actor, accountId);
  reviewable(first);
  const outside = await rangeOf(db, first.a, todayIn(first.timezone, now), opts, false);
  const fetched = new Map((await fetchRange(bank, first.c, first.a, outside.from, outside.to)).map((f) => [f.plaidTransactionId, f]));

  return db.transaction(async (tx) => {
    const card = await ownCard(tx, actor, accountId, true);
    reviewable(card);
    if (card.groupKind === "business" && !card.a.kind) throw new UserError(NEEDS_KIND);
    const today = todayIn(card.timezone, now);
    // Read again under the lock: a review submitted meanwhile may have moved
    // the range on.
    const range = await rangeOf(tx, card.a, today, opts, true);
    const picks = opts.items.map((i) => {
      const f = fetched.get(i.plaidTransactionId);
      if (!f || f.date < range.from || f.date > range.to) throw new UserError("one of those purchases is not on this card in the dates being reviewed");
      if (f.amountCents <= 0) throw new UserError("money coming in cannot be added");
      return { ...i, f };
    });
    picks.sort((x, y) => x.f.date.localeCompare(y.f.date) || x.f.plaidTransactionId.localeCompare(y.f.plaidTransactionId));
    const rows = [];
    for (const p of picks) rows.push({ p, ...(await waitingRow(tx, card, p.f, now, { payment: range.payment, tieTo: p.tieTo })) });
    const sum = rows.reduce((s, r) => s + r.row.amountCents, 0);

    let live: Expense | null = null;
    if (range.payment) {
      live = await lockShare(tx, range.payment);
      if (!live) throw new UserError("nothing of this payment is still shared");
      if (sum > live.totalCents!) {
        throw new UserError(`those purchases add up to ${formatCents(sum)}, more than the ${formatCents(live.totalCents!)} still shared in this payment`);
      }
    }

    const made: Expense[] = [];
    const by = { kind: "member" as const, memberId: actor.id };
    const alreadyInLedger: string[] = [];
    for (const { p, row: t, inLedger } of rows) {
      let e: Expense;
      if (inLedger) {
        e = inLedger;
        alreadyInLedger.push(e.id);
      } else if (p.tieTo) {
        e = await tieTo(tx, actor, t, p.tieTo, now);
      } else {
        e = await createExpense(tx, actor.householdId, {
          kind: "bank",
          actor,
          auto: false,
          date: p.f.date,
          description: p.description?.trim() || p.f.description,
          category: p.category,
          totalCents: p.f.amountCents,
          payerId: actor.id,
          accountId: card.a.id,
          today,
          seed: p.f.plaidTransactionId,
          rule: p.rule,
        });
        await tx.update(bankTransaction).set({ state: "added", expenseId: e.id, sortedBy: actor.id, sortedAt: now }).where(eq(bankTransaction.id, t.id));
        await writeAudit(tx, {
          householdId: actor.householdId,
          actor: by,
          action: "bank_transaction.added",
          entity: { type: "bank_transaction", id: t.id },
          detail: { expenseId: e.id, review: true },
        });
      }
      if (range.payment) await tx.update(bankTransaction).set({ cardPaymentId: range.payment.id }).where(eq(bankTransaction.id, t.id));
      made.push(e);
    }

    let paymentExpense: Expense | null = null;
    if (range.payment) {
      const left = live!.totalCents! - sum;
      paymentExpense = await setStillShared(tx, range.payment, left, {
        a: card.a,
        owner: actor,
        by: actor,
        today,
        ...(left === 0 ? { reason: "all of it split as purchases" } : {}),
      });
    } else if (!card.a.reviewedThrough || card.a.reviewedThrough < range.to) {
      await tx.update(account).set({ reviewedThrough: range.to }).where(eq(account.id, card.a.id));
    }
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: by,
      action: "card_review.submitted",
      entity: { type: "account", id: card.a.id },
      detail: { from: range.from, to: range.to, count: picks.length, totalCents: sum, ...(alreadyInLedger.length ? { alreadyInLedger } : {}), ...(range.payment ? { cardPaymentId: range.payment.id } : {}) },
    });
    return { expenses: made, paymentExpense, from: range.from, to: range.to };
  });
}

// The purchase's stored row, waiting to be sorted: made now, or one stored
// before and not added (set aside, or put back out of a payment), refreshed
// from what Plaid says now. One already added refuses the whole review, so
// two tabs add it once; except one in the ledger on its own that a shared
// payment's review takes out (`inLedger`: its expense, locked).
async function waitingRow(tx: Db, card: Card, f: Fetched, now: Date, claim: { payment: CardPayment | null; tieTo?: string }): Promise<{ row: BankTransaction; inLedger: Expense | null }> {
  const [old] = await tx
    .select()
    .from(bankTransaction)
    // Plaid ids are unique across every group, so this looks in all of them
    // and refuses one that is not this card's.
    .where(eq(bankTransaction.plaidTransactionId, f.plaidTransactionId))
    .for("update");
  if (old) {
    if (old.householdId !== card.a.householdId || old.accountId !== card.a.id) throw new UserError("one of those purchases is not on this card");
    if (old.state === "added") {
      if (claim.payment && !old.cardPaymentId && old.expenseId && claim.tieTo === old.expenseId) {
        const [e] = await tx.select().from(expense).where(and(eq(expense.id, old.expenseId), eq(expense.householdId, card.a.householdId))).for("update");
        if (e && isLive(e)) return { row: old, inLedger: e };
      }
      throw new UserError(`${old.description} on ${old.date} has already been added`);
    }
    const [row] = await tx
      .update(bankTransaction)
      .set({ state: "to_sort", expenseId: null, cardPaymentId: null, sortedAt: now, date: f.date, amountCents: f.amountCents, description: f.description })
      .where(eq(bankTransaction.id, old.id))
      .returning();
    return { row: row!, inLedger: null };
  }
  const [row] = await tx
    .insert(bankTransaction)
    .values({
      householdId: card.a.householdId,
      connectionId: card.c.id,
      accountId: card.a.id,
      plaidTransactionId: f.plaidTransactionId,
      date: f.date,
      amountCents: f.amountCents,
      description: f.description,
    })
    .returning();
  return { row: row!, inLedger: null };
}

// Ties the purchase to the recurring cost or bill it is. A bill waiting for
// its amount gets the purchase's, as matchBill does.
async function tieTo(tx: Db, actor: Member, t: BankTransaction, expenseId: string, now: Date): Promise<Expense> {
  const notFit = new UserError(`${t.description} on ${t.date} does not fit that cost`);
  if (!isUuid(expenseId)) throw notFit;
  const [target] = await tx
    .select()
    .from(expense)
    .where(and(eq(expense.id, expenseId), eq(expense.householdId, actor.householdId)))
    .for("update");
  if (!target) throw notFit;
  let tied: Expense;
  if (target.status === "needs_amount") {
    if (target.payerId !== actor.id || !target.templateLineageId || target.date < addDays(t.date, -BILL_DAYS) || target.date > addDays(t.date, BILL_DAYS)) throw notFit;
    tied = await enterAmount(tx, actor, target.id, t.amountCents);
  } else {
    const fits = await fittingExpenses(tx, actor.id, t);
    if (!fits.some((e) => e.id === target.id)) throw notFit;
    tied = target;
  }
  const by = { kind: "member" as const, memberId: actor.id };
  if (!(await tieTransaction(tx, t, tied.id, now, by, { review: true }))) throw new UserError("that cost already has a purchase tied to it");
  return tied;
}
