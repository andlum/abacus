"use server";

import { attempt, field, type ActionState } from "@/lib/action";
import { bankRuntime, requireBank } from "@/lib/bank-link";
import { setCardMode, sharePastPayment, submitReview, type ReviewPick } from "@/lib/card-review";
import { previewSplit, type SplitPreview } from "@/lib/split-preview";
import { UserError } from "@abacus/core/errors";
import type { Rule } from "@abacus/core/split";
import { requireHousehold } from "@/lib/session";

// Shared or personal. Payments synced from now on follow it; earlier ones are
// shared by hand (sharePastPaymentAction).
export async function setCardModeAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    requireBank(bankRuntime());
    const mode = field(form, "mode");
    if (mode !== "shared" && mode !== "personal") throw new UserError("choose shared or personal");
    await setCardMode(db, me, field(form, "accountId"), mode);
  });
}

// Shares one earlier payment, then opens its review.
export async function sharePastPaymentAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    const bank = requireBank(bankRuntime());
    const accountId = field(form, "accountId");
    const p = await sharePastPayment(db, bank, me, accountId, field(form, "plaidTransactionId"), new Date());
    return `/accounts/${accountId}/review?${new URLSearchParams({ payment: p.id })}`;
  });
}

// Left out stays left out; null clears.
const text = (v: unknown) => (v === undefined ? undefined : v === null ? null : String(v));

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
      vendor: text(i.vendor),
      note: text(i.note),
      businessUseBp: i.businessUseBp === undefined ? undefined : Number(i.businessUseBp),
      useBasis: text(i.useBasis),
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
