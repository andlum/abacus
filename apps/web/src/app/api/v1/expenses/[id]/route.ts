import { expenseJson, found, idParam, route } from "@/lib/api";
import { getExpense } from "@/lib/expenses";

export const dynamic = "force-dynamic";

export const GET = route<{ id: string }>(async ({ db, home }, _req, { id }) =>
  expenseJson(await found(getExpense(db, home.id, idParam(id, "expense")), "expense")),
);
