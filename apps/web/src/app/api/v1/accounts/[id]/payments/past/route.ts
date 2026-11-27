import { idParam, route } from "@/lib/api";
import { findPastPayments } from "@/lib/card-review";
import { bank, nowFor, ownCard } from "../../../_card/helpers";

export const dynamic = "force-dynamic";

// A shared card's payments of the last 90 days that are not shared yet, read
// from Plaid now.
export const GET = route<{ id: string }>(async (ctx, req, { id }) => ({
  payments: await ownCard(findPastPayments(ctx.db, bank(), ctx.me, idParam(id, "card"), nowFor(ctx, req))),
}));
