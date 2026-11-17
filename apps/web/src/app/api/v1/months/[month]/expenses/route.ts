import { isMonth } from "@abacus/core/dates";
import { ApiError, expenseJson, route } from "@/lib/api";
import { listMonth, postDue } from "@/lib/expenses";

export const dynamic = "force-dynamic";

// Every expense dated in the month, voided ones included.
export const GET = route<{ month: string }>(async ({ db, home, today }, _req, { month }) => {
  if (!isMonth(month)) throw new ApiError(404, "a month looks like 2026-01");
  await postDue(db, home.id, today);
  return { month, expenses: (await listMonth(db, home.id, month)).map(expenseJson) };
});
