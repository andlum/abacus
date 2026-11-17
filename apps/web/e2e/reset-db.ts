// Recreates the throwaway database, applies the real migrations, and
// provisions an invented household of two. Runs before the app starts.
import { execFileSync } from "node:child_process";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL ?? "";
const url = new URL(databaseUrl);
const name = url.pathname.slice(1);
// `abacus_e2e` is the Playwright database; `abacus_e2e_<port>` is one live
// check's own (scripts/check-live.sh), so two can run side by side.
if (!/^abacus_e2e(_\d+)?$/.test(name) || url.hostname !== "localhost") throw new Error("refusing to reset this database");

url.pathname = "/postgres";
const admin = new pg.Client({ connectionString: url.toString() });
try {
  await admin.connect();
} catch {
  console.error("the local database is not running: start it with `pnpm db:up`");
  process.exit(1);
}
await admin.query(`drop database if exists ${name} with (force)`);
await admin.query(`create database ${name}`);
await admin.end();

const env = {
  ...process.env,
  HOUSEHOLD_NAME: "Maple Street",
  HOUSEHOLD_TIMEZONE: "America/New_York",
  MEMBER_1_NAME: "Alex",
  MEMBER_1_EMAIL: "alex@example.com",
  MEMBER_2_NAME: "Sam",
  MEMBER_2_EMAIL: "sam@example.com",
};
execFileSync("node", ["scripts/migrate.ts"], { env, stdio: "inherit" });
execFileSync("node", ["scripts/provision-household.ts"], { env, stdio: "inherit" });

// Both have signed in, as far as the app can tell. The local sign-in
// stand-in never links an account, and only someone who has joined may
// change their own income.
const db = new pg.Client({ connectionString: databaseUrl });
await db.connect();
await db.query("update member set linked_at = now()");
await db.end();
