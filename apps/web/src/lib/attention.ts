import type { Db } from "../db/types.ts";
import { listByStatus, type ExpenseWithShares } from "./expenses.ts";
import { memberIdsOn } from "./members.ts";
import { loadContext, ruleOn } from "./split/resolve.ts";
import { listTemplates } from "./templates.ts";

export type Attention = {
  // Bills waiting for someone to enter the amount.
  needsAmount: ExpenseWithShares[];
  // Expenses whose shares could not be computed. Not in the balance.
  unassigned: ExpenseWithShares[];
  // Recurring costs still split by the built-in 50/50. For information.
  onDefault: { lineageId: string; name: string; category: string }[];
  // What needs someone to act: the first two lists.
  count: number;
};

export async function listAttention(db: Db, householdId: string, today: string): Promise<Attention> {
  const needsAmount = await listByStatus(db, householdId, "needs_amount");
  const unassigned = await listByStatus(db, householdId, "unassigned");
  const ctx = await loadContext(db, householdId);
  const onDefault: Attention["onDefault"] = [];
  for (const t of await listTemplates(db, householdId, today)) {
    // One person has nobody to split with, so no cost of theirs is "on the default".
    if (t.ended || memberIdsOn(ctx.members, today).length < 2) continue;
    const found = ruleOn(ctx, { templateLineageId: t.lineageId, category: t.head.category, date: today });
    if (found.source === "default") {
      onDefault.push({ lineageId: t.lineageId, name: t.head.name, category: t.head.category });
    }
  }
  return { needsAmount, unassigned, onDefault, count: needsAmount.length + unassigned.length };
}
