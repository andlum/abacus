import { and, desc, eq, gte, isNull, lte, ne } from "drizzle-orm";
import { expenseTemplate, household, splitRule, type Member, type SplitRule } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";
import { isIsoDate } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { isValidRule, type Rule } from "@abacus/core/split";
import { toCategory } from "./categories.ts";
import { isUuid } from "./ids.ts";
import { householdMembers, memberIdsOn } from "./members.ts";
import { latestOn, loadContext, ruleOn, type FoundRule, type RuleQuery } from "./split/resolve.ts";

// What a rule covers: one recurring cost, one category, or everything else.
export type RuleTarget =
  | { scope: "household" }
  | { scope: "category"; category: string }
  | { scope: "template"; templateLineageId: string };

export type RuleInput = RuleTarget & {
  rule: Rule;
  // The date it counts from. Left out, today.
  effectiveFrom?: string;
};

// Later than any date, so `latestOn` gives the row that comes last.
const ALWAYS = "9999-12-31";

const memberActor = (m: Member) => ({ kind: "member" as const, memberId: m.id });

// The rule that applies to a cost on a date: the rule for that recurring
// cost, else for its category, else the household's, else the built-in
// 50/50. `source` says which.
export async function ruleFor(db: Db, householdId: string, query: RuleQuery): Promise<FoundRule> {
  return ruleOn(await loadContext(db, householdId), query);
}

// Rules in force from their dates, newest first. Removed and replaced ones
// are left out; `listRuleHistory` has them.
export async function listRules(db: Db, householdId: string): Promise<SplitRule[]> {
  return db
    .select()
    .from(splitRule)
    .where(and(eq(splitRule.householdId, householdId), eq(splitRule.status, "active")))
    .orderBy(desc(splitRule.effectiveFrom), desc(splitRule.activatedAt));
}

// Holds the group's row until the transaction ends, so two saves or
// removals of rules run one after the other, each reading the rows the
// other left.
async function lockGroup(tx: Db, householdId: string): Promise<void> {
  await tx.select({ id: household.id }).from(household).where(eq(household.id, householdId)).for("update");
}

const sameTarget = (householdId: string, t: RuleTarget) =>
  and(
    eq(splitRule.householdId, householdId),
    eq(splitRule.scope, t.scope),
    t.scope === "template" ? eq(splitRule.templateLineageId, t.templateLineageId) : isNull(splitRule.templateLineageId),
    t.scope === "category" ? eq(splitRule.category, t.category) : isNull(splitRule.category),
  );

const targetOf = (r: SplitRule): RuleTarget =>
  r.scope === "template"
    ? { scope: "template", templateLineageId: r.templateLineageId! }
    : r.scope === "category"
      ? { scope: "category", category: r.category! }
      : { scope: "household" };

// The target as given, checked against the group: a category from its list,
// a recurring cost it has.
async function checkTarget(db: Db, householdId: string, input: RuleTarget): Promise<RuleTarget> {
  if (input.scope === "household") return { scope: "household" };
  if (input.scope === "category") {
    if (!input.category?.trim()) throw new UserError("a category rule needs a category");
    return { scope: "category", category: await toCategory(db, householdId, input.category) };
  }
  if (input.scope === "template") {
    const exists =
      isUuid(input.templateLineageId) &&
      (
        await db
          .select({ id: expenseTemplate.id })
          .from(expenseTemplate)
          .where(and(eq(expenseTemplate.householdId, householdId), eq(expenseTemplate.lineageId, input.templateLineageId)))
          .limit(1)
      ).length > 0;
    if (!exists) throw new UserError("that recurring cost does not exist");
    return { scope: "template", templateLineageId: input.templateLineageId };
  }
  throw new UserError("that rule is not valid: unknown scope");
}

// The rule for one target from its date onwards: the active row that comes
// last. An edit replaces this one.
async function latestRow(tx: Db, householdId: string, t: RuleTarget): Promise<SplitRule | undefined> {
  const rows = await tx
    .select()
    .from(splitRule)
    .where(and(sameTarget(householdId, t), eq(splitRule.status, "active")));
  return latestOn(rows, ALWAYS);
}

// Saves a rule for a target, in force at once from `effectiveFrom`, the
// same way an income is saved (incomes.ts). With no rule for the target yet
// it is added; otherwise it changes the rule: a new row pointing back at
// the one it replaces. With a later date the old rule still holds before it.
// With the same date or an earlier one it replaces every rule for the target
// dated on or after it: those become `void`, with `replacedBy` set to the
// new row, so they stay on record but no longer count. Expenses already
// split keep their shares.
// `editing` is the row an edit started from; if it was changed or removed
// while the edit waited for the lock, the edit is refused.
async function saveRule(
  db: Db,
  actor: Member,
  target: RuleTarget,
  rule: Rule,
  date: string | undefined,
  today: string,
  editing?: string,
): Promise<SplitRule> {
  const effectiveFrom = date || today;
  if (!isIsoDate(effectiveFrom)) throw new UserError("the date it counts from is not a date");
  const memberIds = memberIdsOn(await householdMembers(db, actor.householdId), effectiveFrom);
  if (!isValidRule(rule, memberIds)) throw new UserError("that rule is not valid for this household");
  return db.transaction(async (tx) => {
    await lockGroup(tx, actor.householdId);
    if (editing) await stillActive(tx, actor.householdId, editing);
    const replaces = await latestRow(tx, actor.householdId, target);
    // Saved last wins a same-date tie, even within the same millisecond.
    const now = new Date();
    const after = replaces?.activatedAt ? replaces.activatedAt.getTime() + 1 : 0;
    const activatedAt = now.getTime() > after ? now : new Date(after);
    const [row] = await tx
      .insert(splitRule)
      .values({
        householdId: actor.householdId,
        scope: target.scope,
        templateLineageId: target.scope === "template" ? target.templateLineageId : null,
        category: target.scope === "category" ? target.category : null,
        rule,
        effectiveFrom,
        status: "active",
        activatedAt,
        supersedesId: replaces?.id ?? null,
        createdBy: actor.id,
      })
      .returning();
    const voided = await tx
      .update(splitRule)
      .set({ status: "void", voidedAt: now, voidedBy: actor.id, replacedBy: row!.id })
      .where(
        and(
          sameTarget(actor.householdId, target),
          eq(splitRule.status, "active"),
          gte(splitRule.effectiveFrom, effectiveFrom),
          ne(splitRule.id, row!.id),
        ),
      )
      .returning({ id: splitRule.id });
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: memberActor(actor),
      action: replaces ? "split_rule.changed" : "split_rule.added",
      entity: { type: "split_rule", id: row!.id },
      detail: {
        effectiveFrom,
        ...(replaces ? { supersedesId: replaces.id } : {}),
        ...(voided.length > 0 ? { replacedIds: voided.map((v) => v.id) } : {}),
      },
    });
    return row!;
  });
}

// Adds a rule, or changes the one the target already has. Any member may.
export async function addRule(db: Db, actor: Member, input: RuleInput, today: string): Promise<SplitRule> {
  const target = await checkTarget(db, actor.householdId, input);
  return saveRule(db, actor, target, input.rule, input.effectiveFrom, today);
}

// An active rule of the actor's group, or a plain refusal.
async function activeRule(db: Db, householdId: string, ruleId: string): Promise<SplitRule> {
  if (!isUuid(ruleId)) throw new UserError("that rule does not exist");
  const [row] = await db
    .select()
    .from(splitRule)
    .where(and(eq(splitRule.householdId, householdId), eq(splitRule.id, ruleId)));
  if (!row) throw new UserError("that rule does not exist");
  if (row.status !== "active") throw new UserError("that rule has been changed or removed since");
  return row;
}

// Checks again, under the group lock, that a rule is still active.
async function stillActive(tx: Db, householdId: string, ruleId: string): Promise<SplitRule> {
  const [row] = await tx
    .select()
    .from(splitRule)
    .where(and(eq(splitRule.householdId, householdId), eq(splitRule.id, ruleId)));
  if (row?.status !== "active") throw new UserError("that rule has been changed or removed since");
  return row;
}

// Changes the rule for whatever `ruleId` covers, from `effectiveFrom`.
export async function editRule(
  db: Db,
  actor: Member,
  ruleId: string,
  input: { rule: Rule; effectiveFrom?: string },
  today: string,
): Promise<SplitRule> {
  const row = await activeRule(db, actor.householdId, ruleId);
  return saveRule(db, actor, targetOf(row), input.rule, input.effectiveFrom, today, row.id);
}

// Removes the rule row that was picked; removed rows become `void` and stay
// on record. An upcoming row goes alone, so the rule in force today stays.
// A row already in force goes with every earlier one for its target, so no
// older rule comes back in its place: the next rule in line applies on those
// dates, and any upcoming row still starts on its date. Expenses already
// split keep their shares.
export async function removeRule(db: Db, actor: Member, ruleId: string, today: string): Promise<void> {
  await activeRule(db, actor.householdId, ruleId);
  await db.transaction(async (tx) => {
    await lockGroup(tx, actor.householdId);
    const row = await stillActive(tx, actor.householdId, ruleId);
    const voided = await tx
      .update(splitRule)
      .set({ status: "void", voidedAt: new Date(), voidedBy: actor.id })
      .where(
        row.effectiveFrom > today
          ? eq(splitRule.id, row.id)
          : and(sameTarget(actor.householdId, targetOf(row)), eq(splitRule.status, "active"), lte(splitRule.effectiveFrom, row.effectiveFrom)),
      )
      .returning({ id: splitRule.id });
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: memberActor(actor),
      action: "split_rule.removed",
      entity: { type: "split_rule", id: row.id },
      detail: { ruleIds: voided.map((v) => v.id) },
    });
  });
}

// Where a rule stands on `today`: the one for its target in force today,
// `current`; an active one dated after today, `upcoming`; an active one
// dated before the current one, which still holds before it, `earlier`; one
// voided by an edit dated on or before it, `replaced`; or one `removed`.
export type RuleState = "current" | "upcoming" | "earlier" | "replaced" | "removed";
export type ListedRule = SplitRule & { state: RuleState };

// Every rule that ever counted, newest first. Rows that never took effect
// (from proposals before rules counted at once) are left out.
export async function listRuleHistory(db: Db, householdId: string, today: string): Promise<ListedRule[]> {
  const rows = (
    await db
      .select()
      .from(splitRule)
      .where(eq(splitRule.householdId, householdId))
      .orderBy(desc(splitRule.effectiveFrom), desc(splitRule.createdAt))
  ).filter((r) => r.status === "active" || r.status === "void");
  const key = (r: SplitRule) => `${r.scope}:${r.templateLineageId ?? r.category ?? ""}`;
  const current = new Set<string>();
  for (const k of new Set(rows.map(key))) {
    const inForce = latestOn(
      rows.filter((r) => key(r) === k && r.status === "active"),
      today,
    );
    if (inForce) current.add(inForce.id);
  }
  const stateOf = (r: SplitRule): RuleState =>
    current.has(r.id)
      ? "current"
      : r.status === "active"
        ? r.effectiveFrom > today
          ? "upcoming"
          : "earlier"
        : r.replacedBy !== null
          ? "replaced"
          : "removed";
  return rows.map((r) => ({ ...r, state: stateOf(r) }));
}
