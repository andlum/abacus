import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { changeSet, income } from "@/db/schema";
import { recentAudit } from "./audit";
import { seedHousehold } from "@/db/test-db";
import { createExpense, getExpense } from "./expenses";
import { currentRatio, incomesInForce, listIncomes, recordIncome, removeIncome, setShareMode } from "./incomes";
import { agree, createWorld, hideIncomes, type World } from "./testing/world";

const TODAY = "2026-10-01";
const ALEX = 90000_00;
const SAM = 60000_00;

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

const inForce = async (date: string) => {
  const r = await incomesInForce(w.db, w.householdId, date);
  return r.ok ? r.annualCents : r;
};

describe("adding an income", () => {
  it("counts at once, from today unless another date is given", async () => {
    const row = await recordIncome(w.db, w.alex, { annualCents: ALEX }, TODAY);
    expect(row).toMatchObject({ status: "active", effectiveFrom: TODAY, supersedesId: null });
    expect(row.activatedAt).not.toBeNull();
    await recordIncome(w.db, w.sam, { annualCents: SAM, effectiveFrom: "2026-11-01" }, TODAY);
    expect(await inForce(TODAY)).toEqual({ ok: false, missing: [w.sam.id] });
    expect(await inForce("2026-11-01")).toEqual({ [w.alex.id]: ALEX, [w.sam.id]: SAM });
  });

  it("shows the amount to everyone in the group, with no way to hide it", async () => {
    const row = await recordIncome(w.db, w.sam, { annualCents: SAM, shareMode: "ratio_only" } as never, TODAY);
    expect(row.shareMode).toBe("amount");
    expect((await listIncomes(w.db, w.alex, TODAY)).find((i) => i.id === row.id)!.annualCents).toBe(SAM);
  });

  it("refuses a negative or fractional amount, and a date that is not one", async () => {
    await expect(recordIncome(w.db, w.alex, { annualCents: -1 }, TODAY)).rejects.toThrow(/income/);
    await expect(recordIncome(w.db, w.alex, { annualCents: 10.5 }, TODAY)).rejects.toThrow(/income/);
    await expect(
      recordIncome(w.db, w.alex, { annualCents: ALEX, effectiveFrom: "soon" }, TODAY),
    ).rejects.toThrow(/not a date/);
  });
});

describe("editing an income", () => {
  it("adds a row that points back at the one it replaces, which stays", async () => {
    const first = await recordIncome(w.db, w.alex, { annualCents: ALEX }, TODAY);
    const second = await recordIncome(w.db, w.alex, { annualCents: 100000_00 }, TODAY);
    expect(second.supersedesId).toBe(first.id);
    const listed = await listIncomes(w.db, w.alex, TODAY);
    expect(listed.map((i) => [i.id, i.annualCents, i.state])).toEqual([
      [second.id, 100000_00, "current"],
      [first.id, ALEX, "replaced"],
    ]);
  });

  it("with the same date, corrects the income on every date from then", async () => {
    await agree(w, TODAY, { incomes: { alex: ALEX, sam: SAM } });
    await recordIncome(w.db, w.alex, { annualCents: 100000_00, effectiveFrom: TODAY }, "2026-12-01");
    expect(await inForce(TODAY)).toEqual({ [w.alex.id]: 100000_00, [w.sam.id]: SAM });
    expect(await inForce("2027-06-01")).toEqual({ [w.alex.id]: 100000_00, [w.sam.id]: SAM });
  });

  it("with a later date, changes it from that date only", async () => {
    await agree(w, TODAY, { incomes: { alex: ALEX, sam: SAM } });
    await recordIncome(w.db, w.alex, { annualCents: 120000_00, effectiveFrom: "2027-01-01" }, "2026-12-01");
    expect(await inForce("2026-12-31")).toEqual({ [w.alex.id]: ALEX, [w.sam.id]: SAM });
    expect(await inForce("2027-01-01")).toEqual({ [w.alex.id]: 120000_00, [w.sam.id]: SAM });
  });

  describe("with an earlier date", () => {
    const record = (annualCents: number, effectiveFrom: string) =>
      recordIncome(w.db, w.alex, { annualCents, effectiveFrom }, TODAY);
    const alexOn = async (date: string) => {
      const r = await incomesInForce(w.db, w.householdId, date);
      return r.ok ? r.annualCents[w.alex.id] : r;
    };
    const states = async () =>
      (await listIncomes(w.db, w.alex, TODAY)).filter((i) => i.ownerId === w.alex.id).map((i) => [i.id, i.state]);
    beforeEach(async () => {
      await recordIncome(w.db, w.sam, { annualCents: SAM, effectiveFrom: "2025-01-01" }, TODAY);
    });

    it("replaces the income it starts before, on every date", async () => {
      const june = await record(ALEX, "2026-06-01");
      const jan = await record(100000_00, "2026-01-01");
      expect(jan.supersedesId).toBe(june.id);
      expect(await alexOn("2026-03-01")).toBe(100000_00);
      expect(await alexOn("2026-07-01")).toBe(100000_00);
      expect(await states()).toEqual([
        [jan.id, "current"],
        [june.id, "replaced"],
      ]);
      const [old] = await w.db.select().from(income).where(eq(income.id, june.id));
      expect(old).toMatchObject({ status: "void", voidedBy: w.alex.id, replacedBy: jan.id });
      expect(old!.voidedAt).not.toBeNull();
    });

    it("replaces only the rows dated on or after it, and keeps earlier ones", async () => {
      const jan = await record(ALEX, "2026-01-01");
      const june = await record(100000_00, "2026-06-01");
      const march = await record(120000_00, "2026-03-01");
      expect(march.supersedesId).toBe(june.id);
      expect(await alexOn("2026-01-15")).toBe(ALEX);
      expect(await alexOn("2026-03-01")).toBe(120000_00);
      expect(await alexOn("2026-07-01")).toBe(120000_00);
      expect(await states()).toEqual([
        [march.id, "current"],
        [june.id, "replaced"],
        [jan.id, "earlier"],
      ]);
      const [kept] = await w.db.select().from(income).where(eq(income.id, jan.id));
      expect(kept!.status).toBe("active");
    });

    it("after a removal, shows each row as replaced or removed and leaves nothing in force", async () => {
      const jan = await record(ALEX, "2026-01-01");
      const june = await record(100000_00, "2026-06-01");
      const march = await record(120000_00, "2026-03-01");
      await removeIncome(w.db, w.alex, w.alex.id);
      expect(await states()).toEqual([
        [march.id, "removed"],
        [june.id, "replaced"],
        [jan.id, "removed"],
      ]);
      for (const date of ["2026-01-15", "2026-03-01", "2026-07-01"]) {
        expect(await alexOn(date)).toEqual({ ok: false, missing: [w.alex.id] });
      }
    });
  });

  it("shows the income in force today as current, and one dated later as upcoming", async () => {
    const today = "2027-03-01";
    const feb = await recordIncome(w.db, w.alex, { annualCents: 80000_00, effectiveFrom: "2027-02-01" }, today);
    const later = await recordIncome(w.db, w.alex, { annualCents: 70000_00, effectiveFrom: "2027-03-15" }, today);
    const mine = (await listIncomes(w.db, w.alex, today)).filter((i) => i.ownerId === w.alex.id);
    expect(mine.map((i) => [i.id, i.state])).toEqual([
      [later.id, "upcoming"],
      [feb.id, "current"],
    ]);
    // Once its date comes, the later one is current and the earlier one still holds before it.
    const then = (await listIncomes(w.db, w.alex, "2027-03-15")).filter((i) => i.ownerId === w.alex.id);
    expect(then.map((i) => [i.id, i.state])).toEqual([
      [later.id, "current"],
      [feb.id, "earlier"],
    ]);
  });

  it("leaves an expense already split alone", async () => {
    await agree(w, TODAY, { incomes: { alex: ALEX, sam: SAM }, rules: [{ scope: "household", rule: { kind: "income_proportional" } }] });
    const cost = await createExpense(w.db, w.householdId, {
      kind: "manual",
      actor: w.alex,
      date: TODAY,
      description: "Groceries",
      category: "groceries",
      totalCents: 100_00,
      payerId: w.alex.id,
      today: TODAY,
    });
    expect(cost.shares).toEqual({ [w.alex.id]: 60_00, [w.sam.id]: 40_00 });
    const before = await getExpense(w.db, w.householdId, cost.id);
    await recordIncome(w.db, w.sam, { annualCents: ALEX, effectiveFrom: TODAY }, TODAY);
    expect(await getExpense(w.db, w.householdId, cost.id)).toEqual(before);
  });
});

describe("removing an income", () => {
  it("voids every row of that person, keeps them, and leaves a split by income missing them", async () => {
    await agree(w, TODAY, { incomes: { alex: ALEX, sam: SAM } });
    await recordIncome(w.db, w.alex, { annualCents: 120000_00, effectiveFrom: "2027-01-01" }, TODAY);
    await removeIncome(w.db, w.alex, w.alex.id);

    const mine = (await listIncomes(w.db, w.alex, TODAY)).filter((i) => i.ownerId === w.alex.id);
    expect(mine.map((i) => [i.status, i.state, i.voidedBy])).toEqual([
      ["void", "removed", w.alex.id],
      ["void", "removed", w.alex.id],
    ]);
    expect(mine.every((i) => i.voidedAt !== null)).toBe(true);
    for (const date of [TODAY, "2027-01-01"]) {
      expect(await inForce(date)).toEqual({ ok: false, missing: [w.alex.id] });
    }
    expect(await currentRatio(w.db, w.householdId, TODAY)).toEqual({ ok: false, reason: "income_missing" });
  });

  it("refuses when there is nothing to remove", async () => {
    await expect(removeIncome(w.db, w.alex, w.alex.id)).rejects.toThrow("no income on record");
  });

  it("can be followed by a new income", async () => {
    await recordIncome(w.db, w.alex, { annualCents: ALEX }, TODAY);
    await removeIncome(w.db, w.alex, w.alex.id);
    const again = await recordIncome(w.db, w.alex, { annualCents: SAM, effectiveFrom: "2026-09-01" }, TODAY);
    expect(again.supersedesId).toBeNull();
    expect((await incomesInForce(w.db, w.householdId, "2026-09-01")).ok).toBe(false);
    const r = await incomesInForce(w.db, w.householdId, TODAY);
    expect(r.ok ? null : r.missing).toEqual([w.sam.id]);
  });
});

describe("someone else's income", () => {
  it("cannot be written once they have joined", async () => {
    await recordIncome(w.db, w.sam, { annualCents: SAM }, TODAY);
    await expect(
      recordIncome(w.db, w.alex, { annualCents: ALEX, ownerId: w.sam.id }, TODAY),
    ).rejects.toThrow(/has joined, so only they can change their income/);
    await expect(removeIncome(w.db, w.alex, w.sam.id)).rejects.toThrow(/only they can/);
    expect(await inForce(TODAY)).toMatchObject({ ok: false, missing: [w.alex.id] });
  });

  it("can be added, edited and removed for someone who has not joined, and counts at once", async () => {
    w = await createWorld({ samJoined: false });
    await recordIncome(w.db, w.alex, { annualCents: ALEX }, TODAY);
    const sams = await recordIncome(w.db, w.alex, { annualCents: SAM, ownerId: w.sam.id }, TODAY);
    expect(sams).toMatchObject({ ownerId: w.sam.id, createdBy: w.alex.id, status: "active", shareMode: "amount" });
    expect(await currentRatio(w.db, w.householdId, TODAY)).toEqual({ ok: true, bp: { [w.alex.id]: 6000, [w.sam.id]: 4000 } });

    const edited = await recordIncome(w.db, w.alex, { annualCents: ALEX, ownerId: w.sam.id }, TODAY);
    expect(edited.supersedesId).toBe(sams.id);
    expect(await currentRatio(w.db, w.householdId, TODAY)).toEqual({ ok: true, bp: { [w.alex.id]: 5000, [w.sam.id]: 5000 } });

    await removeIncome(w.db, w.alex, w.sam.id);
    expect(await inForce(TODAY)).toEqual({ ok: false, missing: [w.sam.id] });
  });

  it("refuses an owner outside the household", async () => {
    const other = await seedHousehold(w.db);
    await expect(
      recordIncome(w.db, w.alex, { annualCents: SAM, ownerId: other.sam.id }, TODAY),
    ).rejects.toThrow("not a member of this household");
    await expect(removeIncome(w.db, w.alex, "not-an-id")).rejects.toThrow("not a member of this household");
  });
});

describe("what each partner can see", () => {
  const SAM_INCOME = 65432_00;
  const samsRows = async () => (await listIncomes(w.db, w.alex, TODAY)).filter((i) => i.ownerId === w.sam.id);

  beforeEach(async () => {
    await agree(w, TODAY, { incomes: { alex: ALEX, sam: SAM_INCOME } });
  });

  it("shows an owner their own amount, even one hidden before hiding went away", async () => {
    await hideIncomes(w, w.sam);
    const mine = (await listIncomes(w.db, w.sam, TODAY)).find((i) => i.ownerId === w.sam.id)!;
    expect(mine.annualCents).toBe(SAM_INCOME);
  });

  it("shows the partner an amount shared as an amount", async () => {
    const theirs = (await listIncomes(w.db, w.sam, TODAY)).find((i) => i.ownerId === w.alex.id)!;
    expect(theirs.annualCents).toBe(ALEX);
  });

  it("keeps an amount hidden before hiding went away hidden from the partner", async () => {
    await hideIncomes(w, w.sam);
    const listed = await listIncomes(w.db, w.alex, TODAY);
    expect(listed.filter((i) => i.ownerId === w.sam.id).map((i) => [i.annualCents, i.shareMode, i.state])).toEqual([
      [null, "ratio_only", "current"],
    ]);
    expect(JSON.stringify(listed)).not.toContain(String(SAM_INCOME));
  });

  it("shows a new income recorded over a hidden one, and keeps the hidden amounts it follows or replaces hidden", async () => {
    await hideIncomes(w, w.sam);
    // A raise from December: the hidden amount still holds before it.
    await recordIncome(w.db, w.sam, { annualCents: 70000_00, effectiveFrom: "2026-12-01" }, TODAY);
    expect((await samsRows()).map((i) => [i.annualCents, i.state])).toEqual([
      [70000_00, "upcoming"],
      [null, "current"],
    ]);
    // A correction from today: it replaces both, and the hidden one stays hidden.
    await recordIncome(w.db, w.sam, { annualCents: 50000_00, effectiveFrom: TODAY }, TODAY);
    expect((await samsRows()).map((i) => [i.annualCents, i.state])).toEqual([
      [50000_00, "current"],
      [70000_00, "replaced"],
      [null, "replaced"],
    ]);
    expect(JSON.stringify(await listIncomes(w.db, w.alex, TODAY))).not.toContain(String(SAM_INCOME));
  });

  it("gives both partners the ratio", async () => {
    expect(await currentRatio(w.db, w.householdId, TODAY)).toMatchObject({ ok: true });
  });

  it("lets the owner show a hidden amount, and every amount it replaced, without touching the split", async () => {
    await hideIncomes(w, w.sam);
    const mine = (await listIncomes(w.db, w.sam, TODAY)).find((i) => i.ownerId === w.sam.id)!;
    await recordIncome(w.db, w.sam, { annualCents: 70000_00, effectiveFrom: "2026-12-01" }, TODAY);
    await setShareMode(w.db, w.sam, mine.id, "amount");
    expect((await samsRows()).map((i) => [i.annualCents, i.state])).toEqual([
      [70000_00, "upcoming"],
      [SAM_INCOME, "current"],
    ]);
    expect((await incomesInForce(w.db, w.householdId, TODAY)).ok).toBe(true);

    const [latest] = await recentAudit(w.db, w.householdId, 1);
    expect(latest).toMatchObject({ action: "income.share_mode_changed", detail: { from: "ratio_only", to: "amount" } });
  });

  it("no longer lets anyone hide an amount", async () => {
    const mine = (await listIncomes(w.db, w.sam, TODAY)).find((i) => i.ownerId === w.sam.id)!;
    await expect(setShareMode(w.db, w.sam, mine.id, "ratio_only" as "amount")).rejects.toThrow("can no longer be hidden");
    expect((await samsRows())[0]!.annualCents).toBe(SAM_INCOME);
  });

  it("lets only the owner show their amount", async () => {
    await hideIncomes(w, w.sam);
    const mine = (await listIncomes(w.db, w.sam, TODAY)).find((i) => i.ownerId === w.sam.id)!;
    await expect(setShareMode(w.db, w.alex, mine.id, "amount")).rejects.toThrow("only your own income");
    expect((await samsRows())[0]!.annualCents).toBeNull();
  });
});

describe("the audit log", () => {
  it("records each add, change and removal with ids, never an amount", async () => {
    w = await createWorld({ samJoined: false });
    const first = await recordIncome(w.db, w.alex, { annualCents: SAM, ownerId: w.sam.id }, TODAY);
    const second = await recordIncome(w.db, w.alex, { annualCents: ALEX, ownerId: w.sam.id }, TODAY);
    await removeIncome(w.db, w.alex, w.sam.id);
    const entries = (await recentAudit(w.db, w.householdId, 3)).reverse();
    expect(entries).toMatchObject([
      { action: "income.recorded", entityType: "income", entityId: first.id, detail: { ownerId: w.sam.id } },
      { action: "income.changed", entityType: "income", entityId: second.id, detail: { ownerId: w.sam.id, supersedesId: first.id } },
      { action: "income.removed", entityType: "income", entityId: second.id, detail: { ownerId: w.sam.id } },
    ]);
    const text = JSON.stringify(entries);
    expect(text).not.toContain(String(SAM));
    expect(text).not.toContain(String(ALEX));
  });
});

describe("migration 0020", () => {
  // The data steps at the end of the migration, run again over rows made the
  // way the old code made them.
  const dataSteps = readFileSync("./drizzle/0020_simple_incomes.sql", "utf8")
    .split("--> statement-breakpoint")
    .filter((s) => !s.trim().startsWith("ALTER"));
  const runDataSteps = async () => {
    for (const step of dataSteps) await w.db.execute(sql.raw(step));
  };
  const waiting = (ownerId: string, createdBy: string, annualCents: number, createdAt: string) =>
    w.db
      .insert(income)
      .values({ householdId: w.householdId, ownerId, annualCents, shareMode: "amount", createdBy, createdAt: new Date(createdAt) })
      .returning()
      .then((r) => r[0]!);
  const statusOf = async (id: string) => (await w.db.select().from(income).where(eq(income.id, id)))[0]!;

  it("puts each owner's newest waiting income they could have saved into force, withdraws the rest, and leaves change sets alone", async () => {
    const older = await waiting(w.alex.id, w.alex.id, ALEX, "2026-09-10T12:00:00Z");
    const newer = await waiting(w.alex.id, w.alex.id, 100000_00, "2026-09-10T13:00:00Z");
    // Sam typed it for Alex, who has joined: only Alex may write Alex's income now.
    const bySam = await waiting(w.alex.id, w.sam.id, 50000_00, "2026-09-11T12:00:00Z");
    const sam = await waiting(w.sam.id, w.sam.id, SAM, "2026-09-12T12:00:00Z");
    const [set] = await w.db.insert(changeSet).values({ householdId: w.householdId, effectiveFrom: TODAY, createdBy: w.alex.id }).returning();
    const [inSet] = await w.db
      .insert(income)
      .values({ householdId: w.householdId, ownerId: w.sam.id, annualCents: 1, shareMode: "amount", createdBy: w.sam.id, changeSetId: set!.id })
      .returning();

    await runDataSteps();

    expect(await inForce("2026-09-10")).toEqual({ ok: false, missing: [w.sam.id] });
    expect(await inForce("2026-09-12")).toEqual({ [w.alex.id]: 100000_00, [w.sam.id]: SAM });
    expect((await statusOf(newer.id)).status).toBe("active");
    expect((await statusOf(sam.id)).status).toBe("active");
    expect((await statusOf(older.id)).status).toBe("withdrawn");
    expect((await statusOf(bySam.id)).status).toBe("withdrawn");
    expect(await statusOf(inSet!.id)).toMatchObject({ status: "proposed", effectiveFrom: null });
    for (const id of [newer.id, sam.id]) expect((await statusOf(id)).activatedAt).not.toBeNull();
  });

  it("puts into force an income typed for someone who has not joined", async () => {
    w = await createWorld({ samJoined: false });
    const forSam = await waiting(w.sam.id, w.alex.id, SAM, "2026-09-12T12:00:00Z");
    await runDataSteps();
    expect((await statusOf(forSam.id)).status).toBe("active");
  });
});
