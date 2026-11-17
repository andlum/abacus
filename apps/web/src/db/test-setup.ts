// Runs before every test file (see `setupFiles` in vitest.config.ts).
import { readFileSync } from "node:fs";
import { afterEach, inject } from "vitest";
import { closeTestDbs, useMigratedDump } from "./test-db";

useMigratedDump(new Blob([readFileSync(inject("testDbDump"))]));
afterEach(closeTestDbs);
