import { describe, expect, it } from "vitest";
import { shortDate } from "./dates";

describe("shortDate", () => {
  it("drops the year when the date is in this year", () => {
    expect(shortDate("2026-03-05", "2026-11-15")).toBe("5 Mar");
    expect(shortDate("2026-12-31", "2026-01-01")).toBe("31 Dec");
  });

  it("keeps the year when the date is in another year", () => {
    expect(shortDate("2025-12-31", "2026-01-01")).toBe("31 Dec 2025");
    expect(shortDate("2027-01-01", "2026-11-15")).toBe("1 Jan 2027");
  });
});
