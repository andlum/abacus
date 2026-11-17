import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // The migrations run once for the whole run, in `globalSetup`. Each test
  // opens its own in-process database from that copy, and `setupFiles`
  // closes it when the test ends.
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/db/test-global-setup.ts"],
    setupFiles: ["src/db/test-setup.ts"],
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
});
