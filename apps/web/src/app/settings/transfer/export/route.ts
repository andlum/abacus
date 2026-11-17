import { isIsoDate } from "@abacus/core/dates";
import { requireHousehold } from "@/lib/session";
import { exportCsv } from "@/lib/transfer";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { me, db } = await requireHousehold();
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
    return new Response("Give a from date and a to date, with from on or before to.", { status: 400 });
  }
  return new Response(await exportCsv(db, me.householdId, from, to), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="abacus-expenses-${from}-to-${to}.csv"`,
      "cache-control": "no-store",
    },
  });
}
