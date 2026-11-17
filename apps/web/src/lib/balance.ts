// Who owes whom. Derived from posted expenses and recorded settlements
// every time it is asked for; never stored. In a business, a cost paid from
// a personal account is left out: the business owes it back in full to the
// member who paid (owed-back.ts), so counting it here too would count it twice.
import { and, asc, eq, isNull, ne, or, type SQL } from "drizzle-orm";
import { account, expense, expenseShare, household, settlement, type Member, type Settlement } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";
import { isIsoDate } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { isUuid } from "./ids.ts";
import { householdMembers, requireHouseholdMember } from "./members.ts";


export type BalanceEntry = {
  kind: "expense" | "settlement";
  id: string;
  date: string;
  description: string;
  // What this entry does to each member's position. Sums to zero.
  effect: Record<string, number>;
};

export type Balance = {
  // Positive: the household owes this member. Negative: this member owes.
  net: Record<string, number>;
  // The payments that would bring everyone to zero.
  owes: { from: string; to: string; amountCents: number }[];
  entries: BalanceEntry[];
};

export async function getBalance(db: Db, householdId: string): Promise<Balance> {
  const members = await householdMembers(db, householdId);
  const net: Record<string, number> = Object.fromEntries(members.map((m) => [m.id, 0]));
  const entries: BalanceEntry[] = [];
  const [group] = await db.select({ kind: household.kind }).from(household).where(eq(household.id, householdId));

  const shares = await db
    .select({
      id: expense.id,
      date: expense.date,
      description: expense.description,
      payerId: expense.payerId,
      totalCents: expense.totalCents,
      memberId: expenseShare.memberId,
      shareCents: expenseShare.shareCents,
    })
    .from(expense)
    .innerJoin(expenseShare, eq(expenseShare.expenseId, expense.id))
    .leftJoin(account, and(eq(account.householdId, expense.householdId), eq(account.id, expense.accountId)))
    .where(
      and(
        eq(expense.householdId, householdId),
        eq(expense.status, "posted"),
        // The shares stay on the expense; they just do not count between members.
        group?.kind === "business" ? or(isNull(account.kind), ne(account.kind, "personal")) : undefined,
      ),
    )
    .orderBy(asc(expense.date), asc(expense.createdAt), asc(expense.id));
  const byExpense = new Map<string, BalanceEntry>();
  for (const s of shares) {
    let entry = byExpense.get(s.id);
    if (!entry) {
      entry = { kind: "expense", id: s.id, date: s.date, description: s.description, effect: { [s.payerId]: s.totalCents! } };
      byExpense.set(s.id, entry);
      entries.push(entry);
    }
    entry.effect[s.memberId] = (entry.effect[s.memberId] ?? 0) - s.shareCents;
  }

  const paid = await db
    .select()
    .from(settlement)
    .where(and(eq(settlement.householdId, householdId), eq(settlement.status, "recorded")));
  for (const p of paid) {
    entries.push({
      kind: "settlement",
      id: p.id,
      date: p.date,
      description: p.note,
      effect: { [p.fromMemberId]: p.amountCents, [p.toMemberId]: -p.amountCents },
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));
  for (const entry of entries) {
    for (const [memberId, cents] of Object.entries(entry.effect)) net[memberId] = (net[memberId] ?? 0) + cents;
  }

  const debtors = Object.entries(net)
    .filter(([, v]) => v < 0)
    .map(([id, v]) => ({ id, left: -v }));
  const creditors = Object.entries(net)
    .filter(([, v]) => v > 0)
    .map(([id, v]) => ({ id, left: v }));
  const owes: Balance["owes"] = [];
  for (const d of debtors) {
    for (const c of creditors) {
      const amountCents = Math.min(d.left, c.left);
      if (amountCents > 0) {
        owes.push({ from: d.id, to: c.id, amountCents });
        d.left -= amountCents;
        c.left -= amountCents;
      }
    }
  }
  return { net, owes, entries };
}

export type SettlementInput = {
  fromMemberId: string;
  toMemberId: string;
  amountCents: number;
  date: string;
  note?: string;
};

async function checkSettlement(db: Db, actor: Member, input: SettlementInput, today: string): Promise<void> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new UserError("the amount must be more than zero");
  }
  if (!isIsoDate(input.date)) throw new UserError("the date is not a date");
  if (input.date > today) throw new UserError("a payment cannot be dated later than today");
  if (input.fromMemberId === input.toMemberId) throw new UserError("a payment is between two different people");
  await requireHouseholdMember(db, actor.householdId, input.fromMemberId, "the person paying", input.date);
  await requireHouseholdMember(db, actor.householdId, input.toMemberId, "the person being paid", input.date);
}

// Either partner can record a payment between them.
export async function recordSettlement(db: Db, actor: Member, input: SettlementInput, today: string): Promise<Settlement> {
  await checkSettlement(db, actor, input, today);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(settlement)
      .values({
        householdId: actor.householdId,
        fromMemberId: input.fromMemberId,
        toMemberId: input.toMemberId,
        amountCents: input.amountCents,
        date: input.date,
        note: input.note?.trim() ?? "",
        createdBy: actor.id,
      })
      .returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "settlement.recorded",
      entity: { type: "settlement", id: row!.id },
    });
    return row!;
  });
}

// Another group's id, or one that is not an id, reads as unknown.
export async function voidSettlement(db: Db, actor: Member, settlementId: string): Promise<void> {
  const missing = new UserError("that payment does not exist or was already voided");
  if (!isUuid(settlementId)) throw missing;
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(settlement)
      .set({ status: "void", voidedAt: new Date(), voidedBy: actor.id })
      .where(
        and(
          eq(settlement.id, settlementId),
          eq(settlement.householdId, actor.householdId),
          eq(settlement.status, "recorded"),
        ),
      )
      .returning({ id: settlement.id });
    if (rows.length === 0) throw missing;
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "settlement.voided",
      entity: { type: "settlement", id: settlementId },
    });
  });
}

// An edit keeps history: the old row is voided and a new one points back at
// it, in one transaction. The old row is locked and re-read under the lock,
// so of two edits of the same payment only the first goes through.
export async function editSettlement(db: Db, actor: Member, settlementId: string, input: SettlementInput, today: string): Promise<Settlement> {
  const missing = new UserError("that payment does not exist");
  if (!isUuid(settlementId)) throw missing;
  await checkSettlement(db, actor, input, today);
  return db.transaction(async (tx) => {
    const [old] = await tx
      .select()
      .from(settlement)
      .where(and(eq(settlement.id, settlementId), eq(settlement.householdId, actor.householdId)))
      .for("update");
    if (!old) throw missing;
    if (old.status !== "recorded") throw new UserError("that payment was already replaced or voided; nothing was changed");
    // Saved with nothing changed: leave the payment and its history alone.
    const note = input.note?.trim() ?? "";
    if (
      old.fromMemberId === input.fromMemberId &&
      old.toMemberId === input.toMemberId &&
      old.amountCents === input.amountCents &&
      old.date === input.date &&
      old.note === note
    ) {
      return old;
    }
    await tx.update(settlement).set({ status: "void", voidedAt: new Date(), voidedBy: actor.id }).where(eq(settlement.id, old.id));
    const [row] = await tx
      .insert(settlement)
      .values({
        householdId: actor.householdId,
        fromMemberId: input.fromMemberId,
        toMemberId: input.toMemberId,
        amountCents: input.amountCents,
        date: input.date,
        note,
        supersedesId: old.id,
        createdBy: actor.id,
      })
      .returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "settlement.edited",
      entity: { type: "settlement", id: row!.id },
      detail: { supersedesId: old.id },
    });
    return row!;
  });
}

export type SettlementView = { row: Settlement; replaced: Settlement | null; replacedBy: Settlement | null };

// One payment of the group, with the one it replaced and the one that
// replaced it. Null for another group's id, or one that is not an id.
export async function getSettlement(db: Db, householdId: string, settlementId: string): Promise<SettlementView | null> {
  if (!isUuid(settlementId)) return null;
  const mine = (where: SQL) => db.select().from(settlement).where(and(eq(settlement.householdId, householdId), where));
  const [row] = await mine(eq(settlement.id, settlementId));
  if (!row) return null;
  const [replaced] = row.supersedesId ? await mine(eq(settlement.id, row.supersedesId)) : [];
  const [replacedBy] = await mine(eq(settlement.supersedesId, row.id));
  return { row, replaced: replaced ?? null, replacedBy: replacedBy ?? null };
}

export async function listSettlements(db: Db, householdId: string): Promise<Settlement[]> {
  return db
    .select()
    .from(settlement)
    .where(eq(settlement.householdId, householdId))
    .orderBy(asc(settlement.date), asc(settlement.createdAt));
}
