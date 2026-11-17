// Ties a card purchase to a recurring cost the group already has, so the
// same money is not counted twice. A tied transaction is `added` and points
// at the recurring cost's own expense; no second expense is made.
//
// A tie is told from an expense a purchase created by the expense's
// recurring cost: `template_lineage_id` is set, and it stays set when the
// expense is edited. Nothing here changes an expense.
import { and, asc, desc, eq, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { addDays } from "@abacus/core/dates";
import { bankConnection, bankTransaction, expense, type BankTransaction, type Expense, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit, type Actor } from "./audit.ts";

// How far apart a purchase and a recurring expense of the same amount may be
// dated, either way, to count as the same money.
export const MATCH_DAYS = 4;
// How far a bill still waiting for its amount may be from a purchase for the
// purchase to be offered for it.
export const BILL_DAYS = 10;

const LIVE = ["posted", "unassigned", "needs_amount"] as const;

// Not tied to a purchase already.
const untied = () =>
  notExists(
    sql`(select 1 from ${bankTransaction} where ${bankTransaction.expenseId} = ${expense.id} and ${bankTransaction.state} = 'added')`,
  );

const inWindow = (column: typeof expense.date | typeof bankTransaction.date, date: string) =>
  sql`${column} between ${addDays(date, -MATCH_DAYS)} and ${addDays(date, MATCH_DAYS)}`;

// A recurring expense that names an account fits only a purchase on it.
const sameAccount = (accountId: string) => sql`(${expense.accountId} is null or ${expense.accountId} = ${accountId})`;

// Live recurring expenses that could be this purchase: same group, same
// total, paid by the connection's owner, dated within MATCH_DAYS, on the same
// account when the expense names one, and not tied. Locked, so a void or an
// edit committing at the same moment is seen.
async function fittingExpenses(tx: Db, ownerId: string, t: BankTransaction): Promise<Expense[]> {
  return tx
    .select()
    .from(expense)
    .where(
      and(
        eq(expense.householdId, t.householdId),
        inArray(expense.status, [...LIVE]),
        isNotNull(expense.templateLineageId),
        eq(expense.totalCents, t.amountCents),
        eq(expense.payerId, ownerId),
        inWindow(expense.date, t.date),
        sameAccount(t.accountId),
        untied(),
      ),
    )
    .for("update", { of: expense });
}

// Purchases waiting to be sorted that could be this expense: the same rule
// from the other side, and only from connections its payer owns. One set
// aside from automatic matching is never offered.
async function fittingPurchases(tx: Db, e: Expense): Promise<BankTransaction[]> {
  const rows = await tx
    .select({ t: bankTransaction })
    .from(bankTransaction)
    .innerJoin(bankConnection, eq(bankConnection.id, bankTransaction.connectionId))
    .where(
      and(
        eq(bankTransaction.householdId, e.householdId),
        eq(bankTransaction.state, "to_sort"),
        eq(bankTransaction.noAutoTie, false),
        eq(bankTransaction.amountCents, e.totalCents!),
        eq(bankConnection.ownerId, e.payerId),
        isNull(bankConnection.removedAt),
        inWindow(bankTransaction.date, e.date),
        e.accountId ? eq(bankTransaction.accountId, e.accountId) : sql`true`,
      ),
    );
  return rows.map((r) => r.t);
}

function isUniqueViolation(e: unknown): boolean {
  for (let at = e as { code?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) {
    if (at.code === "23505") return true;
  }
  return false;
}

// Ties the purchase to the expense. False when nothing changed: it was no
// longer waiting, or the expense was tied to another purchase first (the
// unique index), in which case the purchase stays as it was.
export async function tieTransaction(tx: Db, t: BankTransaction, expenseId: string, now: Date, by: Actor, detail: Record<string, unknown>): Promise<boolean> {
  try {
    return await tx.transaction(async (sp) => {
      const changed = await sp
        .update(bankTransaction)
        .set({ state: "added", expenseId, sortedBy: by.kind === "member" ? by.memberId : null, sortedAt: now })
        .where(and(eq(bankTransaction.id, t.id), eq(bankTransaction.state, "to_sort")))
        .returning({ id: bankTransaction.id });
      if (changed.length === 0) return false;
      await writeAudit(sp, {
        householdId: t.householdId,
        actor: by,
        action: "bank_transaction.tied",
        entity: { type: "bank_transaction", id: t.id },
        detail: { expenseId, ...detail },
      });
      return true;
    });
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

// Ties a waiting purchase to the recurring expense it is, when it is not a
// guess: exactly one expense fits the purchase, and exactly one waiting
// purchase fits that expense. Both ways round, so two same-amount purchases
// tie to nothing. Run once a sync's purchases are all stored.
export async function tryTie(tx: Db, t: BankTransaction, now: Date): Promise<boolean> {
  if (t.amountCents <= 0 || t.noAutoTie || t.state !== "to_sort") return false;
  const [connection] = await tx.select({ ownerId: bankConnection.ownerId }).from(bankConnection).where(eq(bankConnection.id, t.connectionId));
  if (!connection) return false;
  const expenses = await fittingExpenses(tx, connection.ownerId, t);
  if (expenses.length !== 1) return false;
  const purchases = await fittingPurchases(tx, expenses[0]!);
  if (purchases.length !== 1 || purchases[0]!.id !== t.id) return false;
  return tieTransaction(tx, t, expenses[0]!.id, now, { kind: "system" }, {});
}

// A recurring cost was just posted: the same rule from its side. A purchase
// that was already added as an expense of its own is left alone.
export async function tieWaitingPurchase(tx: Db, e: Expense, now: Date): Promise<boolean> {
  if (e.totalCents === null || !e.templateLineageId || !(LIVE as readonly string[]).includes(e.status)) return false;
  const purchases = await fittingPurchases(tx, e);
  if (purchases.length !== 1) return false;
  return tryTie(tx, purchases[0]!, now);
}

type Tied = { t: BankTransaction; ownerId: string; removedAt: Date | null };

// The tie `expenseId` is in, if any, and only when it is to a recurring cost.
async function tiedTo(tx: Db, expenseId: string): Promise<Tied | undefined> {
  const [row] = await tx
    .select({ t: bankTransaction, ownerId: bankConnection.ownerId, removedAt: bankConnection.removedAt })
    .from(bankTransaction)
    .innerJoin(bankConnection, eq(bankConnection.id, bankTransaction.connectionId))
    .innerJoin(expense, eq(expense.id, bankTransaction.expenseId))
    .where(and(eq(bankTransaction.expenseId, expenseId), eq(bankTransaction.state, "added"), isNotNull(expense.templateLineageId)))
    .for("update", { of: bankTransaction });
  return row;
}

// Lets go of a tie: the purchase is its own money again and goes back to the
// list to sort (set aside, if its bank is no longer connected). Never sorted
// by whoever caused it: the owner's list is the owner's.
export async function untie(tx: Db, row: Tied, by: Actor, detail: Record<string, unknown>, set: { noAutoTie?: boolean } = {}): Promise<void> {
  const state = row.removedAt ? "dismissed" : "to_sort";
  await tx
    .update(bankTransaction)
    .set({ state, expenseId: null, sortedBy: state === "dismissed" ? row.ownerId : null, sortedAt: state === "dismissed" ? new Date() : null, ...set })
    .where(eq(bankTransaction.id, row.t.id));
  await writeAudit(tx, {
    householdId: row.t.householdId,
    actor: by,
    action: "bank_transaction.untied",
    entity: { type: "bank_transaction", id: row.t.id },
    detail: { expenseId: row.t.expenseId, ...detail, now: state },
  });
}

// A tied recurring expense was voided.
export async function releaseTie(tx: Db, e: Expense, by: Member): Promise<void> {
  const row = await tiedTo(tx, e.id);
  if (row) await untie(tx, row, { kind: "member", memberId: by.id }, { why: "voided" });
}

// A tied expense was edited. A recurring expense whose payer or total changed
// is no longer the money the purchase paid, so the tie is dropped; any other
// edit, and an expense a purchase made, keeps the purchase with the new version.
export async function followEdit(tx: Db, old: Expense, next: Expense, by: Member): Promise<void> {
  const row = await tiedTo(tx, old.id);
  // A purchase's own expense is not a tie by this module's definition.
  if (!row) {
    const moved = await tx
      .update(bankTransaction)
      .set({ expenseId: next.id })
      .where(and(eq(bankTransaction.expenseId, old.id), eq(bankTransaction.state, "added"), eq(bankTransaction.householdId, next.householdId)))
      .returning({ id: bankTransaction.id });
    for (const m of moved) {
      await writeAudit(tx, {
        householdId: next.householdId,
        actor: { kind: "member", memberId: by.id },
        action: "bank_transaction.retied",
        entity: { type: "bank_transaction", id: m.id },
        detail: { from: old.id, expenseId: next.id },
      });
    }
    return;
  }
  const actor: Actor = { kind: "member", memberId: by.id };
  if (old.payerId !== next.payerId || old.totalCents !== next.totalCents) {
    await untie(tx, row, actor, { why: "edited" });
    return;
  }
  await tx.update(bankTransaction).set({ expenseId: next.id }).where(eq(bankTransaction.id, row.t.id));
  await writeAudit(tx, {
    householdId: next.householdId,
    actor,
    action: "bank_transaction.retied",
    entity: { type: "bank_transaction", id: row.t.id },
    detail: { from: old.id, expenseId: next.id },
  });
}

// The bank withdrew purchases. Those tied to a recurring expense are dropped
// from it and marked removed; the expense is not touched. Returns how many.
export async function dropWithdrawn(tx: Db, connectionId: string, plaidIds: string[]): Promise<number> {
  if (plaidIds.length === 0) return 0;
  const tied = await tx
    .select({ t: bankTransaction })
    .from(bankTransaction)
    .innerJoin(expense, eq(expense.id, bankTransaction.expenseId))
    .where(
      and(
        eq(bankTransaction.connectionId, connectionId),
        eq(bankTransaction.state, "added"),
        isNotNull(expense.templateLineageId),
        inArray(bankTransaction.plaidTransactionId, plaidIds),
      ),
    );
  for (const { t } of tied) {
    await tx.update(bankTransaction).set({ state: "removed", expenseId: null }).where(eq(bankTransaction.id, t.id));
    await writeAudit(tx, {
      householdId: t.householdId,
      actor: { kind: "system" },
      action: "bank_transaction.untied",
      entity: { type: "bank_transaction", id: t.id },
      detail: { expenseId: t.expenseId, why: "withdrawn by the bank", now: "removed" },
    });
  }
  return tied.length;
}

export type TieLine = { transactionId: string; date: string; description: string; amountCents: number; expenseId: string; costName: string };

// The ties the connection's owner may read: purchases dated in the last
// `days` days that were tied to a recurring expense. Nobody else gets a row.
export async function listTies(tx: Db, owner: Member, today: string, days: number | null = 30, only?: string): Promise<TieLine[]> {
  return tx
    .select({
      transactionId: bankTransaction.id,
      date: bankTransaction.date,
      description: bankTransaction.description,
      amountCents: bankTransaction.amountCents,
      expenseId: expense.id,
      costName: expense.description,
    })
    .from(bankTransaction)
    .innerJoin(bankConnection, eq(bankConnection.id, bankTransaction.connectionId))
    .innerJoin(expense, eq(expense.id, bankTransaction.expenseId))
    .where(
      and(
        eq(bankTransaction.householdId, owner.householdId),
        eq(bankTransaction.state, "added"),
        eq(bankConnection.ownerId, owner.id),
        isNotNull(expense.templateLineageId),
        days === null ? sql`true` : sql`${bankTransaction.date} >= ${addDays(today, -days)}`,
        only ? eq(expense.id, only) : sql`true`,
      ),
    )
    .orderBy(desc(bankTransaction.date), asc(bankTransaction.plaidTransactionId));
}

// What the owner reads on an expense page: the purchase it is tied to.
export async function tieFor(tx: Db, owner: Member, expenseId: string): Promise<{ transactionId: string; date: string; description: string } | null> {
  const [row] = await listTies(tx, owner, "", null, expenseId);
  return row ?? null;
}
