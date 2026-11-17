// What an expense would split to, before it is saved. Runs the same rule
// lookup and calculation as saving, against the same accepted rules.
import { toCategory } from "./categories.ts";
import type { Db } from "../db/types.ts";
import { formatBp, formatCents } from "@abacus/core/money";
import { describeRule, REASON_TEXT, SOURCE_TEXT } from "./rule-text.ts";
import { isValidRule, type Rule } from "@abacus/core/split";
import { loadContext, resolveSplit, type SplitContext } from "./split/resolve.ts";

type Person = { id: string; displayName: string };

export type PreviewInput = {
  totalCents: number;
  payerId: string;
  category: string;
  // The date whose rules and incomes apply.
  date: string;
  templateLineageId?: string | null;
  rule?: Rule;
};

export type SplitPreview =
  | {
      ok: true;
      shares: Record<string, number>;
      rule: string;
      why: string;
      isDefault: boolean;
      ratio: string | null;
      leftoverCents: number;
      effect: string;
    }
  // `reason` is the code behind `why`: a key of REASON_TEXT.
  | { ok: false; rule: string | null; why: string; reason: string };

export async function previewSplit(
  db: Db,
  householdId: string,
  people: Person[],
  input: PreviewInput,
): Promise<SplitPreview> {
  // An invalid split is answered before the category is checked.
  const invalid = invalidRule(people, input);
  if (invalid) return invalid;
  const category = await toCategory(db, householdId, input.category);
  return previewWith(await loadContext(db, householdId), people, { ...input, category });
}

function invalidRule(people: Person[], input: PreviewInput): SplitPreview | null {
  if (!input.rule || isValidRule(input.rule, people.map((p) => p.id))) return null;
  return { ok: false, rule: null, why: REASON_TEXT.invalid_rule!, reason: "invalid_rule" };
}

// The same, for a caller that has the rules loaded and a category already
// checked: a list of many expenses asks the database once, not once each.
export function previewWith(ctx: SplitContext, people: Person[], input: PreviewInput): SplitPreview {
  const invalid = invalidRule(people, input);
  if (invalid) return invalid;
  const name = (id: string) => people.find((p) => p.id === id)?.displayName ?? "someone";
  const resolved = resolveSplit(ctx, {
    templateLineageId: input.templateLineageId ?? null,
    category: input.category,
    totalCents: input.totalCents,
    payerId: input.payerId,
    // Any seed will do: the real one is drawn on save, and can only move a
    // leftover cent.
    seed: "preview",
    rulesAsOf: input.date,
    chosen: input.rule ? { rule: input.rule, by: "" } : undefined,
  });
  if (!resolved.ok) {
    return { ok: false, rule: null, why: `It could not be split: ${REASON_TEXT[resolved.reason] ?? resolved.reason}.`, reason: resolved.reason };
  }
  const c = resolved.computation;
  const owed = people
    .filter((p) => p.id !== input.payerId && (resolved.shares[p.id] ?? 0) > 0)
    .map((p) => `${p.displayName} will owe ${name(input.payerId)} ${formatCents(resolved.shares[p.id]!)}`);
  return {
    ok: true,
    shares: resolved.shares,
    rule: capitalise(describeRule(c.rule, people)),
    why: `This is ${SOURCE_TEXT[resolved.source]}.`,
    // One person has nobody to split with, so there is no default to warn about.
    isDefault: resolved.source === "default" && people.length > 1,
    ratio: c.ratioBp ? people.map((p) => `${p.displayName} ${formatBp(c.ratioBp![p.id] ?? 0)}`).join(", ") : null,
    leftoverCents: c.rounding.leftoverCents,
    effect: owed.length ? `${owed.join(", ")} for this.` : "Nobody owes anything for this.",
  };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
