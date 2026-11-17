// Which rule and incomes apply on a date, and the split they produce. Pure:
// works on rows already loaded, so posting an expense and previewing one
// run exactly the same code.
import { and, eq } from "drizzle-orm";
import {
  income,
  splitRule,
  type ExpenseComputation,
  type Income,
  type RuleSource,
  type SplitRule,
} from "../../db/schema.ts";
import type { Db } from "../../db/types.ts";
import { householdMembers, memberIdsOn } from "../members.ts";
import { computeSplit, incomeRatio, usesIncome, type Rule, type SplitFailure } from "@abacus/core/split";

export type SplitContext = {
  // Everyone in the group; who counts depends on the date (memberIdsOn).
  members: { id: string; sharesFrom: string | null }[];
  // Active rows only.
  rules: SplitRule[];
  incomes: Income[];
};

type Dated = { effectiveFrom: string | null; status: string; activatedAt: Date | null; createdAt: Date };

// The row with the latest effective date on or before `date`. Between two
// rows with the same date, the one agreed last wins; a row still proposed
// (previewing) counts as agreed after everything else. Rows agreed at the
// same instant (incomes that stopped waiting in migration 0020) fall back to
// the one recorded last.
export function latestOn<T extends Dated>(rows: T[], date: string): T | undefined {
  const agreedAt = (r: T) => (r.status === "proposed" ? Infinity : (r.activatedAt ?? r.createdAt).getTime());
  return rows
    .filter((r) => r.effectiveFrom !== null && r.effectiveFrom <= date)
    .sort(
      (a, b) =>
        b.effectiveFrom!.localeCompare(a.effectiveFrom!) ||
        agreedAt(b) - agreedAt(a) ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    )[0];
}

export type RuleQuery = { templateLineageId?: string | null; category?: string | null; date: string };
export type FoundRule = { rule: Rule; source: RuleSource; ruleId: string | null };

export function ruleOn(ctx: SplitContext, q: RuleQuery): FoundRule {
  const found = (row: SplitRule | undefined, source: RuleSource): FoundRule | undefined =>
    row && { rule: row.rule, source, ruleId: row.id };
  return (
    (q.templateLineageId
      ? found(
          latestOn(
            ctx.rules.filter((r) => r.scope === "template" && r.templateLineageId === q.templateLineageId),
            q.date,
          ),
          "template",
        )
      : undefined) ??
    (q.category
      ? found(
          latestOn(
            ctx.rules.filter((r) => r.scope === "category" && r.category === q.category),
            q.date,
          ),
          "category",
        )
      : undefined) ??
    found(
      latestOn(
        ctx.rules.filter((r) => r.scope === "household"),
        q.date,
      ),
      "household",
    ) ?? { rule: { kind: "even" }, source: "default", ruleId: null }
  );
}

export type IncomesOn =
  | { ok: true; annualCents: Record<string, number>; incomeIds: Record<string, string> }
  | { ok: false; missing: string[] };

// `membersAsOf` is the date that decides whose income is needed, when it is
// not `date` itself.
export function incomesOn(ctx: SplitContext, date: string, membersAsOf: string = date): IncomesOn {
  const annualCents: Record<string, number> = {};
  const incomeIds: Record<string, string> = {};
  const missing: string[] = [];
  for (const id of memberIdsOn(ctx.members, membersAsOf)) {
    const row = latestOn(
      ctx.incomes.filter((i) => i.ownerId === id),
      date,
    );
    if (!row) {
      missing.push(id);
    } else {
      annualCents[id] = row.annualCents;
      incomeIds[id] = row.id;
    }
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true, annualCents, incomeIds };
}

export type Unassigned = SplitFailure | "income_missing" | "all_incomes_zero";

export type SplitRequest = {
  templateLineageId?: string | null;
  category?: string | null;
  totalCents: number;
  payerId: string;
  seed: string;
  // The date whose rules and incomes are used.
  rulesAsOf: string;
  // The date that decides who the cost is split between: the cost's own
  // date. Left out, it is `rulesAsOf`.
  membersAsOf?: string;
  // A split picked by hand for this one expense, instead of the agreed rules.
  chosen?: { rule: Rule; by: string };
};

export type Resolved =
  | { ok: true; shares: Record<string, number>; computation: ExpenseComputation; source: RuleSource }
  | { ok: false; reason: Unassigned; source: RuleSource };

export function resolveSplit(ctx: SplitContext, req: SplitRequest): Resolved {
  const found: FoundRule = req.chosen
    ? { rule: req.chosen.rule, source: "entry", ruleId: null }
    : ruleOn(ctx, { templateLineageId: req.templateLineageId, category: req.category, date: req.rulesAsOf });

  const memberIds = memberIdsOn(ctx.members, req.membersAsOf ?? req.rulesAsOf);
  let ratioBp: Record<string, number> | undefined;
  let incomeIds: Record<string, string> | undefined;
  if (usesIncome(found.rule)) {
    const incomes = incomesOn(ctx, req.rulesAsOf, req.membersAsOf);
    if (!incomes.ok) return { ok: false, reason: "income_missing", source: found.source };
    const ratio = incomeRatio(memberIds, incomes.annualCents);
    if (!ratio.ok) return { ok: false, reason: ratio.reason, source: found.source };
    ratioBp = ratio.bp;
    incomeIds = incomes.incomeIds;
  }

  const split = computeSplit({
    totalCents: req.totalCents,
    payerId: req.payerId,
    memberIds,
    rule: found.rule,
    seed: req.seed,
    ratioBp,
  });
  if (!split.ok) return { ok: false, reason: split.reason, source: found.source };
  return {
    ok: true,
    shares: split.shares,
    source: found.source,
    computation: {
      ...split.computation,
      ruleSource: found.source,
      ruleId: found.ruleId,
      rulesAsOf: req.rulesAsOf,
      ...(incomeIds ? { incomeIds } : {}),
      ...(req.chosen ? { chosenBy: req.chosen.by } : {}),
    },
  };
}

// Every rule and income of the household in force from its date: the
// active rows. Removed, replaced and withdrawn rows are left out.
export async function loadContext(db: Db, householdId: string): Promise<SplitContext> {
  const members = await householdMembers(db, householdId);
  const rules = await db
    .select()
    .from(splitRule)
    .where(and(eq(splitRule.householdId, householdId), eq(splitRule.status, "active")));
  const incomes = await db
    .select()
    .from(income)
    .where(and(eq(income.householdId, householdId), eq(income.status, "active")));
  return {
    members: members.map((m) => ({ id: m.id, sharesFrom: m.sharesFrom })),
    rules,
    incomes,
  };
}

// The seed for a recurring cost's leftover-cent draw: fixed by the cost and
// the period, so a preview and the real posting agree.
export function templateSeed(lineageId: string, period: string): string {
  return `${lineageId}:${period}`;
}
