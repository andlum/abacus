// Payments to connected cards (docs/specs/2026-11-27-card-review.md).
//
// A payment is recorded when the sync sees it. On a shared card it becomes
// an expense the card's owner paid, split the usual way; that expense holds
// what of the payment is still shared. A review takes purchases out of it
// (card-review.ts), so the expense is superseded by a smaller one, or voided
// when nothing is left; voiding a purchase taken out puts it back. The
// payment's own amount never changes.
import { and, eq, sql } from "drizzle-orm";
import { account, bankConnection, bankTransaction, cardPayment, expense, member, type Account, type BankTransaction, type CardPayment, type Expense, type GroupKind, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { accountLabel } from "./accounts.ts";
import { writeAudit, type Actor } from "./audit.ts";
import { createExpense, isLive } from "./expenses.ts";

export function paymentDescription(a: Pick<Account, "name" | "lastFour">): string {
  return `Card payment · ${accountLabel(a).replace(" ··", " ")}`;
}

async function memberById(tx: Db, id: string): Promise<Member> {
  const [m] = await tx.select().from(member).where(eq(member.id, id));
  return m!;
}

// Records a payment the sync found on a card. False when it was already
// recorded. On a household's shared card it also posts the payment's expense.
export async function recordPayment(
  tx: Db,
  a: Account,
  owner: Member,
  p: { plaidTransactionId: string; date: string; amountCents: number },
  today: string,
  groupKind: GroupKind,
): Promise<boolean> {
  // A business group's card payment is money moving between accounts, never
  // a cost: stored, and no expense, whatever `card_mode` says.
  const mode = groupKind === "business" ? "personal" : (a.cardMode ?? "personal");
  const [row] = await tx
    .insert(cardPayment)
    .values({ householdId: a.householdId, accountId: a.id, plaidTransactionId: p.plaidTransactionId, date: p.date, amountCents: p.amountCents, mode })
    .onConflictDoNothing({ target: cardPayment.plaidTransactionId })
    .returning();
  if (!row) return false;
  await writeAudit(tx, {
    householdId: a.householdId,
    actor: { kind: "system" },
    action: "card_payment.recorded",
    entity: { type: "card_payment", id: row.id },
    detail: { accountId: a.id, mode },
  });
  if (mode === "shared") await setStillShared(tx, row, row.amountCents, { a, owner, by: null, today });
  return true;
}

// Locks a payment, so two reviews or a review and a void take turns.
export async function lockPayment(tx: Db, householdId: string, id: string): Promise<CardPayment | undefined> {
  const [p] = await tx
    .select()
    .from(cardPayment)
    .where(and(eq(cardPayment.id, id), eq(cardPayment.householdId, householdId)))
    .for("update");
  return p;
}

// The live expense holding what a payment still shares, locked.
export async function lockShare(tx: Db, p: CardPayment): Promise<Expense | null> {
  if (!p.expenseId) return null;
  const [e] = await tx.select().from(expense).where(eq(expense.id, p.expenseId)).for("update");
  return e && isLive(e) ? e : null;
}

type ShareContext = {
  a: Pick<Account, "id" | "name" | "lastFour">;
  owner: Member;
  // Null when the sync does it, not a person.
  by: Member | null;
  today: string;
  // Said in the audit entry when the expense is voided.
  reason?: string;
};

// Sets what a locked shared payment still shares to `total`: supersedes its
// expense with the new total, voids it at zero, or posts a new one when it
// had none. Returns the expense that now holds it, or null.
export async function setStillShared(tx: Db, p: CardPayment, total: number, ctx: ShareContext): Promise<Expense | null> {
  const live = await lockShare(tx, p);
  const actor = ctx.by ?? ctx.owner;
  if (live && live.totalCents === total) return live;
  if (live && total === 0) {
    await tx.update(expense).set({ status: "void" }).where(eq(expense.id, live.id));
    await tx.update(cardPayment).set({ expenseId: null }).where(eq(cardPayment.id, p.id));
    await writeAudit(tx, {
      householdId: p.householdId,
      actor: ctx.by ? { kind: "member", memberId: ctx.by.id } : { kind: "system" },
      action: "expense.voided",
      entity: { type: "expense", id: live.id },
      detail: { was: live.status, ...(ctx.reason ? { reason: ctx.reason } : {}) },
    });
    return null;
  }
  if (total === 0) return null;
  const row = await createExpense(tx, p.householdId, {
    kind: "card_payment",
    actor,
    auto: !ctx.by,
    date: live?.date ?? p.date,
    description: live?.description ?? paymentDescription(ctx.a),
    totalCents: total,
    payerId: live?.payerId ?? ctx.owner.id,
    accountId: ctx.a.id,
    today: ctx.today > p.date ? ctx.today : p.date,
    seed: p.plaidTransactionId,
    rule: live?.chosenRule ?? undefined,
    replaces: live ?? undefined,
  });
  // createExpense moved the link when it replaced one (followPayment).
  if (!live) await tx.update(cardPayment).set({ expenseId: row.id }).where(eq(cardPayment.id, p.id));
  return row;
}

// An expense was superseded: a payment it held follows the new version.
export async function followPayment(tx: Db, old: Expense, next: Expense): Promise<void> {
  await tx.update(cardPayment).set({ expenseId: next.id }).where(and(eq(cardPayment.expenseId, old.id), eq(cardPayment.householdId, next.householdId)));
}

// An expense was voided. A payment it held now shares nothing; a purchase
// taken out of a payment goes back into it.
export async function dropPayment(tx: Db, voided: Expense, by: Member): Promise<void> {
  await tx.update(cardPayment).set({ expenseId: null }).where(and(eq(cardPayment.expenseId, voided.id), eq(cardPayment.householdId, voided.householdId)));
  const [t] = await tx
    .select()
    .from(bankTransaction)
    .where(and(eq(bankTransaction.expenseId, voided.id), eq(bankTransaction.state, "added"), sql`${bankTransaction.cardPaymentId} is not null`))
    .for("update");
  if (t) await putBack(tx, t, { kind: "member", memberId: by.id });
}

// A purchase taken out of a shared payment is no longer an expense of its
// own (voided, or let go of the cost it was tied to): its amount is shared
// in the payment again, and it can be picked in a later review. When the
// payment was voided because all of it was taken out, it is posted again;
// one a person voided stays voided.
export async function putBack(tx: Db, t: BankTransaction, by: Actor): Promise<void> {
  const p = (await lockPayment(tx, t.householdId, t.cardPaymentId!))!;
  const [a] = await tx.select().from(account).where(eq(account.id, p.accountId));
  const [taken] = await tx
    .select({ sum: sql<string>`coalesce(sum(${bankTransaction.amountCents}), 0)` })
    .from(bankTransaction)
    .where(and(eq(bankTransaction.cardPaymentId, p.id), eq(bankTransaction.state, "added")));
  await tx
    .update(bankTransaction)
    .set({ state: "dismissed", expenseId: null, cardPaymentId: null, sortedAt: new Date() })
    .where(eq(bankTransaction.id, t.id));
  await writeAudit(tx, {
    householdId: t.householdId,
    actor: by,
    action: "bank_transaction.put_back",
    entity: { type: "bank_transaction", id: t.id },
    detail: { expenseId: t.expenseId, cardPaymentId: p.id },
  });
  const live = await lockShare(tx, p);
  const allTaken = Number(taken!.sum) === p.amountCents;
  if (!live && !allTaken) return;
  const owner = await memberById(tx, (await ownerOf(tx, a!))!);
  const person = by.kind === "member" ? await memberById(tx, by.memberId) : null;
  await setStillShared(tx, p, (live?.totalCents ?? 0) + t.amountCents, { a: a!, owner, by: person, today: p.date });
}

async function ownerOf(tx: Db, a: Account): Promise<string | undefined> {
  const [c] = await tx.select({ ownerId: bankConnection.ownerId }).from(bankConnection).where(eq(bankConnection.id, a.bankConnectionId!));
  return c?.ownerId;
}
