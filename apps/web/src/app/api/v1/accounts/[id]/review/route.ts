import { UserError } from "@abacus/core/errors";
import type { Rule } from "@abacus/core/split";
import { idParam, jsonBody, route, str, type Body } from "@/lib/api";
import { getReview, submitReview, type ReviewPick } from "@/lib/card-review";
import { bank, expenseOut, nowFor, ownCard, reviewFrom, reviewQuery } from "../../_card/helpers";

export const dynamic = "force-dynamic";

// The card's purchases for one payment or date range, read from Plaid now.
export const GET = route<{ id: string }>(async (ctx, req, { id }) =>
  ownCard(getReview(ctx.db, bank(), ctx.me, idParam(id, "card"), reviewQuery(req), nowFor(ctx, req))),
);

function pick(raw: unknown): ReviewPick {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UserError("each pick must be an object");
  const b = raw as Body;
  const out: ReviewPick = { plaidTransactionId: str(b, "plaidTransactionId") };
  const description = str(b, "description", true);
  const category = str(b, "category", true);
  const tieTo = str(b, "tieTo", true);
  if (description) out.description = description;
  if (category) out.category = category;
  if (tieTo) out.tieTo = tieTo;
  if (b.rule !== undefined && b.rule !== null) out.rule = b.rule as Rule;
  return out;
}

// Adds the picked purchases as the caller's expenses. Purchases are read from
// Plaid again; the amounts are never taken from the request.
export const POST = route<{ id: string }>(async (ctx, req, { id }) => {
  const b = await jsonBody(req);
  if (!Array.isArray(b.items)) throw new UserError("items must be a list of picks");
  const opts = { payment: str(b, "payment", true) || undefined, from: str(b, "from", true) || undefined, items: b.items.map(pick) };
  if (opts.from) reviewFrom(opts.from);
  const out = await ownCard(submitReview(ctx.db, bank(), ctx.me, idParam(id, "card"), opts, nowFor(ctx, req)));
  return {
    expenses: await Promise.all(out.expenses.map((e) => expenseOut(ctx, e))),
    paymentExpense: out.paymentExpense ? await expenseOut(ctx, out.paymentExpense) : null,
    from: out.from,
    to: out.to,
  };
});
