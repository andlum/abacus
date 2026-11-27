// Connected banks. A member signs in to their bank through Plaid; each card
// or account there becomes one of the group's accounts, and its posted
// purchases arrive here to be sorted. Only the person who connected it sees
// them: they add one as an expense, or set it aside. An account marked
// `share_all` skips the sorting, and each purchase on it is added at once.
//
// Plaid is passed in (`BankDeps`), with the key that seals its access tokens,
// so tests run against a fake. Nothing here logs a token or a transaction.
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { account, bankConnection, bankTransaction, expense, household, member, type Account, type BankConnection, type BankTransaction, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { addDays, todayIn } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { parseCents } from "@abacus/core/money";
import { insertBankAccount } from "./accounts.ts";
import { writeAudit } from "./audit.ts";
import { BILL_DAYS, dropWithdrawn, tieTransaction, tryTie, untie } from "./bank-match.ts";
import { recordPayment } from "./card-payments.ts";
import { createExpense, enterAmount } from "./expenses.ts";
import { isUuid } from "./ids.ts";
import { isPlaidError, needsRelinkError, PlaidError, type PlaidAccount, type PlaidApi, type PlaidSyncPage, type PlaidTransaction } from "./plaid.ts";
import { openSecret, sealSecret } from "./secret-box.ts";

export type BankDeps = { plaid: PlaidApi; key: Buffer };

// Plaid's amount, in dollars as a JSON number, to integer cents with its sign.
// The number is written out to two places by toFixed, which gives back the
// two decimals Plaid sent exactly, and that text is read as whole numbers:
// no multiplying a float by 100. Null when it is not a usable amount.
export function plaidCents(amount: number): number | null {
  if (!Number.isFinite(amount)) return null;
  const cents = parseCents(Math.abs(amount).toFixed(2));
  if (cents === null) return null;
  return amount < 0 ? -cents : cents;
}

// Money in on a card that is a payment to it, not a refund. Plaid's own
// category for it is LOAN_PAYMENTS_CREDIT_CARD_PAYMENT; some banks file the
// card's side as a transfer in.
export function isCardPayment(t: PlaidTransaction): boolean {
  const c = t.personal_finance_category;
  return !!c && (c.detailed === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" || c.primary === "TRANSFER_IN");
}

export const description = (t: PlaidTransaction) => (t.merchant_name ?? t.name ?? "").replace(/\s+/gu, " ").trim() || "Card transaction";

// ---- Connecting -------------------------------------------------------------

export type ConnectResult = { connection: BankConnection; accounts: Account[]; sync: SyncSummary | null };

// Stores a new connection from the public token Plaid's sign-in window gave,
// adds an account for each of its credit cards, and runs the first sync.
// Checking, savings, loans and the rest are left out, and a sign-in with no
// credit card is refused. Only transactions dated `from` or later are brought
// in; the screens pass `firstSyncFrom(today)`. If the first
// sync fails the connection stays, `sync` is null, and the next sync tries
// again.
// A new connection starts with the last 30 days of purchases, so there is
// something to sort on the first day.
export const HISTORY_DAYS = 30;
export const firstSyncFrom = (today: string) => addDays(today, -HISTORY_DAYS);

export async function connectBank(
  db: Db,
  bank: BankDeps,
  actor: Member,
  { publicToken, institutionName }: { publicToken: string; institutionName: string },
  from: string,
  now: Date = new Date(),
): Promise<ConnectResult> {
  const { accessToken, itemId } = await bank.plaid.exchangePublicToken(publicToken);
  let saved: { connection: BankConnection; accounts: Account[] };
  try {
    const plaidAccounts = (await bank.plaid.getAccounts(accessToken)).filter(isCreditCard);
    if (!plaidAccounts.length) throw new UserError("that sign-in has no credit cards; Clementine only follows credit cards");
    // The bank's name comes from Plaid; the browser's is only a fallback.
    const institution = await bank.plaid.getInstitution(accessToken).catch(() => null);
    const bankName = institution?.name ?? institutionName;
    await refuseDuplicate(db, actor.householdId, bankName, plaidAccounts);
    saved = await db.transaction(async (tx) => {
      const [connection] = await tx
        .insert(bankConnection)
        .values({
          householdId: actor.householdId,
          ownerId: actor.id,
          itemId,
          accessToken: sealSecret(accessToken, bank.key),
          institutionName: bankName.replace(/\s+/gu, " ").trim() || "Bank",
          syncFrom: from,
        })
        .returning();
      await writeAudit(tx, {
        householdId: actor.householdId,
        actor: { kind: "member", memberId: actor.id },
        action: "bank_connection.connected",
        entity: { type: "bank_connection", id: connection!.id },
        // Kept so a later migration can fill an institution_id column.
        detail: { institutionId: institution?.institutionId ?? null },
      });
      const accounts: Account[] = [];
      for (const a of plaidAccounts) {
        accounts.push(
          await insertBankAccount(tx, actor, { name: a.name, lastFour: a.mask, bankConnectionId: connection!.id, plaidAccountId: a.account_id }),
        );
      }
      return { connection: connection!, accounts };
    });
  } catch (e) {
    // Nothing was stored, so let go of the login Plaid just made.
    await bank.plaid.removeItem(accessToken).catch((removeError: unknown) => {
      // The login stays open at Plaid until someone removes it there.
      console.error(`bank: a refused connection to item ${itemId} could not be removed at Plaid: ${errorLabel(removeError)}`);
    });
    throw e;
  }
  let sync: SyncSummary | null = null;
  try {
    sync = await syncConnection(db, bank, saved.connection.id, now);
  } catch {
    sync = null;
  }
  return { ...saved, sync };
}

// Plaid's own words for a credit card, as /accounts/get returns them.
export const isCreditCard = (a: PlaidAccount) => a.type === "credit" && a.subtype === "credit card";

// What is safe to log about an error: the Plaid code, never the message.
const errorLabel = (e: unknown) => (e instanceof PlaidError ? e.code : e instanceof Error ? e.name : "error");

const norm = (text: string | null | undefined) => (text ?? "").replace(/\s+/gu, " ").trim().toLowerCase();

// Two logins to one joint card would bring in every purchase twice, so a card
// the group already has connected (same bank, same last four digits) is
// refused. Plaid's guidance is to compare institution, account and mask among
// existing Items; here that is the whole group's, since the duplicate is what
// the group would see. The name is not compared, because a member can rename
// an account; it is only used when a card has no usable last four. Archived
// accounts still count while their connection is live. The new login is let
// go by the caller.
//
// Wanted for a full fix, in their own columns: bank_connection.institution_id
// and the Plaid account's mask (account.last_four is already one, and
// account.plaid_account_id). Today the bank is compared by the name Plaid
// gave when the connection was made.
async function refuseDuplicate(db: Db, householdId: string, institutionName: string, incoming: { name: string; mask: string | null }[]) {
  const existing = await db
    .select({ name: account.name, lastFour: account.lastFour, bank: bankConnection.institutionName })
    .from(account)
    .innerJoin(bankConnection, eq(bankConnection.id, account.bankConnectionId))
    .where(and(eq(account.householdId, householdId), isNull(bankConnection.removedAt)));
  const bank = norm(institutionName);
  for (const a of incoming) {
    const mask = a.mask && /^[0-9]{4}$/.test(a.mask) ? a.mask : null;
    const dup = existing.find(
      (e) =>
        norm(e.bank) === bank &&
        (mask ? e.lastFour === mask : !e.lastFour && norm(e.name).replace(/ \(\d+\)$/, "") === norm(a.name).replace(/ \(\d+\)$/, "")),
    );
    if (dup) {
      throw new UserError(
        `${a.name}${mask ? ` ending ${mask}` : ""} at ${institutionName} is already connected in this group. Connecting it twice would bring in every purchase twice.`,
      );
    }
  }
}

// ---- Syncing ----------------------------------------------------------------

// `purchase` is a purchase on a card that does not share everything: it is
// not stored, and a review reads it from Plaid when asked. `refund` is other
// money in on such a card, which is not a payment.
export type SkipReason =
  | "pending"
  | "before_sync_from"
  | "not_usd"
  | "account_not_followed"
  | "zero_or_bad_amount"
  | "already_stored"
  | "purchase"
  | "refund";

export type SyncSummary = {
  // Waiting to be sorted.
  toSort: number;
  // Added as expenses at once, from accounts that share everything.
  added: number;
  // Tied to a recurring cost the group already has, so no expense was made.
  tied: number;
  // Payments to a card, recorded (lib/card-payments.ts).
  payments: number;
  modified: number;
  removed: number;
  skipped: Record<SkipReason, number>;
  // ok; or the bank wants its owner to sign in again; or another sync moved
  // the cursor first, and this one wrote nothing.
  outcome: "ok" | "needs_relink" | "superseded";
};

const emptySummary = (): SyncSummary => ({
  toSort: 0,
  added: 0,
  tied: 0,
  payments: 0,
  modified: 0,
  removed: 0,
  skipped: { pending: 0, before_sync_from: 0, not_usd: 0, account_not_followed: 0, zero_or_bad_amount: 0, already_stored: 0, purchase: 0, refund: 0 },
  outcome: "ok",
});

// How many times to start again when Plaid's data changes mid-read.
const SYNC_ATTEMPTS = 3;

// Reads every page from `cursor` before anything is stored. When Plaid says
// the data changed while paging, starts again from the same cursor.
async function readAll(plaid: PlaidApi, accessToken: string, cursor: string | null): Promise<{ pages: PlaidSyncPage[]; next: string | null }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const pages: PlaidSyncPage[] = [];
      let at = cursor;
      for (;;) {
        const page = await plaid.transactionsSync({ accessToken, ...(at ? { cursor: at } : {}) });
        pages.push(page);
        // An empty next_cursor means nothing new yet: keep where we were.
        at = page.next_cursor || at;
        if (!page.has_more) return { pages, next: at };
      }
    } catch (e) {
      if (attempt < SYNC_ATTEMPTS && isPlaidError(e, "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION")) continue;
      throw e;
    }
  }
}

// Marks a live connection as wanting its owner to sign in again, and says so
// in the audit log once, however many times it is reported.
export async function markNeedsRelink(db: Db, householdId: string, connectionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const changed = await tx
      .update(bankConnection)
      .set({ status: "needs_relink" })
      .where(and(eq(bankConnection.id, connectionId), eq(bankConnection.status, "ok"), isNull(bankConnection.removedAt)))
      .returning({ id: bankConnection.id });
    if (changed.length > 0) {
      await writeAudit(tx, {
        householdId,
        actor: { kind: "system" },
        action: "bank_connection.needs_relink",
        entity: { type: "bank_connection", id: connectionId },
        detail: {},
      });
    }
  });
}

// Brings a connection up to date. Everything read is written, with the new
// cursor, in one transaction after the last page, so a failure part way
// stores nothing and the next sync reads the same changes again.
//
// When the bank wants its owner to sign in again, the connection is marked
// `needs_relink` and this returns normally; the next sync that works marks it
// `ok`. Any other Plaid error is thrown.
export async function syncConnection(db: Db, bank: BankDeps, connectionId: string, now: Date): Promise<SyncSummary> {
  const summary = emptySummary();
  const [start] = await db.select().from(bankConnection).where(eq(bankConnection.id, connectionId));
  if (!start) throw new UserError("that bank connection does not exist");
  if (start.removedAt || !start.accessToken) throw new UserError("that bank is no longer connected");

  let read: Awaited<ReturnType<typeof readAll>>;
  try {
    read = await readAll(bank.plaid, openSecret(start.accessToken, bank.key), start.cursor);
  } catch (e) {
    if (!needsRelinkError(e)) throw e;
    await markNeedsRelink(db, start.householdId, connectionId);
    return { ...summary, outcome: "needs_relink" };
  }

  const added = read.pages.flatMap((p) => p.added);
  const modified = read.pages.flatMap((p) => p.modified);
  const removed = read.pages.flatMap((p) => p.removed);

  await db.transaction(async (tx) => {
    // Another sync of the same connection that finished first has already
    // stored these changes: write nothing.
    const [connection] = await tx.select().from(bankConnection).where(eq(bankConnection.id, connectionId)).for("update");
    if (!connection || connection.removedAt || connection.cursor !== start.cursor) {
      summary.outcome = "superseded";
      return;
    }
    const [group] = await tx.select({ timezone: household.timezone }).from(household).where(eq(household.id, connection.householdId));
    const [owner] = await tx.select().from(member).where(eq(member.id, connection.ownerId));
    const today = todayIn(group!.timezone, now);
    const followed = new Map(
      (
        await tx
          .select()
          .from(account)
          .where(and(eq(account.householdId, connection.householdId), eq(account.bankConnectionId, connectionId), isNull(account.archivedAt)))
      ).map((a) => [a.plaidAccountId!, a]),
    );

    const fresh: { row: BankTransaction; acct: Account }[] = [];
    for (const t of added) {
      const cents = plaidCents(t.amount);
      const skip: SkipReason | null = t.pending
        ? "pending"
        : t.date < connection.syncFrom
          ? "before_sync_from"
          : t.iso_currency_code !== "USD"
            ? "not_usd"
            : !followed.has(t.account_id)
              ? "account_not_followed"
              : !cents
                ? "zero_or_bad_amount"
                : null;
      if (skip) {
        summary.skipped[skip]++;
        continue;
      }
      const acct = followed.get(t.account_id)!;
      if (!acct.shareAll) {
        if (cents! > 0) summary.skipped.purchase++;
        else if (!isCardPayment(t)) summary.skipped.refund++;
        else if (await recordPayment(tx, acct, owner!, { plaidTransactionId: t.transaction_id, date: t.date, amountCents: -cents! }, today)) summary.payments++;
        else summary.skipped.already_stored++;
        continue;
      }
      const [row] = await tx
        .insert(bankTransaction)
        .values({
          householdId: connection.householdId,
          connectionId,
          accountId: acct.id,
          plaidTransactionId: t.transaction_id,
          date: t.date,
          amountCents: cents!,
          description: description(t),
        })
        .onConflictDoNothing({ target: bankTransaction.plaidTransactionId })
        .returning();
      if (!row) {
        summary.skipped.already_stored++;
        continue;
      }
      fresh.push({ row, acct });
    }

    // Once the whole batch is stored, and before anything is added: a
    // recurring cost already counts this money. Two purchases that fit the
    // same cost tie to neither.
    for (const { row, acct } of fresh) {
      if (await tryTie(tx, row, now)) {
        summary.tied++;
      } else if (acct.shareAll && row.amountCents > 0 && (await autoAdd(tx, owner!, row, today, now))) summary.added++;
      else summary.toSort++;
    }

    // A change to a transaction still waiting; one already sorted keeps what
    // it was sorted as.
    for (const t of modified) {
      const cents = plaidCents(t.amount);
      if (t.pending || !cents) continue;
      if (t.date < connection.syncFrom) {
        summary.skipped.before_sync_from++;
        continue;
      }
      if (t.iso_currency_code !== "USD") {
        summary.skipped.not_usd++;
        continue;
      }
      const changed = await tx
        .update(bankTransaction)
        .set({ date: t.date, amountCents: cents, description: description(t) })
        .where(and(eq(bankTransaction.plaidTransactionId, t.transaction_id), eq(bankTransaction.connectionId, connectionId), eq(bankTransaction.state, "to_sort")))
        .returning({ id: bankTransaction.id });
      summary.modified += changed.length;
    }

    // Gone at the bank. Pending ids we never stored are no-ops; an expense
    // already made from one stays. One set aside is withdrawn too, so it
    // cannot be restored beside the bank's corrected charge.
    if (removed.length > 0) {
      // One tied to a recurring cost lets go of it; the expense stays.
      summary.removed += await dropWithdrawn(
        tx,
        connectionId,
        removed.map((r) => r.transaction_id),
      );
      const gone = await tx
        .update(bankTransaction)
        .set({ state: "removed" })
        .where(
          and(
            eq(bankTransaction.connectionId, connectionId),
            inArray(bankTransaction.state, ["to_sort", "dismissed"]),
            inArray(
              bankTransaction.plaidTransactionId,
              removed.map((r) => r.transaction_id),
            ),
          ),
        )
        .returning({ id: bankTransaction.id });
      summary.removed += gone.length;
    }

    await tx
      .update(bankConnection)
      .set({ cursor: read.next, lastSyncedAt: now, status: "ok" })
      .where(eq(bankConnection.id, connectionId));
    if (connection.status === "needs_relink") {
      await writeAudit(tx, {
        householdId: connection.householdId,
        actor: { kind: "system" },
        action: "bank_connection.reconnected",
        entity: { type: "bank_connection", id: connectionId },
        detail: {},
      });
    }
  });
  return summary;
}

// Adds a purchase from an account that shares everything, as its owner
// paid it, split by the rules of its date. False when it cannot be added
// (dated after today, or its owner was not in the group then): it then waits
// to be sorted like any other.
async function autoAdd(tx: Db, owner: Member, row: BankTransaction, today: string, now: Date): Promise<boolean> {
  let expenseId: string;
  try {
    const created = await createExpense(tx, row.householdId, {
      kind: "bank",
      actor: owner,
      auto: true,
      date: row.date,
      description: row.description,
      totalCents: row.amountCents,
      payerId: owner.id,
      accountId: row.accountId,
      today,
      seed: row.plaidTransactionId,
    });
    expenseId = created.id;
  } catch (e) {
    if (e instanceof UserError) return false;
    throw e;
  }
  await tx.update(bankTransaction).set({ state: "added", expenseId, sortedAt: now }).where(eq(bankTransaction.id, row.id));
  await writeAudit(tx, {
    householdId: row.householdId,
    actor: { kind: "system" },
    action: "bank_transaction.added",
    entity: { type: "bank_transaction", id: row.id },
    detail: { expenseId, auto: true },
  });
  return true;
}

export type SyncAllSummary = { synced: number; needsRelink: number; superseded: number; failed: number };

// Every live connection, one after another. One that fails is counted and
// the rest still run.
export async function syncAllConnections(db: Db, bank: BankDeps, now: Date): Promise<SyncAllSummary> {
  const counts: SyncAllSummary = { synced: 0, needsRelink: 0, superseded: 0, failed: 0 };
  const live = await db.select({ id: bankConnection.id }).from(bankConnection).where(isNull(bankConnection.removedAt)).orderBy(asc(bankConnection.createdAt));
  for (const { id } of live) {
    try {
      const { outcome } = await syncConnection(db, bank, id, now);
      if (outcome === "ok") counts.synced++;
      else if (outcome === "needs_relink") counts.needsRelink++;
      else counts.superseded++;
    } catch (e) {
      counts.failed++;
      // Which connection and Plaid's code only: never the token or an account.
      console.error(`bank: sync of connection ${id} failed: ${isPlaidError(e) ? e.code : e instanceof Error ? e.name : "error"}`);
    }
  }
  return counts;
}

// ---- Sorting ----------------------------------------------------------------

export type ToSort = BankTransaction & { accountName: string; lastFour: string | null; institutionName: string };

// What is waiting for `actor` to sort: only from connections they made.
export async function listToSort(db: Db, actor: Member): Promise<ToSort[]> {
  const rows = await db
    .select({ t: bankTransaction, accountName: account.name, lastFour: account.lastFour, institutionName: bankConnection.institutionName })
    .from(bankTransaction)
    .innerJoin(bankConnection, eq(bankConnection.id, bankTransaction.connectionId))
    .innerJoin(account, eq(account.id, bankTransaction.accountId))
    .where(
      and(
        eq(bankTransaction.householdId, actor.householdId),
        eq(bankConnection.householdId, actor.householdId),
        eq(bankConnection.ownerId, actor.id),
        eq(bankTransaction.state, "to_sort"),
      ),
    )
    .orderBy(desc(bankTransaction.date), asc(bankTransaction.plaidTransactionId));
  return rows.map((r) => ({ ...r.t, accountName: r.accountName, lastFour: r.lastFour, institutionName: r.institutionName }));
}

// Locks one of the actor's own transactions for the rest of `tx`, so a
// second tap waits and then finds it already sorted. Another member's or
// another group's reads as not found.
export const NEEDS_KIND = "first say whether this account is personal or business";

async function lockOwn(tx: Db, actor: Member, id: string) {
  const notYours = new UserError("that transaction is not one of yours to sort");
  if (!isUuid(id)) throw notYours;
  const [row] = await tx
    .select({ t: bankTransaction, removedAt: bankConnection.removedAt, accountKind: account.kind, groupKind: household.kind })
    .from(bankTransaction)
    .innerJoin(bankConnection, eq(bankConnection.id, bankTransaction.connectionId))
    .innerJoin(account, eq(account.id, bankTransaction.accountId))
    .innerJoin(household, eq(household.id, bankTransaction.householdId))
    .where(and(eq(bankTransaction.id, id), eq(bankTransaction.householdId, actor.householdId), eq(bankConnection.ownerId, actor.id)))
    .for("update", { of: bankTransaction });
  if (!row) throw notYours;
  return row;
}

// Adds a purchase waiting to be sorted as an expense its owner paid, split
// by the rules of its date. Money in cannot be added, only set aside.
export async function addFromBank(
  db: Db,
  actor: Member,
  id: string,
  { category, description: text }: { category?: string; description?: string },
  today: string,
) {
  return db.transaction(async (tx) => {
    const { t: row, groupKind, accountKind } = await lockOwn(tx, actor, id);
    if (row.state !== "to_sort") throw new UserError("that transaction has already been sorted");
    if (groupKind === "business" && !accountKind) throw new UserError(NEEDS_KIND);
    if (row.amountCents <= 0) throw new UserError("money coming in can only be set aside");
    const created = await createExpense(tx, actor.householdId, {
      kind: "bank",
      actor,
      auto: false,
      date: row.date,
      description: text?.trim() || row.description,
      category,
      totalCents: row.amountCents,
      payerId: actor.id,
      accountId: row.accountId,
      today,
      seed: row.plaidTransactionId,
    });
    await tx
      .update(bankTransaction)
      .set({ state: "added", expenseId: created.id, sortedBy: actor.id, sortedAt: new Date() })
      .where(eq(bankTransaction.id, row.id));
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "bank_transaction.added",
      entity: { type: "bank_transaction", id: row.id },
      detail: { expenseId: created.id },
    });
    return created;
  });
}

async function move(db: Db, actor: Member, id: string, from: "to_sort" | "dismissed", to: "dismissed" | "to_sort") {
  return db.transaction(async (tx) => {
    const { t: row, removedAt } = await lockOwn(tx, actor, id);
    if (to === "to_sort" && removedAt) throw new UserError("that bank is no longer connected");
    if (row.state !== from) throw new UserError(from === "to_sort" ? "that transaction has already been sorted" : "that transaction was not set aside");
    const [moved] = await tx
      .update(bankTransaction)
      .set(to === "dismissed" ? { state: to, sortedBy: actor.id, sortedAt: new Date() } : { state: to, sortedBy: null, sortedAt: null })
      .where(and(eq(bankTransaction.id, row.id), eq(bankTransaction.state, from)))
      .returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: to === "dismissed" ? "bank_transaction.dismissed" : "bank_transaction.restored",
      entity: { type: "bank_transaction", id: row.id },
      detail: {},
    });
    return moved!;
  });
}

export type BillSuggestion = { expenseId: string; name: string; date: string };

// For each purchase of `actor`'s waiting to be sorted, the bills of theirs
// still waiting for an amount that it might be: dated within BILL_DAYS of it,
// closest first, at most three. Only offered, never applied.
export async function billSuggestions(db: Db, actor: Member, waiting: Pick<BankTransaction, "id" | "date" | "amountCents">[]): Promise<Map<string, BillSuggestion[]>> {
  const out = new Map<string, BillSuggestion[]>();
  const spent = waiting.filter((t) => t.amountCents > 0);
  if (spent.length === 0) return out;
  const bills = await db
    .select({ id: expense.id, name: expense.description, date: expense.date })
    .from(expense)
    .where(
      and(
        eq(expense.householdId, actor.householdId),
        eq(expense.status, "needs_amount"),
        eq(expense.payerId, actor.id),
        sql`${expense.templateLineageId} is not null`,
      ),
    );
  const gap = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
  for (const t of spent) {
    const near = bills
      .filter((b) => b.date >= addDays(t.date, -BILL_DAYS) && b.date <= addDays(t.date, BILL_DAYS))
      .sort((a, b) => gap(a.date, t.date) - gap(b.date, t.date) || a.name.localeCompare(b.name))
      .slice(0, 3)
      .map((b) => ({ expenseId: b.id, name: b.name, date: b.date }));
    if (near.length > 0) out.set(t.id, near);
  }
  return out;
}

// "This is Electricity": the purchase waiting to be sorted is the amount of a
// bill of the actor's that was waiting for it. Sets the bill's amount as the
// "enter the amount" form does, ties the purchase to it, and marks it added.
export async function matchBill(db: Db, actor: Member, id: string, expenseId: string) {
  return db.transaction(async (tx) => {
    const { t: row } = await lockOwn(tx, actor, id);
    if (row.state !== "to_sort") throw new UserError("that transaction has already been sorted");
    if (row.amountCents <= 0) throw new UserError("money coming in cannot pay a bill");
    const notFit = new UserError("that bill is not waiting for an amount that this purchase could be");
    if (!isUuid(expenseId)) throw notFit;
    const [bill] = await tx
      .select()
      .from(expense)
      .where(and(eq(expense.id, expenseId), eq(expense.householdId, actor.householdId)))
      .for("update");
    if (
      !bill ||
      bill.status !== "needs_amount" ||
      bill.payerId !== actor.id ||
      !bill.templateLineageId ||
      bill.date < addDays(row.date, -BILL_DAYS) ||
      bill.date > addDays(row.date, BILL_DAYS)
    ) {
      throw notFit;
    }
    const updated = await enterAmount(tx, actor, bill.id, row.amountCents);
    const tied = await tieTransaction(tx, row, updated.id, new Date(), { kind: "member", memberId: actor.id }, { suggested: true });
    if (!tied) throw new UserError("that bill already has a purchase tied to it");
    return updated;
  });
}

// "Not this purchase": a purchase tied to a recurring cost is not that cost's
// money after all. It goes back to the list to sort, the cost stays as it was,
// and the purchase is never tied automatically again.
export async function notThisPurchase(db: Db, actor: Member, id: string) {
  return db.transaction(async (tx) => {
    const { t: row, removedAt } = await lockOwn(tx, actor, id);
    const [tied] = row.expenseId
      ? await tx.select({ lineage: expense.templateLineageId }).from(expense).where(eq(expense.id, row.expenseId))
      : [];
    if (row.state !== "added" || !tied?.lineage) throw new UserError("that purchase is not matched to a recurring cost");
    await untie(tx, { t: row, ownerId: actor.id, removedAt }, { kind: "member", memberId: actor.id }, { why: "not this purchase" }, { noAutoTie: true });
  });
}

// Sets a transaction aside: not an expense, and no longer waiting.
export const dismissBankTransaction = (db: Db, actor: Member, id: string) => move(db, actor, id, "to_sort", "dismissed");

// Puts a transaction set aside back in the list to sort.
export const restoreBankTransaction = (db: Db, actor: Member, id: string) => move(db, actor, id, "dismissed", "to_sort");

// Whether every purchase on a connected account is added at once rather
// than waiting to be sorted. Only for the connection's owner, and only for
// transactions synced from now on.
export async function setShareAll(db: Db, actor: Member, accountId: string, on: boolean): Promise<Account> {
  return db.transaction(async (tx) => {
    const notYours = new UserError("only the person who connected that bank can change this");
    if (!isUuid(accountId)) throw notYours;
    const [row] = await tx
      .select({ a: account, removedAt: bankConnection.removedAt, groupKind: household.kind })
      .from(account)
      .innerJoin(bankConnection, eq(bankConnection.id, account.bankConnectionId))
      .innerJoin(household, eq(household.id, account.householdId))
      .where(and(eq(account.id, accountId), eq(account.householdId, actor.householdId), eq(bankConnection.ownerId, actor.id)))
      .for("update", { of: account });
    if (!row) throw notYours;
    if (row.removedAt) throw new UserError("that bank is no longer connected");
    if (on && row.groupKind === "business" && !row.a.kind) throw new UserError(NEEDS_KIND);
    if (row.a.shareAll === on) return row.a;
    const [updated] = await tx.update(account).set({ shareAll: on }).where(eq(account.id, accountId)).returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "account.share_all_changed",
      entity: { type: "account", id: accountId },
      detail: { on },
    });
    return updated!;
  });
}

// ---- Disconnecting ----------------------------------------------------------

// Disconnects every live bank connection of a member whose access was just
// removed (membership.ts removeMember), so their card stops syncing into a
// list only they could open. Plaid is told when `bank` is configured; if it
// cannot be reached, or there is no bank, the connection is still stopped
// here (token blanked, nothing syncs) and the audit entry says Plaid was not
// told. Never throws for a Plaid failure.
export async function disconnectBanksOf(db: Db, bank: BankDeps | null, me: Member, owner: Member): Promise<void> {
  const live = await db
    .select({ id: bankConnection.id })
    .from(bankConnection)
    .where(and(eq(bankConnection.ownerId, owner.id), eq(bankConnection.householdId, me.householdId), isNull(bankConnection.removedAt)));
  for (const { id } of live) {
    if (bank) {
      try {
        await removeBankConnection(db, bank, owner, id);
        continue;
      } catch (e) {
        console.error(`bank: could not tell Plaid about connection ${id}; stopping it here only: ${errorLabel(e)}`);
      }
    }
    await db.transaction(async (tx) => {
      const now = new Date();
      const done = await tx
        .update(bankConnection)
        .set({ accessToken: null, removedAt: now })
        .where(and(eq(bankConnection.id, id), isNull(bankConnection.removedAt)))
        .returning({ id: bankConnection.id });
      if (done.length === 0) return;
      await tx
        .update(bankTransaction)
        .set({ state: "dismissed", sortedBy: me.id, sortedAt: now })
        .where(and(eq(bankTransaction.connectionId, id), eq(bankTransaction.state, "to_sort")));
      await writeAudit(tx, {
        householdId: me.householdId,
        actor: { kind: "member", memberId: me.id },
        action: "bank_connection.removed",
        entity: { type: "bank_connection", id },
        detail: { plaid: "not told: the member's access was removed and Plaid could not be reached or is not set up" },
      });
    });
  }
}

// Tells Plaid to forget the login, then blanks the stored token. The
// accounts stay, as ordinary accounts that still point back at the
// connection; what was waiting to be sorted is set aside.
export async function removeBankConnection(db: Db, bank: BankDeps, actor: Member, connectionId: string): Promise<void> {
  const notYours = new UserError("only the person who connected that bank can disconnect it");
  if (!isUuid(connectionId)) throw notYours;
  const [connection] = await db
    .select()
    .from(bankConnection)
    .where(and(eq(bankConnection.id, connectionId), eq(bankConnection.householdId, actor.householdId), eq(bankConnection.ownerId, actor.id)));
  if (!connection) throw notYours;
  if (connection.removedAt || !connection.accessToken) throw new UserError("that bank is already disconnected");
  // A token that cannot be opened (the key was changed) cannot be handed to
  // Plaid either: remove it here, and say so.
  let token: string | null = null;
  try {
    token = openSecret(connection.accessToken, bank.key);
  } catch {
    token = null;
  }
  if (!token) {
    console.error(`bank: connection ${connectionId} removed here only; its stored token could not be opened, so Plaid was not told`);
  } else {
    try {
      await bank.plaid.removeItem(token);
    } catch (e) {
      // Already gone at Plaid's end: finish here.
      if (!isPlaidError(e, "ITEM_NOT_FOUND") && !isPlaidError(e, "INVALID_ACCESS_TOKEN")) throw e;
      console.error(`bank: connection ${connectionId} was already gone at Plaid: ${errorLabel(e)}`);
    }
  }
  await db.transaction(async (tx) => {
    const now = new Date();
    const done = await tx
      .update(bankConnection)
      .set({ accessToken: null, removedAt: now })
      .where(and(eq(bankConnection.id, connectionId), isNull(bankConnection.removedAt)))
      .returning({ id: bankConnection.id });
    if (done.length === 0) throw new UserError("that bank is already disconnected");
    await tx
      .update(bankTransaction)
      .set({ state: "dismissed", sortedBy: actor.id, sortedAt: now })
      .where(and(eq(bankTransaction.connectionId, connectionId), eq(bankTransaction.state, "to_sort")));
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "bank_connection.removed",
      entity: { type: "bank_connection", id: connectionId },
      detail: token ? {} : { plaid: "not told: the stored token could not be opened with the current key" },
    });
  });
}

