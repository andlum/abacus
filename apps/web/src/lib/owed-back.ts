// What a business owes the people who paid its costs on a personal account,
// and the repayments that bring it down. Derived from counted expenses and
// recorded repayments every time it is asked for; never stored. Only a
// business group has it: in a household, costs are shared between members
// and the balance (balance.ts) is the whole story.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { account, expense, household, reimbursement, type Member, type Reimbursement } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";
import { toAccountId } from "./accounts.ts";
import { householdMembers, requireHouseholdMember } from "./members.ts";
import { checkText } from "./text.ts";
import { isIsoDate } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { isUuid } from "./ids.ts";

export const MAX_REIMBURSEMENT_NOTE = 200;

export type OwedBackEntry = {
  memberId: string;
  // Costs with an amount (posted, or could not be split) this member paid on
  // a personal account.
  personalPaidCents: number;
  // Repayments recorded to them and not voided.
  repaidCents: number;
  // The first less the second. Negative: they were repaid more than they paid.
  owedCents: number;
};

export type OwedBack = {
  // Every member of the group, in a stable order.
  members: OwedBackEntry[];
  // Costs with an amount and no account: whose money paid them is unknown,
  // so they are not counted.
  untaggedCount: number;
  untaggedCents: number;
};

async function isBusiness(db: Db, householdId: string): Promise<boolean> {
  const [row] = await db.select({ kind: household.kind }).from(household).where(eq(household.id, householdId));
  return row?.kind === "business";
}

// Null for a household group.
export async function getOwedBack(db: Db, householdId: string): Promise<OwedBack | null> {
  if (!(await isBusiness(db, householdId))) return null;
  const members = await householdMembers(db, householdId);
  // Expenses with an amount: posted ones, and unassigned ones, whose split
  // failed but whose total and payer stand. The member-to-member balance
  // leaves these out (balance.ts), so each is counted once. An account's kind
  // is read as it is now; it cannot change once an expense names the account.
  const counted = inArray(expense.status, ["posted", "unassigned"]);
  const paid = await db
    .select({ memberId: expense.payerId, cents: sql<string>`coalesce(sum(${expense.totalCents}), 0)` })
    .from(expense)
    .innerJoin(account, and(eq(account.householdId, expense.householdId), eq(account.id, expense.accountId)))
    .where(and(eq(expense.householdId, householdId), counted, eq(account.kind, "personal")))
    .groupBy(expense.payerId);
  const repaid = await db
    .select({ memberId: reimbursement.memberId, cents: sql<string>`coalesce(sum(${reimbursement.amountCents}), 0)` })
    .from(reimbursement)
    .where(and(eq(reimbursement.householdId, householdId), eq(reimbursement.status, "recorded")))
    .groupBy(reimbursement.memberId);
  const [untagged] = await db
    .select({ n: sql<string>`count(*)`, cents: sql<string>`coalesce(sum(${expense.totalCents}), 0)` })
    .from(expense)
    .where(and(eq(expense.householdId, householdId), counted, isNull(expense.accountId)));
  const paidBy = new Map(paid.map((r) => [r.memberId, Number(r.cents)]));
  const repaidTo = new Map(repaid.map((r) => [r.memberId, Number(r.cents)]));
  return {
    members: members.map((m) => {
      const personalPaidCents = paidBy.get(m.id) ?? 0;
      const repaidCents = repaidTo.get(m.id) ?? 0;
      return { memberId: m.id, personalPaidCents, repaidCents, owedCents: personalPaidCents - repaidCents };
    }),
    untaggedCount: Number(untagged?.n ?? 0),
    untaggedCents: Number(untagged?.cents ?? 0),
  };
}

export type ReimbursementInput = {
  memberId: string;
  amountCents: number;
  date: string;
  // The business account it was paid from; blank for none.
  accountId?: string | null;
  note?: string;
};

// Any member of a business can record the business paying a member back.
export async function recordReimbursement(db: Db, actor: Member, input: ReimbursementInput, today: string): Promise<Reimbursement> {
  if (!(await isBusiness(db, actor.householdId))) throw new UserError("repayments are only for a business");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new UserError("the amount must be more than zero");
  }
  if (!isIsoDate(input.date)) throw new UserError("the date is not a date");
  if (input.date > today) throw new UserError("a repayment cannot be dated later than today");
  const note = input.note ?? "";
  checkText("note", note, MAX_REIMBURSEMENT_NOTE);
  await requireHouseholdMember(db, actor.householdId, input.memberId, "the person repaid", input.date);
  return db.transaction(async (tx) => {
    // Locked until the save, so it cannot be archived in between.
    const accountId = await toAccountId(tx, actor.householdId, input.accountId);
    if (accountId) {
      const [paidFrom] = await tx.select({ kind: account.kind }).from(account)
        .where(and(eq(account.householdId, actor.householdId), eq(account.id, accountId)));
      if (paidFrom?.kind !== "business") throw new UserError("a repayment is paid from a business account");
    }
    const [row] = await tx
      .insert(reimbursement)
      .values({
        householdId: actor.householdId,
        memberId: input.memberId,
        amountCents: input.amountCents,
        date: input.date,
        note: note.trim(),
        accountId,
        createdBy: actor.id,
      })
      .returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "reimbursement.recorded",
      entity: { type: "reimbursement", id: row!.id },
      detail: { memberId: input.memberId, accountId },
    });
    return row!;
  });
}

// Another group's id, or one that is not an id, reads as unknown.
export async function voidReimbursement(db: Db, actor: Member, reimbursementId: string): Promise<void> {
  const missing = new UserError("that repayment does not exist or was already voided");
  if (!isUuid(reimbursementId)) throw missing;
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(reimbursement)
      .set({ status: "void", voidedAt: new Date(), voidedBy: actor.id })
      .where(
        and(
          eq(reimbursement.id, reimbursementId),
          eq(reimbursement.householdId, actor.householdId),
          eq(reimbursement.status, "recorded"),
        ),
      )
      .returning({ id: reimbursement.id });
    if (rows.length === 0) throw missing;
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "reimbursement.voided",
      entity: { type: "reimbursement", id: reimbursementId },
    });
  });
}

// Oldest first, voided ones included.
export async function listReimbursements(db: Db, householdId: string): Promise<Reimbursement[]> {
  return db
    .select()
    .from(reimbursement)
    .where(eq(reimbursement.householdId, householdId))
    .orderBy(asc(reimbursement.date), asc(reimbursement.createdAt));
}
