import { describe, expect, it } from "vitest";
import { devAuthEnabled } from "./dev-auth";

describe("the sign-in stand-in", () => {
  it("is off unless asked for", () => {
    expect(devAuthEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(devAuthEnabled({ NODE_ENV: "development", ABACUS_E2E: "true" })).toBe(false);
  });

  it("is on in development and test when asked for", () => {
    expect(devAuthEnabled({ NODE_ENV: "development", ABACUS_E2E: "1" })).toBe(true);
    expect(devAuthEnabled({ NODE_ENV: "test", ABACUS_E2E: "1" })).toBe(true);
  });

  it("is never on in a production build", () => {
    expect(devAuthEnabled({ NODE_ENV: "production", ABACUS_E2E: "1" })).toBe(false);
  });
});
