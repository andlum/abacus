// Shared setup for tests: a household of two, and shortcuts for the
// multi-step flows most tests need before their own behaviour starts.
import { expense, income, member, type ChangeSet, type Expense, type Member } from "@/db/schema";
import { createTestDb, seedHousehold } from "@/db/test-db";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { recordIncome } from "../incomes";
import { addRule, type RuleInput } from "../rules";

export type World = { db: Db; householdId: string; alex: Member; sam: Member };

// Both have signed in unless `samJoined` is false, which leaves Sam as an
// invite nobody has taken up yet.
export async function createWorld({ samJoined = true } = {}): Promise<World> {
  const db = await createTestDb();
  const seeded = await seedHousehold(db);
  const join = async (m: Member) =>
    (await db.update(member).set({ linkedAt: new Date() }).where(eq(member.id, m.id)).returning())[0]!;
  const alex = await join(seeded.alex);
  const sam = samJoined ? await join(seeded.sam) : seeded.sam;
  return { db, householdId: seeded.household.id, alex, sam };
}

// Incomes and rules, saved by Alex (or Sam for Sam's own income once Sam
// has joined), each in force from `effectiveFrom`. Returns the rules saved.
export async function agree(
  w: World,
  effectiveFrom: string,
  items: { incomes?: { alex?: number; sam?: number }; rules?: RuleInput[] },
  today: string = effectiveFrom,
) {
  if (items.incomes?.alex !== undefined) {
    await recordIncome(w.db, w.alex, { annualCents: items.incomes.alex, effectiveFrom }, today);
  }
  if (items.incomes?.sam !== undefined) {
    const by = w.sam.linkedAt ? w.sam : w.alex;
    await recordIncome(w.db, by, { annualCents: items.incomes.sam, ownerId: w.sam.id, effectiveFrom }, today);
  }
  const rules = [];
  for (const r of items.rules ?? []) rules.push(await addRule(w.db, w.alex, { ...r, effectiveFrom }, today));
  return rules;
}

// Hides every income amount an owner has from the others, as an owner could
// before hiding went away. Nothing hides an amount any more, but rows hidden
// then stay hidden until their owner shows them.
export async function hideIncomes(w: World, owner: Member) {
  await w.db
    .update(income)
    .set({ shareMode: "ratio_only" })
    .where(and(eq(income.householdId, w.householdId), eq(income.ownerId, owner.id)));
}

// An income still waiting inside a change set, as one proposed before
// incomes counted at once left it. Nothing makes these any more.
export async function legacyIncome(w: World, set: ChangeSet, owner: Member, annualCents: number) {
  const [row] = await w.db
    .insert(income)
    .values({
      householdId: w.householdId,
      ownerId: owner.id,
      annualCents,
      shareMode: "amount",
      effectiveFrom: set.effectiveFrom,
      changeSetId: set.id,
      createdBy: owner.id,
    })
    .returning();
  return row!;
}

// An expense an agent proposed before agents could only read. Nothing writes
// these any more, but old rows stay, as `proposed` (never confirmed) or
// `rejected`, and must never count.
export async function legacyProposal(
  w: World,
  input: { date: string; description: string; totalCents: number },
  status: "proposed" | "rejected" = "proposed",
): Promise<Expense> {
  const [row] = await w.db
    .insert(expense)
    .values({ householdId: w.householdId, ...input, category: "other", payerId: w.alex.id, status, source: "agent", createdBy: w.alex.id })
    .returning();
  return row!;
}
