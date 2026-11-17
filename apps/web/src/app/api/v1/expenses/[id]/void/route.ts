import { expenseJson, idParam, route } from "@/lib/api";
import { getExpense, voidExpense } from "@/lib/expenses";

export const dynamic = "force-dynamic";

// Voided, not deleted: the expense stays in the history and leaves the balance.
export const POST = route<{ id: string }>(async ({ me, db, home }, _req, { id }) => {
  await voidExpense(db, me, idParam(id, "expense"));
  return expenseJson(await getExpense(db, home.id, id));
});
