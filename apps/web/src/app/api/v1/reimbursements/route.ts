import { cents, created, date, jsonBody, memberId, reimbursementJson, route, str } from "@/lib/api";
import { listReimbursements, recordReimbursement } from "@/lib/owed-back";

export const dynamic = "force-dynamic";

// A business paying members back, oldest first, voided ones included.
export const GET = route(async ({ db, home }) => ({
  reimbursements: (await listReimbursements(db, home.id)).map(reimbursementJson),
}));

export const POST = route(async ({ me, db, members, today }, req) => {
  const b = await jsonBody(req);
  const row = await recordReimbursement(
    db,
    me,
    {
      memberId: memberId(b, "memberId", members),
      amountCents: cents(b, "amountCents"),
      date: date(b, "date", today),
      accountId: str(b, "accountId", true),
      note: str(b, "note", true),
    },
    today,
  );
  return created(reimbursementJson(row));
});
