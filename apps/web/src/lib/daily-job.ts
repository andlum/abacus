// The daily job: work that should happen on its date whether or not anyone
// opens the app. Started inside the server by src/instrumentation.ts, a
// little after start and then every hour. A host that stops the server when
// idle needs a daily request to wake it (docs/setup.md, "The daily job").
//
// Pages and API routes still call `postDue` themselves before they read:
// the machine may have only just woken, and whoever is looking must see
// today's costs. Both paths are safe together; posting is idempotent.
import { asc } from "drizzle-orm";
import { todayIn } from "@abacus/core/dates";
import { household } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { syncAllConnections, type BankDeps, type SyncAllSummary } from "./bank.ts";
import { postDue } from "./expenses.ts";

// `bank` is there only when connecting a bank is set up.
export type DailyJobSummary = { groups: number; posted: number; failed: number; bank?: SyncAllSummary };

// Every group, each on its own date. One group failing is logged and
// counted, and the rest carry on. Then, with `bank`, every connected bank
// is synced; one that fails is logged and counted and cannot stop the others.
export async function runDailyJob(db: Db, now: Date, bank: BankDeps | null = null): Promise<DailyJobSummary> {
  const groups = await db.select({ id: household.id, timezone: household.timezone }).from(household).orderBy(asc(household.createdAt));
  const summary: DailyJobSummary = { groups: groups.length, posted: 0, failed: 0 };
  for (const group of groups) {
    try {
      const today = todayIn(group.timezone, now);
      // Each daily task for a group goes here, in order.
      summary.posted += (await postDue(db, group.id, today)).length;
    } catch (e) {
      summary.failed += 1;
      console.error(`daily job: a group failed: ${message(e)}`);
    }
  }
  if (bank) {
    try {
      summary.bank = await syncAllConnections(db, bank, now);
    } catch (e) {
      console.error(`daily job: syncing banks failed: ${message(e)}`);
    }
  }
  return summary;
}

export const DAILY_JOB_FIRST_DELAY_MS = 10_000;
export const DAILY_JOB_EVERY_MS = 60 * 60 * 1000;

// Calls `run` after `firstDelayMs`, then every `everyMs`. A run that is still
// going when the next is due makes that one skip; a run that throws is
// logged and never reaches the server.
export function scheduleDailyJob(run: () => Promise<void>, { firstDelayMs, everyMs }: { firstDelayMs: number; everyMs: number }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await run();
    } catch (e) {
      console.error(`daily job: failed: ${message(e)}`);
    } finally {
      running = false;
    }
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    void tick();
    interval = setInterval(() => void tick(), everyMs);
    interval.unref?.();
  }, firstDelayMs);
  first.unref?.();
  return {
    tick,
    stop() {
      clearTimeout(first);
      clearInterval(interval);
    },
  };
}

// Only a running server with a database: not `next build`, not Vitest, and
// not where ABACUS_DAILY_JOB=0 switches it off.
export function dailyJobWanted(env: Record<string, string | undefined>): boolean {
  if (!env.DATABASE_URL) return false;
  if (env.ABACUS_DAILY_JOB === "0") return false;
  if (env.NEXT_PHASE === "phase-production-build") return false;
  if (env.VITEST) return false;
  return true;
}

const started = globalThis as typeof globalThis & { __abacusDailyJob?: boolean };

export async function startDailyJob(env = process.env) {
  if (env.ABACUS_DAILY_JOB === "0") console.log("daily job: off (ABACUS_DAILY_JOB=0)");
  if (!dailyJobWanted(env) || started.__abacusDailyJob) return;
  started.__abacusDailyJob = true;
  const { getDb } = await import("../db/client.ts");
  scheduleDailyJob(
    async () => {
      const { bankRuntime } = await import("./bank-link.ts");
      const s = await runDailyJob(getDb(), new Date(), bankRuntime(env));
      console.log(`daily job: groups ${s.groups}, recurring costs posted ${s.posted}, failed ${s.failed}`);
      if (s.bank) console.log(`daily job: banks synced ${s.bank.synced}, need re-linking ${s.bank.needsRelink}, failed ${s.bank.failed}`);
    },
    { firstDelayMs: DAILY_JOB_FIRST_DELAY_MS, everyMs: DAILY_JOB_EVERY_MS },
  );
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
