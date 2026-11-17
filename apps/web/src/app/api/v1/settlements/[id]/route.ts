import { cents, date, idParam, jsonBody, memberId, route, settlementJson, str } from "@/lib/api";
import { editSettlement } from "@/lib/balance";

export const dynamic = "force-dynamic";

// Edit a payment: the old row is voided and the answer is the new one, which
// points back at it. Saved with nothing changed, the answer is the old row.
export const PUT = route<{ id: string }>(async ({ me, db, members, today }, req, { id }) => {
  const b = await jsonBody(req);
  const row = await editSettlement(
    db,
    me,
    idParam(id, "payment"),
    {
      fromMemberId: memberId(b, "fromMemberId", members),
      toMemberId: memberId(b, "toMemberId", members),
      amountCents: cents(b, "amountCents"),
      date: date(b, "date"),
      note: str(b, "note", true),
    },
    today,
  );
  return settlementJson(row);
});
