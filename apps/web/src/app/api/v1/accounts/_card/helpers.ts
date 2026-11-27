// Shared by the card routes under /api/v1/accounts.
import { UserError } from "@abacus/core/errors";
import { isIsoDate } from "@abacus/core/dates";
import { ApiError, expenseJson, type ApiContext } from "@/lib/api";
import { requireBank, bankRuntime } from "@/lib/bank-link";
import { getExpense } from "@/lib/expenses";
import type { Expense } from "@/db/schema";

// Another member's card, or one that does not exist, reads as not found. Any
// other refusal ("that bank is no longer connected") stays a 400 with its words.
export async function ownCard<T>(lookup: Promise<T>): Promise<T> {
  try {
    return await lookup;
  } catch (e) {
    if (e instanceof UserError && e.message === "that card is not one of yours") throw new ApiError(404, "there is no such card");
    throw e;
  }
}

// Plaid, or a refusal in words when this server has no Plaid keys.
export const bank = () => requireBank(bankRuntime());

// With the sign-in stand-in on, `x-abacus-today` sets the date; the lib reads
// the date from an instant, so noon UTC of that day stands for it.
export const nowFor = (ctx: ApiContext, req: Request): Date => {
  const pretend = req.headers.get("x-abacus-today");
  return pretend && pretend === ctx.today && isIsoDate(pretend) ? new Date(`${pretend}T12:00:00Z`) : new Date();
};

export function reviewQuery(req: Request): { payment?: string; from?: string } {
  const q = new URL(req.url).searchParams;
  const out: { payment?: string; from?: string } = {};
  const payment = q.get("payment");
  const from = q.get("from");
  if (payment) out.payment = payment;
  if (from) out.from = reviewFrom(from);
  return out;
}

export function reviewFrom(from: string): string {
  if (!isIsoDate(from)) throw new UserError("from must be a date like 2026-01-31");
  return from;
}

export const expenseOut = async (ctx: ApiContext, e: Expense) => expenseJson(await getExpense(ctx.db, ctx.home.id, e.id));
