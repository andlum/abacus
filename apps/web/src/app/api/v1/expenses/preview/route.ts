import type { Rule } from "@abacus/core/split";
import { cents, date, jsonBody, memberId, route, str } from "@/lib/api";
import { previewSplit } from "@/lib/split-preview";

export const dynamic = "force-dynamic";

// What POST /expenses would split this to. Saves nothing. The phone shows
// this rather than working the split out itself.
export const POST = route(async ({ me, db, home, members, today }, req) => {
  const b = await jsonBody(req);
  return previewSplit(db, home.id, members, {
    totalCents: cents(b, "totalCents"),
    payerId: memberId(b, "payerId", members, me.id),
    category: str(b, "category", true) ?? "",
    date: date(b, "date", today),
    // Checked by previewSplit, which answers ok: false for a bad rule.
    rule: (b.rule ?? undefined) as Rule | undefined,
  });
});
