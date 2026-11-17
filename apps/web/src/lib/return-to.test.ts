import { describe, expect, it } from "vitest";
import { returnTo } from "./return-to";

describe("where an edit returns to", () => {
  it("takes the Ledger on Home or the old list, with its filters and page, or a month", () => {
    for (const path of ["/", "/?q=rent&cursor=abc", "/?to=2026-03-01", "/expenses", "/expenses?q=rent&cursor=abc", "/expenses?to=2026-03-01", "/month/2026-03"]) {
      expect(returnTo(path)).toBe(path);
    }
  });

  it("refuses anything that could leave the site or is not a list", () => {
    for (const path of [
      "",
      null,
      undefined,
      "//evil.example",
      "/\\evil.example",
      "https://evil.example/expenses?x",
      "javascript:alert(1)",
      "/expenses/abc",
      "/expensesx",
      "/expenses?q=\nx",
      "/?q=\nx",
      "/activity",
      "/expenses?q=\u0000",
      "/expenses?q=a\\b",
      "/month/2026-03/x",
      "/month//evil.example",
      "/settings",
      "expenses",
      " /expenses",
      `/expenses?q=${"x".repeat(3000)}`,
    ]) {
      expect(returnTo(path), String(path)).toBeNull();
    }
  });
});
