import { beforeEach, describe, expect, it } from "vitest";
import type { Member } from "@/db/schema";
import { createTestDb, seedHousehold } from "@/db/test-db";
import type { Db } from "@/db/types";
import { recentAudit } from "./audit";
import { createTemplate, describeSchedule, editTemplate, endTemplate, listTemplates, templatesDue } from "./templates";

let db: Db;
let householdId: string;
let alex: Member;
let sam: Member;

beforeEach(async () => {
  db = await createTestDb();
  const seeded = await seedHousehold(db);
  householdId = seeded.household.id;
  alex = seeded.alex;
  sam = seeded.sam;
});

const rent = () => ({
  name: "Rent",
  category: "housing",
  amountCents: 200000,
  cadence: "monthly" as const,
  dayOfMonth: 1,
  payerId: alex.id,
  startDate: "2026-10-01",
});

async function due(period: string) {
  const rows = await templatesDue(db, householdId, period);
  return rows.map((d) => ({ name: d.template.name, date: d.date, period: d.period, cents: d.template.amountCents }));
}

describe("a recurring cost's category", () => {
  it("comes from the fixed list, and is other when none is given", async () => {
    expect((await createTemplate(db, alex, { ...rent(), category: undefined })).category).toBe("other");
    await expect(createTemplate(db, alex, { ...rent(), category: "rent stuff" })).rejects.toThrow(
      "choose a category from the list",
    );
  });
});

describe("describeSchedule", () => {
  it("names the months a cost falls in", () => {
    expect(describeSchedule({ cadence: "monthly", dayOfMonth: 1, monthOfYear: null })).toBe("day 1 of each month");
    expect(describeSchedule({ cadence: "quarterly", dayOfMonth: 10, monthOfYear: 5 })).toBe(
      "day 10 of February, May, August and November",
    );
    expect(describeSchedule({ cadence: "half_yearly", dayOfMonth: 1, monthOfYear: 9 })).toBe("day 1 of March and September");
    expect(describeSchedule({ cadence: "yearly", dayOfMonth: 20, monthOfYear: 3 })).toBe("March 20, each year");
  });
});

describe("templatesDue", () => {
  it("returns a monthly cost on its day in each month from its start", async () => {
    await createTemplate(db, alex, rent());
    expect(await due("2026-10")).toEqual([{ name: "Rent", date: "2026-10-01", period: "2026-10", cents: 200000 }]);
    expect(await due("2026-11")).toEqual([{ name: "Rent", date: "2026-11-01", period: "2026-11", cents: 200000 }]);
    expect(await due("2026-09")).toEqual([]);
  });

  it("skips the first month when the start date falls after that month's due day", async () => {
    await createTemplate(db, alex, { ...rent(), dayOfMonth: 5, startDate: "2026-10-10" });
    expect(await due("2026-10")).toEqual([]);
    expect((await due("2026-11")).map((d) => d.date)).toEqual(["2026-11-05"]);
  });

  it("stops after the end date, counting a due day on the end date itself", async () => {
    await createTemplate(db, alex, { ...rent(), dayOfMonth: 15, endDate: "2026-12-15" });
    expect((await due("2026-12")).map((d) => d.date)).toEqual(["2026-12-15"]);
    expect(await due("2027-01")).toEqual([]);
  });

  it("moves day 31 to the last day of a shorter month", async () => {
    await createTemplate(db, alex, { ...rent(), dayOfMonth: 31 });
    expect((await due("2026-11")).map((d) => d.date)).toEqual(["2026-11-30"]);
    expect((await due("2027-02")).map((d) => d.date)).toEqual(["2027-02-28"]);
    expect((await due("2028-02")).map((d) => d.date)).toEqual(["2028-02-29"]);
    expect((await due("2026-12")).map((d) => d.date)).toEqual(["2026-12-31"]);
  });

  it("returns a yearly cost once, in its month, with the year as its period", async () => {
    await createTemplate(db, alex, {
      ...rent(),
      name: "Insurance",
      cadence: "yearly",
      monthOfYear: 3,
      dayOfMonth: 20,
      startDate: "2026-10-01",
    });
    expect(await due("2026-10")).toEqual([]);
    expect(await due("2027-03")).toEqual([{ name: "Insurance", date: "2027-03-20", period: "2027", cents: 200000 }]);
    expect(await due("2027-04")).toEqual([]);
  });

  it("returns a cost every 3 months in each month counted from the one it falls in", async () => {
    await createTemplate(db, alex, { ...rent(), name: "Water", cadence: "quarterly", monthOfYear: 2, dayOfMonth: 10 });
    const months = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-05", "2027-08"];
    const hits = [];
    for (const m of months) hits.push(...(await due(m)).map((d) => [d.date, d.period]));
    expect(hits).toEqual([
      ["2026-11-10", "2026-11"],
      ["2027-02-10", "2027-02"],
      ["2027-05-10", "2027-05"],
      ["2027-08-10", "2027-08"],
    ]);
  });

  it("returns a cost every 6 months twice a year", async () => {
    await createTemplate(db, alex, { ...rent(), name: "Car insurance", cadence: "half_yearly", monthOfYear: 9, dayOfMonth: 1 });
    expect((await due("2027-03")).map((d) => d.period)).toEqual(["2027-03"]);
    expect(await due("2027-06")).toEqual([]);
    expect((await due("2027-09")).map((d) => d.period)).toEqual(["2027-09"]);
  });

  it("needs the month a cost every few months falls in", async () => {
    await expect(createTemplate(db, alex, { ...rent(), cadence: "quarterly" })).rejects.toThrow("the month it falls in");
  });

  it("uses the amount in force on each due date after a dated change", async () => {
    const created = await createTemplate(db, alex, rent());
    await editTemplate(db, sam, created.lineageId, { amountCents: 210000 }, "2027-01-01", "2026-10-02");
    expect((await due("2026-12")).map((d) => d.cents)).toEqual([200000]);
    expect((await due("2027-01")).map((d) => d.cents)).toEqual([210000]);
  });

  it("keeps a variable cost's amount empty", async () => {
    await createTemplate(db, alex, { ...rent(), name: "Electricity", amountCents: null, dayOfMonth: 20 });
    expect(await due("2026-10")).toEqual([{ name: "Electricity", date: "2026-10-20", period: "2026-10", cents: null }]);
  });

  it("only returns this household's costs", async () => {
    await createTemplate(db, alex, rent());
    const other = await seedOther();
    expect(await templatesDue(db, other, "2026-10")).toEqual([]);
  });
});

async function seedOther(): Promise<string> {
  const { household } = await import("@/db/schema");
  const [h] = await db.insert(household).values({ name: "Other" }).returning();
  return h!.id;
}

describe("editing a recurring cost", () => {
  it("refuses a change dated before today", async () => {
    const created = await createTemplate(db, alex, rent());
    await expect(
      editTemplate(db, alex, created.lineageId, { amountCents: 1 }, "2026-10-01", "2026-10-02"),
    ).rejects.toThrow(/earlier than today/);
  });

  it("refuses a payer from outside the household", async () => {
    await expect(
      createTemplate(db, alex, { ...rent(), payerId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow(/payer/);
  });

  it("lists each cost once, as it stands today, with any upcoming change", async () => {
    const created = await createTemplate(db, alex, rent());
    await editTemplate(db, alex, created.lineageId, { amountCents: 210000 }, "2027-01-01", "2026-10-02");
    const list = await listTemplates(db, householdId, "2026-10-02");
    expect(list).toHaveLength(1);
    expect(list[0]!.current?.amountCents).toBe(200000);
    expect(list[0]!.upcoming?.amountCents).toBe(210000);
    expect(list[0]!.upcoming?.effectiveFrom).toBe("2027-01-01");
  });

  it("ending a cost stops it after the end date and keeps earlier months", async () => {
    const created = await createTemplate(db, alex, rent());
    await endTemplate(db, alex, created.lineageId, "2026-12-31", "2026-11-10");
    expect((await due("2026-10")).length).toBe(1);
    expect((await due("2026-12")).length).toBe(1);
    expect(await due("2027-01")).toEqual([]);
  });

  it("writes an audit entry for each change", async () => {
    const created = await createTemplate(db, alex, rent());
    await editTemplate(db, sam, created.lineageId, { amountCents: 210000 }, "2027-01-01", "2026-10-02");
    const actions = (await recentAudit(db, householdId, 10)).map((a) => a.action);
    expect(actions).toEqual(["expense_template.changed", "expense_template.created"]);
  });
});
