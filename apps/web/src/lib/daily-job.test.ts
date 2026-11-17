import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { expense, household, member } from "@/db/schema";
import { seedHousehold } from "@/db/test-db";
import { createTemplate } from "./templates";
import { createWorld, type World } from "./testing/world";
import { randomBytes } from "node:crypto";
import { bankConnection } from "@/db/schema";
import { connectBank } from "./bank";
import { fakePlaid, txn } from "./testing/fake-plaid";
import { dailyJobWanted, runDailyJob, scheduleDailyJob } from "./daily-job";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

// A second group of two, in another timezone, with Alex linked.
async function secondGroup(timezone: string) {
  const seeded = await seedHousehold(w.db);
  await w.db.update(household).set({ timezone }).where(eq(household.id, seeded.household.id));
  const [alex] = await w.db.update(member).set({ linkedAt: new Date() }).where(eq(member.id, seeded.alex.id)).returning();
  return { householdId: seeded.household.id, alex: alex! };
}

const rent = (actor: typeof w.alex, startDate: string) =>
  createTemplate(w.db, actor, {
    name: "Rent",
    category: "housing",
    amountCents: 200000,
    cadence: "monthly",
    dayOfMonth: 1,
    payerId: actor.id,
    startDate,
  });

const postedIn = async (householdId: string) =>
  (await w.db.select().from(expense).where(eq(expense.householdId, householdId))).map((e) => e.date);

describe("runDailyJob", () => {
  it("posts what is due by each group's own date", async () => {
    const tokyo = await secondGroup("Asia/Tokyo");
    await rent(w.alex, "2026-11-01");
    await rent(tokyo.alex, "2026-11-01");

    // Noon on 31 October in New York is already 1 November in Tokyo.
    const summary = await runDailyJob(w.db, new Date("2026-10-31T16:00:00Z"));

    expect(summary).toEqual({ groups: 2, posted: 1, failed: 0 });
    expect(await postedIn(w.householdId)).toEqual([]);
    expect(await postedIn(tokyo.householdId)).toEqual(["2026-11-01"]);
  });

  it("posts nothing on a second run", async () => {
    await rent(w.alex, "2026-10-01");
    const now = new Date("2026-11-02T12:00:00Z");
    expect(await runDailyJob(w.db, now)).toEqual({ groups: 1, posted: 2, failed: 0 });
    expect(await runDailyJob(w.db, now)).toEqual({ groups: 1, posted: 0, failed: 0 });
    expect(await postedIn(w.householdId)).toHaveLength(2);
  });

  it("carries on with the other groups when one fails", async () => {
    const other = await secondGroup("Europe/London");
    await rent(other.alex, "2026-11-01");
    // A timezone nobody knows makes working out the group's date throw.
    await w.db.update(household).set({ timezone: "Nowhere/Atlantis" }).where(eq(household.id, w.householdId));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await runDailyJob(w.db, new Date("2026-11-02T12:00:00Z"));

    expect(summary).toEqual({ groups: 2, posted: 1, failed: 1 });
    expect(await postedIn(other.householdId)).toEqual(["2026-11-01"]);
    vi.restoreAllMocks();
  });
});

describe("runDailyJob with banks", () => {
  it("syncs every connected bank after posting, and one failing stops neither the rest nor the recurring costs", async () => {
    const fake = fakePlaid();
    const bank = { plaid: fake.plaid, key: randomBytes(32) };
    const now = new Date("2027-03-10T15:00:00Z");
    await rent(w.alex, "2027-03-01");
    const alex = await connectBank(w.db, bank, w.alex, { publicToken: "alex", institutionName: "First Platypus Bank" }, "2027-03-01", now);
    fake.setAccounts([{ account_id: "acc-2", name: "Sam Card", mask: "5678", type: "credit", subtype: "credit card" }]);
    await connectBank(w.db, bank, w.sam, { publicToken: "sam", institutionName: "Second Bank" }, "2027-03-01", now);
    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1" });
    fake.failNext("sam", "INTERNAL_SERVER_ERROR");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const summary = await runDailyJob(w.db, now, bank);

    expect(summary).toEqual({ groups: 1, posted: 1, failed: 0, bank: { synced: 1, needsRelink: 0, superseded: 0, failed: 1 } });
    expect((await w.db.select().from(bankConnection).where(eq(bankConnection.id, alex.connection.id)))[0]!.cursor).toBe("c1");
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain("INTERNAL_SERVER_ERROR");
    expect(logged).not.toMatch(/access-|1234|5678/);
    vi.restoreAllMocks();
  });

  it("leaves banks alone without them", async () => {
    expect(await runDailyJob(w.db, new Date("2027-03-10T15:00:00Z"))).toEqual({ groups: 1, posted: 0, failed: 0 });
  });
});

describe("scheduleDailyJob", () => {
  it("runs shortly after start, then on every interval", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const job = scheduleDailyJob(run, { firstDelayMs: 1000, everyMs: 60_000 });
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    job.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not start a run while the last one is still going", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const job = scheduleDailyJob(run, { firstDelayMs: 60_000, everyMs: 60_000 });
    const first = job.tick();
    await job.tick();
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await first;
    const third = job.tick();
    finish();
    await third;
    expect(run).toHaveBeenCalledTimes(2);
    job.stop();
  });

  it("survives a run that throws, and runs again next time", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = vi.fn().mockRejectedValueOnce(new Error("database is down")).mockResolvedValueOnce(undefined);
    const job = scheduleDailyJob(run, { firstDelayMs: 60_000, everyMs: 60_000 });
    await expect(job.tick()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("daily job: failed: database is down");
    await job.tick();
    expect(run).toHaveBeenCalledTimes(2);
    job.stop();
    vi.restoreAllMocks();
  });
});

describe("dailyJobWanted", () => {
  const url = "postgres://localhost/abacus";
  it("runs only on a server with a database", () => {
    expect(dailyJobWanted({ DATABASE_URL: url })).toBe(true);
    expect(dailyJobWanted({})).toBe(false);
    expect(dailyJobWanted({ DATABASE_URL: url, ABACUS_DAILY_JOB: "0" })).toBe(false);
    expect(dailyJobWanted({ DATABASE_URL: url, NEXT_PHASE: "phase-production-build" })).toBe(false);
    expect(dailyJobWanted({ DATABASE_URL: url, VITEST: "true" })).toBe(false);
  });
});
