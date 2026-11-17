import { cents, created, date, jsonBody, memberId, route, settlementJson, str } from "@/lib/api";
import { listSettlements, recordSettlement } from "@/lib/balance";

export const dynamic = "force-dynamic";

// Payments between members, oldest first, voided ones included.
export const GET = route(async ({ db, home }) => ({
  settlements: (await listSettlements(db, home.id)).map(settlementJson),
}));

export const POST = route(async ({ me, db, members, today }, req) => {
  const b = await jsonBody(req);
  const row = await recordSettlement(
    db,
    me,
    {
      fromMemberId: memberId(b, "fromMemberId", members),
      toMemberId: memberId(b, "toMemberId", members),
      amountCents: cents(b, "amountCents"),
      date: date(b, "date", today),
      note: str(b, "note", true),
    },
    today,
  );
  return created(settlementJson(row));
});
