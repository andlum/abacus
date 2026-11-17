import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLog, changeSet, changeSetAcceptance, income, splitRule } from "@/db/schema";
import type { Rule } from "@abacus/core/split";
import { createExpense } from "./expenses";
import { recentAudit } from "./audit";
import { addRule, editRule, listRuleHistory, listRules, removeRule, ruleFor } from "./rules";
import { createTemplate } from "./templates";
import { agree, createWorld, type World } from "./testing/world";

const TODAY = "2026-10-01";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

const percent = (alexBp: number) => ({ kind: "percent" as const, bp: { [w.alex.id]: alexBp, [w.sam.id]: 10000 - alexBp } });
const on = (date: string, q: { templateLineageId?: string; category?: string } = {}) => ruleFor(w.db, w.householdId, { ...q, date });
const row = async (id: string) => (await w.db.select().from(splitRule).where(eq(splitRule.id, id)))[0]!;

async function rent() {
  return createTemplate(w.db, w.alex, {
    name: "Rent",
    category: "housing",
    amountCents: 200000,
    cadence: "monthly",
    dayOfMonth: 1,
    payerId: w.alex.id,
    startDate: "2026-10-01",
  });
}

describe("ruleFor", () => {
  it("falls back to the built-in 50/50 when there is no rule", async () => {
    expect(await on("2026-10-01", { category: "groceries" })).toEqual({ rule: { kind: "even" }, source: "default", ruleId: null });
  });

  it("uses the household rule when there is one", async () => {
    await agree(w, "2026-10-01", { rules: [{ scope: "household", rule: percent(6000) }] });
    const found = await on("2026-10-01", { category: "groceries" });
    expect(found).toMatchObject({ rule: percent(6000), source: "household" });
    expect(found.ruleId).toEqual(expect.any(String));
  });

  it("prefers a category rule to the household rule, and a rule for the recurring cost to both", async () => {
    const template = await rent();
    await agree(w, "2026-10-01", {
      rules: [
        { scope: "household", rule: percent(6000) },
        { scope: "category", category: "housing", rule: percent(7000) },
        { scope: "template", templateLineageId: template.lineageId, rule: percent(8000) },
      ],
    });
    expect(await on("2026-10-01", { templateLineageId: template.lineageId, category: "housing" })).toMatchObject({
      rule: percent(8000),
      source: "template",
    });
    expect(await on("2026-10-01", { category: "housing" })).toMatchObject({ rule: percent(7000), source: "category" });
    expect(await on("2026-10-01", { category: "groceries" })).toMatchObject({ rule: percent(6000), source: "household" });
    expect(await on("2026-10-01")).toMatchObject({ source: "household" });
  });

  it("applies a rule from its effective date and not before", async () => {
    await agree(w, "2026-10-01", { rules: [{ scope: "household", rule: percent(6000) }] });
    await agree(w, "2027-01-01", { rules: [{ scope: "household", rule: percent(5500) }] }, "2026-12-01");
    expect(await on("2026-09-30")).toMatchObject({ source: "default" });
    expect(await on("2026-12-31")).toMatchObject({ rule: percent(6000) });
    expect(await on("2027-01-01")).toMatchObject({ rule: percent(5500) });
  });

  it("lists the rules in force for the rules page", async () => {
    await agree(w, "2026-10-01", { rules: [{ scope: "category", category: "housing", rule: percent(7000) }] });
    const rules = await listRules(w.db, w.householdId);
    expect(rules.map((r) => [r.scope, r.category, r.status])).toEqual([["category", "housing", "active"]]);
  });
});

describe("adding a rule", () => {
  it("counts at once from today when no date is given, with nothing waiting", async () => {
    const r = await addRule(w.db, w.sam, { scope: "household", rule: percent(6000) }, TODAY);
    expect(r).toMatchObject({ status: "active", effectiveFrom: TODAY, changeSetId: null, createdBy: w.sam.id });
    expect(r.activatedAt).not.toBeNull();
    expect(await on(TODAY)).toMatchObject({ rule: percent(6000), ruleId: r.id });
  });

  it("may be dated in the past", async () => {
    await addRule(w.db, w.alex, { scope: "household", rule: percent(6000), effectiveFrom: "2026-01-01" }, TODAY);
    expect(await on("2026-01-01")).toMatchObject({ rule: percent(6000) });
    expect(await on("2025-12-31")).toMatchObject({ source: "default" });
  });

  it("refuses a category rule for a category that is not in the list", async () => {
    await expect(addRule(w.db, w.alex, { scope: "category", category: "eating out", rule: percent(6000) }, TODAY)).rejects.toThrow(
      "choose a category from the list",
    );
  });

  const addBad = (rule: unknown, extra: object = { scope: "household" }) => addRule(w.db, w.alex, { ...extra, rule } as never, TODAY);

  it("refuses percentages that do not sum to 100%", async () => {
    await expect(addBad({ kind: "percent", bp: { [w.alex.id]: 6000, [w.sam.id]: 3000 } })).rejects.toThrow(/rule/);
  });

  it("refuses a rule naming someone outside the household", async () => {
    await expect(addBad({ kind: "percent", bp: { stranger: 10000 } })).rejects.toThrow(/rule/);
  });

  it("refuses an unknown kind of rule", async () => {
    await expect(addBad({ kind: "by_height" })).rejects.toThrow(/rule/);
  });

  it("refuses a rule for a recurring cost that does not exist", async () => {
    await expect(addBad({ kind: "even" }, { scope: "template", templateLineageId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(
      /recurring cost/,
    );
  });

  it("refuses a date that is not a date", async () => {
    await expect(addRule(w.db, w.alex, { scope: "household", rule: { kind: "even" }, effectiveFrom: "soon" }, TODAY)).rejects.toThrow(
      "not a date",
    );
  });

  it("records an audit entry for a split_rule, with ids and no rule", async () => {
    const r = await addRule(w.db, w.alex, { scope: "household", rule: percent(6000) }, TODAY);
    const [entry] = await recentAudit(w.db, w.householdId, 1);
    expect(entry).toMatchObject({ action: "split_rule.added", entityType: "split_rule", entityId: r.id, detail: { effectiveFrom: TODAY } });
    expect(JSON.stringify(entry!.detail)).not.toContain("6000");
  });
});

describe("editing a rule", () => {
  it("from a later date keeps the old rule before it", async () => {
    const first = await addRule(w.db, w.alex, { scope: "household", rule: percent(6000) }, TODAY);
    const second = await editRule(w.db, w.sam, first.id, { rule: percent(5500), effectiveFrom: "2027-01-01" }, TODAY);
    expect(second.supersedesId).toBe(first.id);
    expect((await row(first.id)).status).toBe("active");
    expect(await on("2026-12-31")).toMatchObject({ rule: percent(6000) });
    expect(await on("2027-01-01")).toMatchObject({ rule: percent(5500) });
    const [entry] = await recentAudit(w.db, w.householdId, 1);
    expect(entry).toMatchObject({ action: "split_rule.changed", entityId: second.id, detail: { supersedesId: first.id } });
  });

  it("from the same date or an earlier one replaces it, and keeps the row", async () => {
    const first = await addRule(w.db, w.alex, { scope: "household", rule: percent(6000), effectiveFrom: "2026-09-01" }, TODAY);
    const later = await editRule(w.db, w.alex, first.id, { rule: percent(5500), effectiveFrom: "2027-01-01" }, TODAY);
    const redo = await editRule(w.db, w.sam, later.id, { rule: percent(7000), effectiveFrom: "2026-09-01" }, TODAY);
    expect(await row(first.id)).toMatchObject({ status: "void", replacedBy: redo.id, voidedBy: w.sam.id });
    expect(await row(later.id)).toMatchObject({ status: "void", replacedBy: redo.id });
    expect(await on("2026-09-01")).toMatchObject({ rule: percent(7000), ruleId: redo.id });
    expect(await on("2027-06-01")).toMatchObject({ rule: percent(7000) });
    const [entry] = await recentAudit(w.db, w.householdId, 1);
    expect(entry!.detail).toEqual({ effectiveFrom: "2026-09-01", supersedesId: later.id, replacedIds: expect.arrayContaining([first.id, later.id]) });
  });

  it("lets the last save win a same-date tie", async () => {
    const first = await addRule(w.db, w.alex, { scope: "household", rule: percent(6000) }, TODAY);
    // Added again for the same target: a change, not a second rule.
    const again = await addRule(w.db, w.sam, { scope: "household", rule: percent(5000) }, TODAY);
    expect(again.supersedesId).toBe(first.id);
    expect(await on(TODAY)).toMatchObject({ ruleId: again.id });
  });

  it("refuses a rule that has been changed or removed since", async () => {
    const first = await addRule(w.db, w.alex, { scope: "household", rule: percent(6000) }, TODAY);
    await editRule(w.db, w.alex, first.id, { rule: percent(5000) }, TODAY);
    await expect(editRule(w.db, w.sam, first.id, { rule: percent(7000) }, TODAY)).rejects.toThrow("changed or removed since");
    await expect(editRule(w.db, w.sam, "not-an-id", { rule: percent(7000) }, TODAY)).rejects.toThrow("does not exist");
  });

  it("refuses an edit of a rule removed in the meantime, and does not add it back", async () => {
    const first = await addRule(w.db, w.alex, { scope: "household", rule: percent(6000) }, TODAY);
    await removeRule(w.db, w.alex, first.id, TODAY);
    await expect(editRule(w.db, w.sam, first.id, { rule: percent(5000) }, TODAY)).rejects.toThrow("that rule has been changed or removed since");
    expect(await listRules(w.db, w.householdId)).toEqual([]);
  });

  it("lets only one of a removal and an edit of the same rule through", async () => {
    const first = await addRule(w.db, w.alex, { scope: "household", rule: percent(6000) }, TODAY);
    const results = await Promise.allSettled([
      removeRule(w.db, w.alex, first.id, TODAY),
      editRule(w.db, w.sam, first.id, { rule: percent(5000) }, TODAY),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason.message).toBe("that rule has been changed or removed since");
  });
});

describe("removing a rule", () => {
  it("removes only an upcoming row, leaving the rule in force today", async () => {
    const current = await addRule(w.db, w.alex, { scope: "household", rule: percent(6000), effectiveFrom: "2026-01-01" }, TODAY);
    const upcoming = await editRule(w.db, w.alex, current.id, { rule: percent(5000), effectiveFrom: "2027-01-01" }, TODAY);
    await removeRule(w.db, w.sam, upcoming.id, TODAY);
    expect(await row(upcoming.id)).toMatchObject({ status: "void", voidedBy: w.sam.id, replacedBy: null });
    expect(await row(current.id)).toMatchObject({ status: "active" });
    expect(await on("2026-12-01")).toMatchObject({ rule: percent(6000), ruleId: current.id });
    expect(await on("2027-06-01")).toMatchObject({ rule: percent(6000), ruleId: current.id });
    const [entry] = await recentAudit(w.db, w.householdId, 1);
    expect(entry).toMatchObject({ action: "split_rule.removed", entityType: "split_rule", entityId: upcoming.id, detail: { ruleIds: [upcoming.id] } });
  });

  it("removes the current row with every earlier one, so no older rule comes back, and leaves upcoming ones", async () => {
    await addRule(w.db, w.alex, { scope: "household", rule: percent(6000), effectiveFrom: "2026-01-01" }, TODAY);
    const older = await addRule(w.db, w.alex, { scope: "category", category: "housing", rule: percent(7000), effectiveFrom: "2026-01-01" }, TODAY);
    const current = await editRule(w.db, w.alex, older.id, { rule: percent(7500), effectiveFrom: "2026-06-01" }, TODAY);
    const upcoming = await editRule(w.db, w.alex, current.id, { rule: percent(8000), effectiveFrom: "2027-01-01" }, TODAY);
    await removeRule(w.db, w.sam, current.id, TODAY);

    for (const id of [older.id, current.id]) expect(await row(id)).toMatchObject({ status: "void", voidedBy: w.sam.id, replacedBy: null });
    expect(await row(upcoming.id)).toMatchObject({ status: "active" });
    expect(await on("2026-03-01", { category: "housing" })).toMatchObject({ source: "household", rule: percent(6000) });
    expect(await on("2026-12-01", { category: "housing" })).toMatchObject({ source: "household" });
    expect(await on("2027-01-01", { category: "housing" })).toMatchObject({ source: "category", ruleId: upcoming.id });
    const [entry] = await recentAudit(w.db, w.householdId, 1);
    expect(entry).toMatchObject({ action: "split_rule.removed", entityId: current.id });
    expect(entry!.detail).toEqual({ ruleIds: expect.arrayContaining([older.id, current.id]) });
    expect((entry!.detail as { ruleIds: string[] }).ruleIds).toHaveLength(2);
  });

  it("refuses a rule that is already gone", async () => {
    const first = await addRule(w.db, w.alex, { scope: "household", rule: percent(6000) }, TODAY);
    await removeRule(w.db, w.alex, first.id, TODAY);
    await expect(removeRule(w.db, w.alex, first.id, TODAY)).rejects.toThrow("changed or removed since");
  });
});

describe("rule history", () => {
  it("says where each rule stands today", async () => {
    const old = await addRule(w.db, w.alex, { scope: "household", rule: percent(6000), effectiveFrom: "2026-01-01" }, TODAY);
    const now = await editRule(w.db, w.alex, old.id, { rule: percent(5500), effectiveFrom: "2026-06-01" }, TODAY);
    const next = await editRule(w.db, w.alex, now.id, { rule: percent(5000), effectiveFrom: "2027-01-01" }, TODAY);
    const cat = await addRule(w.db, w.alex, { scope: "category", category: "housing", rule: percent(7000) }, TODAY);
    const redo = await editRule(w.db, w.alex, cat.id, { rule: percent(7500) }, TODAY);
    const gone = await addRule(w.db, w.alex, { scope: "category", category: "groceries", rule: percent(8000) }, TODAY);
    await removeRule(w.db, w.alex, gone.id, TODAY);

    const states = new Map((await listRuleHistory(w.db, w.householdId, TODAY)).map((r) => [r.id, r.state]));
    expect(Object.fromEntries([old, now, next, cat, redo, gone].map((r) => [r.id, states.get(r.id)]))).toEqual({
      [old.id]: "earlier",
      [now.id]: "current",
      [next.id]: "upcoming",
      [cat.id]: "replaced",
      [redo.id]: "current",
      [gone.id]: "removed",
    });
  });
});

describe("the database", () => {
  it("rejects a rule that names more than one scope", async () => {
    const template = await rent();
    await expect(
      w.db.insert(splitRule).values({
        householdId: w.householdId,
        scope: "template",
        templateLineageId: template.lineageId,
        category: "housing",
        rule: { kind: "even" },
        effectiveFrom: "2026-10-01",
        createdBy: w.alex.id,
      }),
    ).rejects.toThrow();
  });
});

describe("migration 0021", () => {
  // The data steps at the end of the migration, run again over rows made the
  // way the old change-set code made them.
  const dataSteps = readFileSync("./drizzle/0021_plain_rules.sql", "utf8")
    .split("--> statement-breakpoint")
    .filter((s) => !s.trim().startsWith("ALTER"));
  const runDataSteps = async () => {
    for (const step of dataSteps) await w.db.execute(sql.raw(step));
  };
  // The old code dated every rule in a set with the set's own date.
  const openSet = async (acceptedBy: string[], rule: Rule = { kind: "even" }) => {
    const [set] = await w.db.insert(changeSet).values({ householdId: w.householdId, effectiveFrom: "2026-09-01", createdBy: w.alex.id }).returning();
    for (const memberId of acceptedBy) await w.db.insert(changeSetAcceptance).values({ householdId: w.householdId, changeSetId: set!.id, memberId });
    const [row] = await w.db
      .insert(splitRule)
      .values({ householdId: w.householdId, scope: "household", rule, effectiveFrom: set!.effectiveFrom, changeSetId: set!.id, createdBy: w.alex.id })
      .returning();
    return { set: set!, rule: row! };
  };
  const auditFor = async (setId: string) =>
    (await w.db.select().from(auditLog).where(eq(auditLog.entityId, setId))).map((e) => ({
      action: e.action,
      actorKind: e.actorKind,
      actorMemberId: e.actorMemberId,
      entityType: e.entityType,
      detail: e.detail,
    }));
  const proposedIncome = (changeSetId: string, ownerId: string, createdBy: string) =>
    w.db
      .insert(income)
      .values({ householdId: w.householdId, ownerId, annualCents: 50000_00, shareMode: "amount", createdBy, changeSetId })
      .returning()
      .then((r) => r[0]!);
  const setOf = async (id: string) => (await w.db.select().from(changeSet).where(eq(changeSet.id, id)))[0]!;
  const incomeOf = async (id: string) => (await w.db.select().from(income).where(eq(income.id, id)))[0]!;

  it("puts into force a set that waits only for someone who has not joined, from its rules' own dates", async () => {
    w = await createWorld({ samJoined: false });
    const { set, rule } = await openSet([w.alex.id]);
    const alexOwn = await proposedIncome(set.id, w.alex.id, w.alex.id);
    const forSam = await proposedIncome(set.id, w.sam.id, w.alex.id);
    await runDataSteps();

    expect(await setOf(set.id)).toMatchObject({ status: "accepted" });
    expect((await setOf(set.id)).closedAt).not.toBeNull();
    expect(await row(rule.id)).toMatchObject({ status: "active", effectiveFrom: "2026-09-01" });
    expect((await row(rule.id)).activatedAt).not.toBeNull();
    expect(await incomeOf(alexOwn.id)).toMatchObject({ status: "active", effectiveFrom: "2026-09-01" });
    expect(await incomeOf(forSam.id)).toMatchObject({ status: "active" });
    expect(await on("2026-09-01")).toMatchObject({ ruleId: rule.id });
    expect(await on("2026-08-31")).toMatchObject({ source: "default" });
    expect(await auditFor(set.id)).toEqual([
      {
        action: "change_set.activated",
        actorKind: "member",
        actorMemberId: w.alex.id,
        entityType: "change_set",
        detail: {
          by: "migration 0021",
          effectiveFrom: "2026-09-01",
          ruleIds: [rule.id],
          incomeIds: expect.arrayContaining([alexOwn.id, forSam.id]),
        },
      },
    ]);
  });

  it("puts into force a set that splits by income, from its own date", async () => {
    w = await createWorld({ samJoined: false });
    const { set, rule } = await openSet([w.alex.id], { kind: "income_proportional" });
    const alexOwn = await proposedIncome(set.id, w.alex.id, w.alex.id);
    const forSam = await proposedIncome(set.id, w.sam.id, w.alex.id);
    await runDataSteps();

    expect(await row(rule.id)).toMatchObject({ status: "active", effectiveFrom: "2026-09-01" });
    for (const id of [alexOwn.id, forSam.id]) expect(await incomeOf(id)).toMatchObject({ status: "active", effectiveFrom: "2026-09-01" });
    const expenseOn = await createExpense(w.db, w.householdId, {
      kind: "manual",
      actor: w.alex,
      today: TODAY,
      description: "Groceries",
      category: "groceries",
      totalCents: 10000,
      date: "2026-09-10",
      payerId: w.alex.id,
    });
    expect(expenseOn.shares).toEqual({ [w.alex.id]: 5000, [w.sam.id]: 5000 });
    expect(expenseOn.computation).toMatchObject({ ruleId: rule.id });
  });

  it("puts into force a by-income set even when an income is missing, leaving the expense to fix", async () => {
    w = await createWorld({ samJoined: false });
    const { set, rule } = await openSet([w.alex.id], { kind: "income_proportional" });
    await proposedIncome(set.id, w.alex.id, w.alex.id);
    await runDataSteps();

    expect(await row(rule.id)).toMatchObject({ status: "active" });
    const unsplit = await createExpense(w.db, w.householdId, {
      kind: "manual",
      actor: w.alex,
      today: TODAY,
      description: "Groceries",
      category: "groceries",
      totalCents: 10000,
      date: "2026-09-10",
      payerId: w.alex.id,
    });
    expect(unsplit.status).toBe("unassigned");
  });

  it("withdraws a set waiting for someone who has joined, with its rules and incomes", async () => {
    const { set, rule } = await openSet([w.alex.id]);
    const alexOwn = await proposedIncome(set.id, w.alex.id, w.alex.id);
    await runDataSteps();

    expect(await setOf(set.id)).toMatchObject({ status: "withdrawn" });
    expect(await row(rule.id)).toMatchObject({ status: "withdrawn" });
    expect(await incomeOf(alexOwn.id)).toMatchObject({ status: "withdrawn" });
    expect(await on("2026-09-01")).toMatchObject({ source: "default" });
    expect(await auditFor(set.id)).toEqual([
      {
        action: "change_set.withdrawn",
        actorKind: "member",
        actorMemberId: w.alex.id,
        entityType: "change_set",
        detail: { by: "migration 0021", ruleIds: [rule.id], incomeIds: [alexOwn.id] },
      },
    ]);
  });

  it("withdraws an income in a free set that was typed for someone who has joined", async () => {
    // Everyone who has joined has accepted, but Sam's income was typed by Alex.
    const { set, rule } = await openSet([w.alex.id, w.sam.id]);
    const bySomeoneElse = await proposedIncome(set.id, w.sam.id, w.alex.id);
    await runDataSteps();

    expect(await setOf(set.id)).toMatchObject({ status: "accepted" });
    expect(await row(rule.id)).toMatchObject({ status: "active" });
    expect(await incomeOf(bySomeoneElse.id)).toMatchObject({ status: "withdrawn" });
  });

  it("leaves accepted sets and active rules alone", async () => {
    const [kept] = await agree(w, "2026-10-01", { rules: [{ scope: "household", rule: percent(6000) }] });
    await runDataSteps();
    expect(await row(kept!.id)).toMatchObject({ status: "active" });
  });
});
