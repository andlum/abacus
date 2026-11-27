"use server";

import { attempt, field, type ActionState } from "@/lib/action";
import { bankRuntime, requireBank } from "@/lib/bank-link";
import { setCardMode, submitReview, type ReviewPick } from "@/lib/card-review";
import { previewSplit, type SplitPreview } from "@/lib/split-preview";
import { UserError } from "@abacus/core/errors";
import type { Rule } from "@abacus/core/split";
import { requireHousehold } from "@/lib/session";

// Shared or personal, for the card's payments from now on.
export async function setCardModeAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    requireBank(bankRuntime());
    const mode = field(form, "mode");
    if (mode !== "shared" && mode !== "personal") throw new UserError("choose shared or personal");
    await setCardMode(db, me, field(form, "accountId"), mode);
  });
}

export type ReviewInput = {
  accountId: string;
  payment?: string;
  from?: string;
  items: ReviewPick[];
};

// Adds the picked purchases, all or none, then goes to the Ledger with the
// new rows marked.
export async function submitReviewAction(input: ReviewInput): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    const bank = requireBank(bankRuntime());
    if (!input || typeof input.accountId !== "string" || !Array.isArray(input.items)) throw new UserError("pick at least one purchase");
    const items = input.items.map((i) => ({
      plaidTransactionId: String(i.plaidTransactionId ?? ""),
      description: i.description === undefined ? undefined : String(i.description),
      category: i.category === undefined ? undefined : String(i.category),
      rule: i.rule ?? undefined,
      tieTo: i.tieTo ? String(i.tieTo) : undefined,
    }));
    const done = await submitReview(
      db,
      bank,
      me,
      input.accountId,
      { payment: input.payment || undefined, from: input.from || undefined, items },
      new Date(),
    );
    const ids = done.expenses.map((e) => e.id);
    return `/?${new URLSearchParams(ids.length ? { added: ids.join(",") } : {})}`;
  });
}

// What one picked purchase would split to, for the split step.
export async function previewReviewAction(input: { totalCents: number; category: string; date: string; rule?: Rule }): Promise<SplitPreview | null> {
  const { me, db, home, members } = await requireHousehold();
  try {
    return await previewSplit(db, home.id, members, {
      totalCents: Number(input.totalCents),
      payerId: me.id,
      category: String(input.category ?? ""),
      date: String(input.date ?? ""),
      rule: input.rule ?? undefined,
    });
  } catch (e) {
    if (e instanceof UserError) return { ok: false, rule: null, why: e.message, reason: "invalid" };
    throw e;
  }
}
