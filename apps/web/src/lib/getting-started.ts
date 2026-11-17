// The first steps a new household takes, each read from what is already in
// the database, so the list on Home ticks itself off.
import { and, eq, inArray } from "drizzle-orm";
import { auditLog, expenseTemplate, member, splitRule, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";

export type GettingStarted = {
  // Null in a group of one, where there is nobody to wait for and no split to
  // agree: such a group is started once it has a recurring cost.
  partner: string | null;
  // Signed in, or has done anything at all (dev sign-in never links).
  partnerJoined: boolean;
  hasRecurring: boolean;
  hasRule: boolean;
  done: boolean;
};

export async function gettingStarted(db: Db, me: Member): Promise<GettingStarted> {
  const householdId = me.householdId;
  const others = (await db.select().from(member).where(eq(member.householdId, householdId))).filter((m) => m.id !== me.id);

  const solo = others.length === 0;
  let partnerJoined = others.every((m) => m.linkedAt !== null);
  if (!partnerJoined) {
    const acted = await db
      .selectDistinct({ id: auditLog.actorMemberId })
      .from(auditLog)
      .where(and(eq(auditLog.householdId, householdId), inArray(auditLog.actorMemberId, others.map((m) => m.id))));
    partnerJoined = others.every((m) => m.linkedAt !== null || acted.some((a) => a.id === m.id));
  }

  const [template] = await db
    .select({ id: expenseTemplate.id })
    .from(expenseTemplate)
    .where(eq(expenseTemplate.householdId, householdId))
    .limit(1);
  const [rule] = await db
    .select({ id: splitRule.id })
    .from(splitRule)
    .where(and(eq(splitRule.householdId, householdId), eq(splitRule.status, "active")))
    .limit(1);

  const hasRecurring = template !== undefined;
  const hasRule = rule !== undefined;
  return {
    partner: others.map((m) => m.displayName).join(" and ") || null,
    partnerJoined,
    hasRecurring,
    hasRule,
    done: partnerJoined && hasRecurring && (solo || hasRule),
  };
}
