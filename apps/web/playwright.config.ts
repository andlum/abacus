import { defineConfig } from "@playwright/test";

// End-to-end tests run the real app against a throwaway local database,
// with the sign-in stand-in (ABACUS_E2E=1) in place of Clerk.
const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  // The tests tell one story against one database, in order.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  // `next dev` compiles each page the first time it is asked for. On a CI
  // runner that can take longer than the usual five seconds.
  expect: { timeout: process.env.CI ? 20_000 : 5_000 },
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `node e2e/reset-db.ts && pnpm exec next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    // The daily job is off: it works from the real date, and these tests fake theirs.
    // ABACUS_COLD_DEV skips Turbopack's dev cache (next.config.ts).
    env: {
      ABACUS_E2E: "1",
      ABACUS_DAILY_JOB: "0",
      ABACUS_COLD_DEV: "1",
      DATABASE_URL: "postgres://abacus:abacus@localhost:5432/abacus_e2e",
    },
  },
});
