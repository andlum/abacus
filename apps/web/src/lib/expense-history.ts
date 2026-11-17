// Every version of an expense: each edit keeps the old row as superseded
// and points the new row back at it, so the chain is followed both ways.
import { and, eq } from "drizzle-orm";
import { expense, type Expense } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { UserError } from "@abacus/core/errors";
import { isUuid } from "./ids.ts";
import { withShares, type ExpenseWithShares } from "./expenses.ts";

// Newest first.
export async function expenseHistory(db: Db, householdId: string, expenseId: string): Promise<ExpenseWithShares[]> {
  if (!isUuid(expenseId)) throw new UserError("that expense does not exist");
  const one = async (where: ReturnType<typeof eq>) =>
    (await db.select().from(expense).where(and(where, eq(expense.householdId, householdId))).limit(1))[0];

  const start = await one(eq(expense.id, expenseId));
  if (!start) throw new UserError("that expense does not exist");

  const chain: Expense[] = [start];
  // Older versions.
  for (let row = start; row.supersedesId; ) {
    const older = await one(eq(expense.id, row.supersedesId));
    if (!older) break;
    chain.push(older);
    row = older;
  }
  // Newer versions.
  for (let row = start; ; ) {
    const newer = await one(eq(expense.supersedesId, row.id));
    if (!newer) break;
    chain.unshift(newer);
    row = newer;
  }
  return withShares(db, chain);
}
