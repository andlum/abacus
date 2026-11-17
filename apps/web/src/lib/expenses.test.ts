import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { expense, expenseShare, household, member } from "@/db/schema";
import { listAttention } from "./attention";
import { recentAudit } from "./audit";
import { addRule } from "./rules";
import {
  createExpense,
  editExpense,
  enterAmount,
  fixUnassigned,
  getExpense,
  listMonth,
  listRange,
  postDue,
  postEarlier,
  voidExpense,
} from "./expenses";
import { rederive } from "@abacus/core/split";
import { createTemplate, editTemplate } from "./templates";
import { agree, createWorld, type World } from "./testing/world";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

const percent = (alexBp: number) => ({ kind: "percent" as const, bp: { [w.alex.id]: alexBp, [w.sam.id]: 10000 - alexBp } });

const rent = (over: object = {}) =>
  createTemplate(w.db, w.alex, {
    name: "Rent",
    category: "housing",
    amountCents: 200000,
    cadence: "monthly",
    dayOfMonth: 1,
    payerId: w.alex.id,
    startDate: "2026-10-01",
    ...over,
  });

const electricity = () => rent({ name: "Electricity", category: "utilities", amountCents: null, dayOfMonth: 20 });

const dinner = (over: object = {}) =>
  createExpense(w.db, w.householdId, {
    kind: "manual",
    actor: w.sam,
    date: "2026-10-10",
    description: "Dinner",
    category: "dining",
    totalCents: 9000,
    payerId: w.sam.id,
    today: "2026-10-12",
    ...over,
  });

const snapshot = async () => ({
  expenses: await w.db.select().from(expense).orderBy(expense.id),
  shares: await w.db.select().from(expenseShare).orderBy(expenseShare.expenseId, expenseShare.memberId),
});

describe("the database", () => {
  it("rejects a posted expense whose shares do not sum to its total", async () => {
    const insert = w.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(expense)
        .values({
          householdId: w.householdId,
          date: "2026-10-01",
          description: "Broken",
          totalCents: 1000,
          payerId: w.alex.id,
          status: "posted",
          source: "manual",
        })
        .returning();
      await tx.insert(expenseShare).values([
        { expenseId: row!.id, memberId: w.alex.id, householdId: w.householdId, shareCents: 500 },
        { expenseId: row!.id, memberId: w.sam.id, householdId: w.householdId, shareCents: 499 },
      ]);
    });
    await expect(insert).rejects.toThrow();
    expect(await w.db.select().from(expense)).toEqual([]);
  });
});

describe("postDue", () => {
  it("posts a fixed recurring cost on its due date, split evenly when no rule is agreed", async () => {
    await rent();
    expect(await postDue(w.db, w.householdId, "2026-09-30")).toEqual([]);
    const [posted] = await postDue(w.db, w.householdId, "2026-10-01");
    expect(posted).toMatchObject({
      status: "posted",
      source: "template",
      date: "2026-10-01",
      period: "2026-10",
      description: "Rent",
      totalCents: 200000,
      payerId: w.alex.id,
      ruleSource: "default",
      shares: { [w.alex.id]: 100000, [w.sam.id]: 100000 },
    });
  });

  it("changes nothing when run again", async () => {
    await rent();
    await postDue(w.db, w.householdId, "2026-10-01");
    expect(await postDue(w.db, w.householdId, "2026-10-01")).toEqual([]);
    expect(await listMonth(w.db, w.householdId, "2026-10")).toHaveLength(1);
  });

  it("catches up on missed periods, each with its own date", async () => {
    await rent();
    const posted = await postDue(w.db, w.householdId, "2026-12-15");
    expect(posted.map((e) => [e.period, e.date])).toEqual([
      ["2026-10", "2026-10-01"],
      ["2026-11", "2026-11-01"],
      ["2026-12", "2026-12-01"],
    ]);
  });

  it("uses the agreed rule and stores where it came from", async () => {
    const t = await rent();
    await agree(w, "2026-10-01", { rules: [{ scope: "template", templateLineageId: t.lineageId, rule: percent(6000) }] });
    const [posted] = await postDue(w.db, w.householdId, "2026-10-01");
    expect(posted!.shares).toEqual({ [w.alex.id]: 120000, [w.sam.id]: 80000 });
    expect(posted!.ruleSource).toBe("template");
    expect(posted!.computation?.rulesAsOf).toBe("2026-10-01");
  });

  it("stores a computation from which the shares can be re-derived, seeded by the cost and period", async () => {
    const t = await rent({ amountCents: 200001 });
    const [posted] = await postDue(w.db, w.householdId, "2026-10-01");
    expect(posted!.computation!.seed).toBe(`${t.lineageId}:2026-10`);
    expect(rederive(posted!.computation!)).toEqual(posted!.shares);
    const stored = await getExpense(w.db, w.householdId, posted!.id);
    expect(stored.shares).toEqual(posted!.shares);
    expect(Object.values(stored.shares).sort()).toEqual([100000, 100001]);
  });

  it("creates a bill waiting for its amount when the cost varies, then posts it once the amount is entered", async () => {
    await electricity();
    const [waiting] = await postDue(w.db, w.householdId, "2026-10-20");
    expect(waiting).toMatchObject({ status: "needs_amount", totalCents: null, shares: {} });

    const posted = await enterAmount(w.db, w.sam, waiting!.id, 12345);
    expect(posted.status).toBe("posted");
    expect(Object.values(posted.shares).sort()).toEqual([6172, 6173]);
    expect(await postDue(w.db, w.householdId, "2026-10-20")).toEqual([]);
  });

  it("does not re-create an expense that was voided", async () => {
    await rent();
    const [posted] = await postDue(w.db, w.householdId, "2026-10-01");
    await voidExpense(w.db, w.alex, posted!.id);
    expect(await postDue(w.db, w.householdId, "2026-10-02")).toEqual([]);
  });

  it("uses the amount in force on the due date", async () => {
    const t = await rent();
    await editTemplate(w.db, w.alex, t.lineageId, { amountCents: 210000 }, "2026-11-01", "2026-10-02");
    const posted = await postDue(w.db, w.householdId, "2026-11-01");
    expect(posted.map((e) => e.totalCents)).toEqual([200000, 210000]);
  });

  it("audits each expense it creates as the system", async () => {
    await rent();
    await postDue(w.db, w.householdId, "2026-10-01");
    const [entry] = await recentAudit(w.db, w.householdId, 1);
    expect(entry).toMatchObject({ action: "expense.posted", actorKind: "system" });
  });
});

describe("entering a recurring cost for a month before it started", () => {
  const lateRent = () => rent({ startDate: "2026-11-10" });

  it("posts it on that month's due day, linked to the cost and split by the rules of that day", async () => {
    const t = await lateRent();
    const posted = await postEarlier(w.db, w.sam, t.lineageId, "2026-11", "2026-11-10");
    expect(posted).toMatchObject({
      status: "posted",
      source: "template",
      templateLineageId: t.lineageId,
      period: "2026-11",
      date: "2026-11-01",
      totalCents: 200000,
      createdBy: w.sam.id,
      shares: { [w.alex.id]: 100000, [w.sam.id]: 100000 },
    });
    expect(posted.computation?.rulesAsOf).toBe("2026-11-01");
    const [entry] = await recentAudit(w.db, w.householdId, 1);
    expect(entry).toMatchObject({ action: "expense.posted", actorKind: "member" });
  });

  it("leaves a bill waiting for its amount when the cost varies", async () => {
    const t = await rent({ name: "Electricity", category: "utilities", amountCents: null, dayOfMonth: 5, startDate: "2026-11-10" });
    const waiting = await postEarlier(w.db, w.alex, t.lineageId, "2026-11", "2026-11-10");
    expect(waiting).toMatchObject({ status: "needs_amount", date: "2026-11-05", period: "2026-11" });
    expect((await listAttention(w.db, w.householdId, "2026-11-10")).needsAmount).toHaveLength(1);
  });

  it("refuses a month that is already entered", async () => {
    const t = await lateRent();
    await postEarlier(w.db, w.alex, t.lineageId, "2026-10", "2026-11-10");
    await expect(postEarlier(w.db, w.alex, t.lineageId, "2026-10", "2026-11-10")).rejects.toThrow(/already entered/);
  });

  it("refuses a month the cost enters by itself, and one it does not fall due in", async () => {
    const t = await lateRent();
    await expect(postEarlier(w.db, w.alex, t.lineageId, "2026-12", "2026-12-15")).rejects.toThrow(/by itself/);
    const q = await rent({ name: "Water", cadence: "quarterly", monthOfYear: 1, startDate: "2026-11-10" });
    await expect(postEarlier(w.db, w.alex, q.lineageId, "2026-09", "2026-11-10")).rejects.toThrow(/not fall due/);
    expect((await postEarlier(w.db, w.alex, q.lineageId, "2026-10", "2026-11-10")).date).toBe("2026-10-01");
  });

  it("does not stop later months from entering themselves", async () => {
    const t = await lateRent();
    await postEarlier(w.db, w.alex, t.lineageId, "2026-11", "2026-11-10");
    const posted = await postDue(w.db, w.householdId, "2026-12-01");
    expect(posted.map((e) => e.period)).toEqual(["2026-12"]);
  });

  it("cannot be reached from another household", async () => {
    const t = await lateRent();
    const other = await createWorld();
    await expect(postEarlier(w.db, { ...other.alex }, t.lineageId, "2026-11", "2026-11-10")).rejects.toThrow(/does not exist/);
  });
});

describe("splitting by income", () => {
  const byIncome = [{ scope: "household" as const, rule: { kind: "income_proportional" as const } }];

  it("uses the incomes in force and records their ids, not their amounts", async () => {
    await rent();
    await agree(w, "2026-10-01", { incomes: { alex: 9000000, sam: 6000000 }, rules: byIncome });
    const [posted] = await postDue(w.db, w.householdId, "2026-10-01");
    expect(posted!.shares).toEqual({ [w.alex.id]: 120000, [w.sam.id]: 80000 });
    expect(posted!.computation!.ratioBp).toEqual({ [w.alex.id]: 6000, [w.sam.id]: 4000 });
    expect(Object.keys(posted!.computation!.incomeIds!).sort()).toEqual([w.alex.id, w.sam.id].sort());
    expect(JSON.stringify(posted)).not.toMatch(/9000000|6000000/);
  });

  it("leaves an expense unassigned, with the reason, when an income is missing on its date", async () => {
    // The rule and incomes start in November; a hand-picked income split in October has nothing to use.
    await agree(w, "2026-11-01", { incomes: { alex: 9000000, sam: 6000000 }, rules: byIncome }, "2026-10-01");
    const row = await dinner({ rule: { kind: "income_proportional" } });
    expect(row).toMatchObject({ status: "unassigned", unassignedReason: "income_missing", shares: {} });
  });
});

describe("rule changes apply going forward only", () => {
  it("leaves every earlier expense exactly as it was when a rule is added", async () => {
    await rent();
    await electricity();
    const [, bill] = await postDue(w.db, w.householdId, "2026-10-25");
    await enterAmount(w.db, w.alex, bill!.id, 8000);
    await dinner();
    const before = await snapshot();
    expect(before.expenses).toHaveLength(3);

    await agree(
      w,
      "2026-10-26",
      { incomes: { alex: 9000000, sam: 6000000 }, rules: [{ scope: "household", rule: { kind: "income_proportional" } }] },
      "2026-10-26",
    );
    await postDue(w.db, w.householdId, "2026-10-31");
    expect(await snapshot()).toEqual(before);
  });

  it("leaves expenses already posted unchanged when a rule is added with an earlier date", async () => {
    await rent();
    const [october] = await postDue(w.db, w.householdId, "2026-10-01");
    expect(october!.shares[w.alex.id]).toBe(100000);

    await addRule(w.db, w.sam, { scope: "household", rule: percent(7000), effectiveFrom: "2026-10-01" }, "2026-10-20");
    const unchanged = await getExpense(w.db, w.householdId, october!.id);
    expect(unchanged.shares[w.alex.id]).toBe(100000);

    const [november] = await postDue(w.db, w.householdId, "2026-11-01");
    expect(november!.shares[w.alex.id]).toBe(140000);
  });
});

describe("a one-off expense", () => {
  it("splits 50/50 when no rule covers it, and says so", async () => {
    const row = await dinner();
    expect(row).toMatchObject({
      status: "posted",
      source: "manual",
      ruleSource: "default",
      shares: { [w.alex.id]: 4500, [w.sam.id]: 4500 },
      createdBy: w.sam.id,
    });
  });

  it("uses the agreed rule for its category on its date", async () => {
    await agree(w, "2026-10-01", { rules: [{ scope: "category", category: "dining", rule: percent(7000) }] });
    expect((await dinner()).shares).toEqual({ [w.alex.id]: 6300, [w.sam.id]: 2700 });
    expect((await dinner({ date: "2026-09-30" })).ruleSource).toBe("default");
  });

  it("can be split by hand instead, and records who chose", async () => {
    const row = await dinner({ rule: percent(10000) });
    expect(row.shares).toEqual({ [w.alex.id]: 9000, [w.sam.id]: 0 });
    expect(row.ruleSource).toBe("entry");
    expect(row.computation!.chosenBy).toBe(w.sam.id);
  });

  it("gives a leftover cent to exactly one person and can be re-derived", async () => {
    const row = await dinner({ totalCents: 9001 });
    expect(Object.values(row.shares).sort()).toEqual([4500, 4501]);
    expect(rederive(row.computation!)).toEqual(row.shares);
  });

  it("refuses a date later than today, a zero amount, and a payer from elsewhere", async () => {
    await expect(dinner({ date: "2026-10-13" })).rejects.toThrow(/later than today/);
    await expect(dinner({ totalCents: 0 })).rejects.toThrow(/amount/);
    await expect(dinner({ payerId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/payer/);
  });

  it("can be voided, once", async () => {
    const row = await dinner();
    await voidExpense(w.db, w.alex, row.id);
    expect((await getExpense(w.db, w.householdId, row.id)).status).toBe("void");
    await expect(voidExpense(w.db, w.alex, row.id)).rejects.toThrow(/void/);
  });

  it("takes a category from the fixed list, and files it under other when none is given", async () => {
    expect((await dinner({ category: " Dining " })).category).toBe("dining");
    expect((await dinner({ category: undefined })).category).toBe("other");
    await expect(dinner({ category: "eating out" })).rejects.toThrow("choose a category from the list");
  });

  it("is edited by superseding it with a new expense that points back", async () => {
    const row = await dinner();
    const edited = await editExpense(
      w.db,
      w.alex,
      row.id,
      { date: "2026-10-10", description: "Dinner out", category: "dining", totalCents: 9500, payerId: w.sam.id },
      "2026-10-12",
    );
    expect(edited).toMatchObject({ status: "posted", supersedesId: row.id, totalCents: 9500 });
    expect((await getExpense(w.db, w.householdId, row.id)).status).toBe("superseded");
    await expect(
      editExpense(
        w.db,
        w.alex,
        row.id,
        { date: "2026-10-10", description: "Again", totalCents: 1, payerId: w.sam.id },
        "2026-10-12",
      ),
    ).rejects.toThrow(/superseded/);
  });

  it("cannot be reached from another household", async () => {
    const row = await dinner();
    const [elsewhere] = await w.db.insert(household).values({ name: "Other household" }).returning();
    const [pat] = await w.db
      .insert(member)
      .values({ householdId: elsewhere!.id, email: "pat@example.com", displayName: "Pat" })
      .returning();
    await expect(getExpense(w.db, elsewhere!.id, row.id)).rejects.toThrow(/does not exist/);
    await expect(voidExpense(w.db, pat!, row.id)).rejects.toThrow(/does not exist/);
  });
});

describe("expenses in a date range", () => {
  it("includes both ends, in date order, and leaves out proposals and rejections as the month does", async () => {
    const a = await dinner({ date: "2026-10-01" });
    const b = await dinner({ date: "2026-10-05" });
    await dinner({ date: "2026-09-30" });
    await dinner({ date: "2026-10-06" });
    await w.db.update(expense).set({ status: "rejected" }).where(eq(expense.id, b.id));
    const c = await dinner({ date: "2026-10-05", description: "Lunch" });
    await w.db.update(expense).set({ status: "proposed" }).where(eq(expense.id, c.id));
    expect((await listRange(w.db, w.householdId, "2026-10-01", "2026-10-05")).map((e) => e.id)).toEqual([a.id]);
  });

  it("is the same as the month for a whole month", async () => {
    await dinner({ date: "2026-10-31", today: "2026-10-31" });
    await dinner({ date: "2026-10-01" });
    expect(await listRange(w.db, w.householdId, "2026-10-01", "2026-10-31")).toEqual(await listMonth(w.db, w.householdId, "2026-10"));
  });

  it("stops at a limit when given one, oldest first, and the month the same way", async () => {
    const a = await dinner({ date: "2026-10-01" });
    const b = await dinner({ date: "2026-10-02" });
    await dinner({ date: "2026-10-03" });
    expect((await listRange(w.db, w.householdId, "2026-10-01", "2026-10-31", { limit: 2 })).map((e) => e.id)).toEqual([a.id, b.id]);
    expect((await listMonth(w.db, w.householdId, "2026-10", { limit: 2 })).map((e) => e.id)).toEqual([a.id, b.id]);
    expect(await listMonth(w.db, w.householdId, "2026-10")).toHaveLength(3);
  });
});

describe("needs attention", () => {
  it("lists bills waiting for an amount, unassigned expenses, and costs on the default", async () => {
    await rent();
    await electricity();
    await postDue(w.db, w.householdId, "2026-10-20");
    const stuck = await dinner({ rule: { kind: "income_proportional" } });

    const attention = await listAttention(w.db, w.householdId, "2026-10-20");
    expect(attention.needsAmount.map((e) => e.description)).toEqual(["Electricity"]);
    expect(attention.unassigned.map((e) => e.id)).toEqual([stuck.id]);
    expect(attention.onDefault.map((t) => t.name)).toEqual(["Electricity", "Rent"]);
    expect(attention.count).toBe(2);
  });

  it("drops a recurring cost from the default list once a rule covers it", async () => {
    await rent();
    await agree(w, "2026-10-01", { rules: [{ scope: "category", category: "housing", rule: percent(6000) }] });
    expect((await listAttention(w.db, w.householdId, "2026-10-01")).onDefault).toEqual([]);
  });

  it("fixes an unassigned expense with the rules in force on the day it is fixed, and records that day", async () => {
    const stuck = await dinner({ rule: { kind: "income_proportional" } });
    await agree(w, "2026-10-15", { rules: [{ scope: "household", rule: percent(8000) }] });
    const fixed = await fixUnassigned(w.db, w.alex, stuck.id, "2026-10-16");
    expect(fixed.status).toBe("posted");
    expect(fixed.shares).toEqual({ [w.alex.id]: 7200, [w.sam.id]: 1800 });
    expect(fixed.computation!.rulesAsOf).toBe("2026-10-16");
    expect(fixed.ruleSource).toBe("household");
    expect((await listAttention(w.db, w.householdId, "2026-10-16")).unassigned).toEqual([]);
  });

  it("can fix an unassigned expense with a split picked by hand", async () => {
    const stuck = await dinner({ rule: { kind: "income_proportional" } });
    const fixed = await fixUnassigned(w.db, w.sam, stuck.id, "2026-10-12", percent(5000));
    expect(fixed).toMatchObject({ status: "posted", ruleSource: "entry", shares: { [w.alex.id]: 4500, [w.sam.id]: 4500 } });
  });

  it("keeps it unassigned when the shares still cannot be computed", async () => {
    const stuck = await dinner({ rule: { kind: "income_proportional" } });
    await expect(fixUnassigned(w.db, w.sam, stuck.id, "2026-10-12", { kind: "income_proportional" })).rejects.toThrow(
      /still cannot be computed/,
    );
    expect((await getExpense(w.db, w.householdId, stuck.id)).status).toBe("unassigned");
  });
});
