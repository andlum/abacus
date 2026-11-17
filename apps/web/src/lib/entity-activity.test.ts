import { beforeEach, describe, expect, it } from "vitest";
import { seedHousehold } from "@/db/test-db";
import { editSettlement, recordSettlement, voidSettlement } from "./balance";
import { entityActivity } from "./entity-activity";
import { createExpense, editExpense, postDue, voidExpense } from "./expenses";
import { recordIncome, removeIncome, setShareMode } from "./incomes";
import { addRule, editRule, removeRule } from "./rules";
import { createTemplate, editTemplate } from "./templates";
import { createWorld, hideIncomes, type World } from "./testing/world";

const TODAY = "2026-11-13";

// "Alex 60%, Sam 40%", in the order the pages list people: by member id.
const sixtyForty = () =>
  [
    [w.alex, "60%"],
    [w.sam, "40%"],
  ]
    .sort(([a], [b]) => (a as { id: string }).id.localeCompare((b as { id: string }).id))
    .map(([m, p]) => `${(m as { displayName: string }).displayName} ${p}`)
    .join(", ");

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

// What a person reads: the sentence and the changes, oldest first.
const read = async (ref: Parameters<typeof entityActivity>[3], viewer = w.alex, householdId = w.householdId) =>
  (await entityActivity(w.db, householdId, viewer, ref)).map((e) => ({ text: e.text, changes: e.changes }));

const groceries = (date = "2026-11-10", totalCents = 10000) =>
  createExpense(w.db, w.householdId, {
    kind: "manual",
    actor: w.alex,
    description: "Groceries",
    totalCents,
    date,
    payerId: w.alex.id,
    today: TODAY,
  });

const edit = (id: string, over: Partial<Parameters<typeof editExpense>[3]>, actor = w.alex) =>
  editExpense(w.db, actor, id, { date: "2026-11-10", description: "Groceries", totalCents: 10000, payerId: w.alex.id, ...over }, TODAY);

describe("an expense's history", () => {
  it("follows every version, from any of them, oldest first, with what each edit changed", async () => {
    const first = await groceries();
    const second = await edit(first.id, { totalCents: 12000 });
    const third = await edit(second.id, { totalCents: 12000, date: "2026-11-12" }, w.sam);
    await groceries("2026-11-11", 5000); // another expense: not part of it

    const want = [
      { text: "Alex added this expense", changes: [] },
      { text: "Alex edited this expense", changes: ["Amount $100.00 → $120.00"] },
      { text: "Sam edited this expense", changes: ["Date 2026-11-10 → 2026-11-12"] },
    ];
    expect(await read({ type: "expense", id: first.id })).toEqual(want);
    expect(await read({ type: "expense", id: third.id })).toEqual(want);
    const [entry] = await entityActivity(w.db, w.householdId, w.alex, { type: "expense", id: third.id });
    expect(entry).toMatchObject({ who: "Alex" });
    expect(entry!.at).toBeInstanceOf(Date);
  });

  it("names a change of description, payer and split, and a removal", async () => {
    const first = await groceries();
    const second = await edit(first.id, {
      description: "Market",
      payerId: w.sam.id,
      rule: { kind: "percent", bp: { [w.alex.id]: 6000, [w.sam.id]: 4000 } },
    });
    await voidExpense(w.db, w.alex, second.id);
    expect(await read({ type: "expense", id: first.id })).toEqual([
      { text: "Alex added this expense", changes: [] },
      {
        text: "Alex edited this expense",
        changes: ["Description Groceries → Market", "Paid by Alex → Sam", `Split evenly → ${sixtyForty()}`],
      },
      { text: "Alex removed this expense", changes: [] },
    ]);
  });

  it("says Clementine posted a recurring cost on its due date", async () => {
    await createTemplate(w.db, w.alex, { name: "Rent", amountCents: 200000, cadence: "monthly", dayOfMonth: 1, payerId: w.alex.id, startDate: "2026-11-01" });
    const [posted] = await postDue(w.db, w.householdId, TODAY);
    expect(await entityActivity(w.db, w.householdId, w.alex, { type: "expense", id: posted!.id })).toMatchObject([
      { who: "Clementine", text: "Clementine posted this expense", changes: [] },
    ]);
  });

  it("shows nothing for another group, or an id that is not one", async () => {
    const first = await groceries();
    const other = await seedHousehold(w.db);
    expect(await read({ type: "expense", id: first.id }, other.alex, other.household.id)).toEqual([]);
    expect(await read({ type: "expense", id: "not-an-id" })).toEqual([]);
  });
});

describe("a payment's history", () => {
  it("shows it recorded, edited with the old and new amount, and undone", async () => {
    const paid = await recordSettlement(w.db, w.alex, { fromMemberId: w.alex.id, toMemberId: w.sam.id, amountCents: 5000, date: "2026-11-10" }, TODAY);
    const edited = await editSettlement(
      w.db,
      w.sam,
      paid.id,
      { fromMemberId: w.alex.id, toMemberId: w.sam.id, amountCents: 4000, date: "2026-11-10", note: "cash" },
      TODAY,
    );
    await voidSettlement(w.db, w.alex, edited.id);
    expect(await read({ type: "settlement", id: paid.id })).toEqual([
      { text: "Alex recorded this payment", changes: [] },
      { text: "Sam edited this payment", changes: ["Amount $50.00 → $40.00", "Note (none) → cash"] },
      { text: "Alex undid this payment", changes: [] },
    ]);
  });
});

describe("an income's history", () => {
  const samIncome = async () => {
    const first = await recordIncome(w.db, w.sam, { annualCents: 6000000, effectiveFrom: "2026-11-01" }, TODAY);
    const second = await recordIncome(w.db, w.sam, { annualCents: 7000000, effectiveFrom: "2026-12-01" }, TODAY);
    // Hidden, as an owner could before hiding went away.
    await hideIncomes(w, w.sam);
    return { first, second };
  };

  it("shows the owner the amounts that changed", async () => {
    const { first } = await samIncome();
    await recordIncome(w.db, w.alex, { annualCents: 9000000 }, TODAY); // Alex's own: not part of it
    expect(await read({ type: "income", id: first.id }, w.sam)).toEqual([
      { text: "Sam added this income", changes: [] },
      { text: "Sam changed this income", changes: ["Per year $60,000.00 → $70,000.00", "Counts from 2026-11-01 → 2026-12-01"] },
    ]);
  });

  it("hides the amounts from others while the owner keeps them hidden, as Settings does", async () => {
    const { second } = await samIncome();
    expect(await read({ type: "income", id: second.id }, w.alex)).toEqual([
      { text: "Sam added this income", changes: [] },
      { text: "Sam changed this income", changes: ["Counts from 2026-11-01 → 2026-12-01"] },
    ]);
    await setShareMode(w.db, w.sam, second.id, "amount");
    expect((await read({ type: "income", id: second.id }, w.alex)).map((e) => e.changes)).toEqual([
      [],
      ["Per year $60,000.00 → $70,000.00", "Counts from 2026-11-01 → 2026-12-01"],
      [],
    ]);
  });

  it("keeps a hidden amount out of the history when a visible one follows it", async () => {
    await recordIncome(w.db, w.sam, { annualCents: 6000000, effectiveFrom: "2026-11-01" }, TODAY);
    await hideIncomes(w, w.sam);
    const raise = await recordIncome(w.db, w.sam, { annualCents: 7000000, effectiveFrom: "2026-12-01" }, TODAY);
    expect(await read({ type: "income", id: raise.id }, w.alex)).toEqual([
      { text: "Sam added this income", changes: [] },
      { text: "Sam changed this income", changes: ["Counts from 2026-11-01 → 2026-12-01"] },
    ]);
  });

  it("shows a change of sharing and a removal", async () => {
    const { second } = await samIncome();
    await setShareMode(w.db, w.sam, second.id, "amount");
    await removeIncome(w.db, w.sam, w.sam.id);
    expect((await read({ type: "income", id: second.id }, w.alex)).map((e) => e.text)).toEqual([
      "Sam added this income",
      "Sam changed this income",
      "Sam showed the amount of this income",
      "Sam removed this income",
    ]);
  });
});

describe("a split rule's history", () => {
  it("shows it added, changed with the split before and after, and removed", async () => {
    const added = await addRule(w.db, w.alex, { scope: "household", rule: { kind: "even" }, effectiveFrom: "2026-11-01" }, TODAY);
    const changed = await editRule(
      w.db,
      w.sam,
      added.id,
      { rule: { kind: "percent", bp: { [w.alex.id]: 6000, [w.sam.id]: 4000 } }, effectiveFrom: "2026-12-01" },
      TODAY,
    );
    await addRule(w.db, w.alex, { scope: "category", category: "groceries", rule: { kind: "even" } }, TODAY); // another rule
    await removeRule(w.db, w.alex, changed.id, TODAY);
    const want = [
      { text: "Alex added this rule", changes: [] },
      { text: "Sam changed this rule", changes: [`Split evenly → ${sixtyForty()}`, "Counts from 2026-11-01 → 2026-12-01"] },
      { text: "Alex removed this rule", changes: [] },
    ];
    expect(await read({ type: "split_rule", id: added.id })).toEqual(want);
    expect(await read({ type: "split_rule", id: changed.id })).toEqual(want);
  });

  it("keeps a row whose upcoming change was removed and then changed again in one history", async () => {
    const added = await addRule(w.db, w.alex, { scope: "household", rule: { kind: "even" }, effectiveFrom: "2026-11-01" }, TODAY);
    const upcoming = await editRule(w.db, w.alex, added.id, { rule: { kind: "income_proportional" }, effectiveFrom: "2026-12-01" }, TODAY);
    await removeRule(w.db, w.alex, upcoming.id, TODAY);
    // Supersedes the first row again: the chain branches.
    const again = await editRule(w.db, w.alex, added.id, { rule: { kind: "income_proportional" }, effectiveFrom: "2027-01-01" }, TODAY);
    expect((await read({ type: "split_rule", id: again.id })).map((e) => e.text)).toEqual([
      "Alex added this rule",
      "Alex changed this rule",
      "Alex removed this rule",
      "Alex changed this rule",
    ]);
  });
});

describe("a recurring cost's history", () => {
  it("follows its versions by lineage, with what each change did and from when", async () => {
    const rent = await createTemplate(w.db, w.alex, {
      name: "Rent",
      amountCents: 200000,
      cadence: "monthly",
      dayOfMonth: 1,
      payerId: w.alex.id,
      startDate: "2026-11-01",
    });
    await editTemplate(w.db, w.sam, rent.lineageId, { amountCents: 210000, dayOfMonth: 3 }, "2026-12-01", TODAY);
    await editTemplate(w.db, w.alex, rent.lineageId, { endDate: "2027-06-30" }, TODAY, TODAY);
    expect(await read({ type: "expense_template", id: rent.lineageId })).toEqual([
      { text: "Alex set up this recurring cost", changes: [] },
      { text: "Sam changed this recurring cost, from 2026-12-01", changes: ["Amount $2,000.00 → $2,100.00", "Due day 1 of each month → day 3 of each month"] },
      { text: "Alex changed this recurring cost, from 2026-11-13", changes: ["Ends (no end) → 2027-06-30"] },
    ]);
  });
});
