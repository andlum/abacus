import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.ts";
import type { Db } from "./types.ts";
import { seedCategories } from "../lib/categories.ts";

// A fresh in-memory Postgres with the real migrations applied.
// Migrations run once for the whole run (`test-global-setup.ts`), which hands
// each test file the result through `useMigratedDump`; each test starts from a
// copy of it. Without that, the first test in a file migrates for itself.
let migrated: Promise<File | Blob> | undefined;

export function useMigratedDump(dump: Blob) {
  migrated = Promise.resolve(dump);
}

export async function migratedDump(): Promise<File | Blob> {
  const client = new PGlite();
  await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
  const dump = await client.dumpDataDir("none");
  await client.close();
  return dump;
}

// Every database a test opens, so `closeTestDbs` can shut them after it.
// Left open, they pile up through a file and each test runs slower than the
// one before.
const open = new Set<PGlite>();

export async function createTestDb(): Promise<Db> {
  migrated ??= migratedDump();
  const client = new PGlite({ loadDataDir: await migrated });
  open.add(client);
  return drizzle(client, { schema });
}

// Called after each test by `test-setup.ts`.
export async function closeTestDbs() {
  const clients = [...open];
  open.clear();
  await Promise.all(clients.map((c) => c.close()));
}

// A household with two members, for tests. Invented names only.
export async function seedHousehold(db: Db) {
  const [h] = await db
    .insert(schema.household)
    .values({ name: "Test household", timezone: "America/New_York" })
    .returning();
  await seedCategories(db, h!.id, "household");
  const [alex] = await db
    .insert(schema.member)
    .values({ householdId: h!.id, email: "alex@example.com", displayName: "Alex" })
    .returning();
  const [sam] = await db
    .insert(schema.member)
    .values({ householdId: h!.id, email: "sam@example.com", displayName: "Sam" })
    .returning();
  return { household: h!, alex: alex!, sam: sam! };
}
