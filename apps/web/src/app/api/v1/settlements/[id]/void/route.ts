import { and, eq } from "drizzle-orm";
import { settlement } from "@/db/schema";
import { idParam, route, settlementJson } from "@/lib/api";
import { voidSettlement } from "@/lib/balance";

export const dynamic = "force-dynamic";

export const POST = route<{ id: string }>(async ({ me, db, home }, _req, { id }) => {
  await voidSettlement(db, me, idParam(id, "payment"));
  const [row] = await db
    .select()
    .from(settlement)
    .where(and(eq(settlement.id, id), eq(settlement.householdId, home.id)));
  return settlementJson(row!);
});
