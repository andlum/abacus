// Runs once before the whole test run (see `globalSetup` in vitest.config.ts).
// Applies the real migrations to one in-memory Postgres and saves the result,
// so each test file starts from that copy instead of migrating its own.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { migratedDump } from "./test-db";

declare module "vitest" {
  export interface ProvidedContext {
    testDbDump: string;
  }
}

export default async function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), "abacus-test-db-"));
  const path = join(dir, "migrated.tar");
  const dump = await migratedDump();
  writeFileSync(path, Buffer.from(await dump.arrayBuffer()));
  project.provide("testDbDump", path);
  return () => rmSync(dir, { recursive: true, force: true });
}
