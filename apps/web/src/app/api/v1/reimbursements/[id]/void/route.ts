import { and, eq } from "drizzle-orm";
import { reimbursement } from "@/db/schema";
import { idParam, reimbursementJson, route } from "@/lib/api";
import { voidReimbursement } from "@/lib/owed-back";

export const dynamic = "force-dynamic";

export const POST = route<{ id: string }>(async ({ me, db, home }, _req, { id }) => {
  await voidReimbursement(db, me, idParam(id, "repayment"));
  const [row] = await db
    .select()
    .from(reimbursement)
    .where(and(eq(reimbursement.id, id), eq(reimbursement.householdId, home.id)));
  return reimbursementJson(row!);
});
