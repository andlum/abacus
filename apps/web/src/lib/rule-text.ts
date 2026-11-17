// Rules as people read and type them: the words on the pages, and the form
// fields a rule is picked with.
import type { ExpenseComputation, RuleSource } from "../db/schema.ts";
import { UserError } from "@abacus/core/errors";
import { formatBp, formatCents, parseBp, parseCents } from "@abacus/core/money";
import { isValidRule, type BaseRule, type Rule } from "@abacus/core/split";

type Person = { id: string; displayName: string };

function describeBase(rule: BaseRule, people: Person[]): string {
  if (rule.kind === "even") return "split evenly";
  if (rule.kind === "income_proportional") return "split by income";
  return people.map((p) => `${p.displayName} ${formatBp(rule.bp[p.id] ?? 0)}`).join(", ");
}

export function describeRule(rule: Rule, people: Person[]): string {
  if (rule.kind !== "fixed_plus_remainder") return describeBase(rule, people);
  const fixed = people
    .filter((p) => (rule.fixedCents[p.id] ?? 0) > 0)
    .map((p) => `${p.displayName} pays ${formatCents(rule.fixedCents[p.id]!)} first`);
  return [...fixed, `the rest ${describeBase(rule.remainder, people)}`].join(", ");
}

export const SOURCE_TEXT: Record<RuleSource, string> = {
  template: "the rule for this recurring cost",
  category: "the rule for this category",
  household: "the rule for the household",
  default: "the built-in even-split default: there is no rule for this",
  entry: "a split picked for this one expense",
};

export const REASON_TEXT: Record<string, string> = {
  income_missing: "it is split by income, and someone's income was not in force",
  all_incomes_zero: "it is split by income, and every income is zero",
  fixed_exceeds_total: "the fixed amounts in its rule add up to more than the total",
  invalid_rule: "its rule is not valid for this household",
  invalid_total: "its amount is not valid",
  ratio_unavailable: "it is split by income, and the income ratio could not be worked out",
};

// An exact share of `cents * weight / weightSum`, to a tenth of a cent,
// with "…" when it runs on, and the whole cents it rounds down to.
function exactShare(cents: number, weight: number, weightSum: number): { text: string; floor: number; whole: boolean } {
  const num = BigInt(cents) * BigInt(weight);
  const den = BigInt(weightSum);
  const floor = Number(num / den);
  const tenths = Number(((num * 10n) / den) % 10n);
  const whole = num % den === 0n;
  const runsOn = (num * 10n) % den !== 0n;
  return { text: whole ? formatCents(floor) : `${formatCents(floor)}${tenths}${runsOn ? "…" : ""}`, floor, whole };
}

function listNames(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// "Show the maths": the stored computation in sentences, in the order
// someone would work it out by hand.
export function explain(c: ExpenseComputation, shares: Record<string, number>, people: Person[]): string[] {
  const name = (id: string) => people.find((p) => p.id === id)?.displayName ?? "someone";
  // In the order the page lists people, like the shares line.
  const ids = [
    ...people.map((p) => p.id).filter((id) => c.memberIds.includes(id)),
    ...c.memberIds.filter((id) => !people.some((p) => p.id === id)),
  ];
  const lines = [`Total ${formatCents(c.totalCents)}, paid by ${name(c.payerId)}.`];
  lines.push(`Rule: ${describeRule(c.rule, people)}. This is ${SOURCE_TEXT[c.ruleSource]}.`);
  if (c.chosenBy) lines.push(`Picked by ${name(c.chosenBy)}.`);
  lines.push(`Rules and incomes as they stood on ${c.rulesAsOf}.`);
  if (c.ratioBp) {
    lines.push(`Income ratio: ${people.map((p) => `${p.displayName} ${formatBp(c.ratioBp![p.id] ?? 0)}`).join(", ")}.`);
  }

  // Fixed amounts come off the top; the rest is shared by weight.
  const fixed = c.rule.kind === "fixed_plus_remainder" ? c.rule.fixedCents : {};
  const fixedSum = Object.values(fixed).reduce((a, b) => a + b, 0);
  const rest = c.totalCents - fixedSum;
  if (fixedSum > 0) {
    const firsts = ids.filter((id) => (fixed[id] ?? 0) > 0).map((id) => `${name(id)} pays ${formatCents(fixed[id]!)}`);
    lines.push(`First, ${listNames(firsts)}. That leaves ${formatCents(rest)}.`);
  }
  const base = c.rule.kind === "fixed_plus_remainder" ? c.rule.remainder : c.rule;
  const weightOf = (id: string) =>
    base.kind === "even" ? 1 : base.kind === "percent" ? (base.bp[id] ?? 0) : (c.ratioBp?.[id] ?? 0);
  const weightSum = ids.reduce((a, id) => a + weightOf(id), 0);
  if (weightSum > 0) {
    if (base.kind === "even" && fixedSum === 0) {
      const share = exactShare(rest, 1, ids.length);
      const rounded = share.whole ? "" : `, rounded down to ${formatCents(share.floor)}`;
      lines.push(`${listNames(ids.map(name))}: ${formatCents(rest)} ÷ ${ids.length} = ${share.text}${rounded} each.`);
    } else {
      for (const id of ids) {
        const share = exactShare(rest, weightOf(id), weightSum);
        const part = base.kind === "even" ? `${formatCents(rest)} ÷ ${ids.length}` : `${formatBp(weightOf(id))} of ${formatCents(rest)}`;
        const rounded = share.whole ? "" : `, rounded down to ${formatCents(share.floor)}`;
        const first = fixed[id] ?? 0;
        const plus = first > 0 ? `, plus ${formatCents(first)} first = ${formatCents(share.floor + first)}` : "";
        lines.push(`${name(id)}: ${part} = ${share.text}${rounded}${plus}.`);
      }
    }
  }

  const { leftoverCents, receivedBy } = c.rounding;
  if (leftoverCents > 0) {
    lines.push(
      `Rounding every segment down left ${leftoverCents === 1 ? "1 cent" : `${leftoverCents} cents`}, ` +
        `which went to ${receivedBy.map(name).join(" and ")} by a random draw (seed ${c.seed}).`,
    );
  }
  lines.push(`Segments: ${people.map((p) => `${p.displayName} ${formatCents(shares[p.id] ?? 0)}`).join(", ")}.`);

  // What it does to the balance: everyone else owes the payer their share.
  const owing = ids.filter((id) => id !== c.payerId && (shares[id] ?? 0) > 0);
  if (owing.length === 0) lines.push(`${name(c.payerId)} paid for all of it, so nobody owes anything for this.`);
  for (const id of owing) lines.push(`So ${name(id)} owes ${name(c.payerId)} ${formatCents(shares[id]!)} for this.`);
  return lines;
}

// Reads a rule from form fields named `${prefix}kind`, `${prefix}pct_<id>`,
// `${prefix}fixed_<id>` and `${prefix}remainder`. Null when no rule was
// picked (kind "none" or missing).
export function readRule(form: FormData, prefix: string, people: Person[]): Rule | null {
  const text = (name: string) => String(form.get(prefix + name) ?? "").trim();
  const base = (kind: string): BaseRule => {
    if (kind === "even" || kind === "income_proportional") return { kind };
    if (kind !== "percent") throw new UserError("choose how to split");
    const bp: Record<string, number> = {};
    for (const p of people) {
      const value = parseBp(text(`pct_${p.id}`) || "0");
      if (value === null) throw new UserError(`${p.displayName}'s percentage must be between 0 and 100`);
      // Someone given nothing is left out, so a rule never names a person
      // who has no part in the cost (someone invited who has not joined).
      if (value > 0) bp[p.id] = value;
    }
    if (Object.values(bp).reduce((a, b) => a + b, 0) !== 10000) throw new UserError("the percentages must add up to 100");
    return { kind, bp };
  };

  const kind = text("kind");
  if (kind === "" || kind === "none") return null;
  let rule: Rule;
  if (kind === "fixed_plus_remainder") {
    const fixedCents: Record<string, number> = {};
    for (const p of people) {
      const raw = text(`fixed_${p.id}`);
      if (!raw) continue;
      const cents = parseCents(raw);
      if (cents === null) throw new UserError(`${p.displayName}'s fixed amount is not an amount`);
      if (cents > 0) fixedCents[p.id] = cents;
    }
    if (Object.keys(fixedCents).length === 0) throw new UserError("enter the fixed amount someone pays first");
    rule = { kind, fixedCents, remainder: base(text("remainder") || "even") };
  } else {
    rule = base(kind);
  }
  if (!isValidRule(rule, people.map((p) => p.id))) throw new UserError("that split is not valid for this household");
  return rule;
}
