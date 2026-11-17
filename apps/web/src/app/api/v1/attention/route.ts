import { expenseJson, route } from "@/lib/api";
import { listAttention } from "@/lib/attention";
import { postDue } from "@/lib/expenses";

export const dynamic = "force-dynamic";

export const GET = route(async ({ db, home, today }) => {
  await postDue(db, home.id, today);
  const a = await listAttention(db, home.id, today);
  return {
    needsAmount: a.needsAmount.map(expenseJson),
    unassigned: a.unassigned.map(expenseJson),
    onDefault: a.onDefault,
    count: a.count,
  };
});
