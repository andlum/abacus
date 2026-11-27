import { idParam, jsonBody, route, str } from "@/lib/api";
import { paymentLine, sharePastPayment } from "@/lib/card-review";
import { bank, nowFor, ownCard } from "../../_card/helpers";

export const dynamic = "force-dynamic";

// Shares one earlier payment. It is read from Plaid again; the amount is never
// taken from the request.
export const POST = route<{ id: string }>(async (ctx, req, { id }) => {
  const b = await jsonBody(req);
  const p = await ownCard(sharePastPayment(ctx.db, bank(), ctx.me, idParam(id, "card"), str(b, "plaidTransactionId"), nowFor(ctx, req)));
  return paymentLine(ctx.db, p);
});
