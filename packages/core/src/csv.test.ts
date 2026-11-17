import { describe, expect, it } from "vitest";
import { parseCsv, plainText, toCsv } from "./csv.ts";

describe("toCsv", () => {
  it("stops a spreadsheet reading text as a formula", () => {
    for (const text of ["=1+1", "+1+1", "-1+1", "@SUM(A1)", "\tx", '=HYPERLINK("http://example.com","pay")']) {
      const cell = parseCsv(toCsv([[text]]))![0]![0]!;
      expect(cell).toBe("'" + text);
    }
  });

  it("leaves amounts alone, negative ones too", () => {
    expect(toCsv([["12.50", "-12.50", "-3", "+3"]])).toBe("12.50,-12.50,-3,+3\r\n");
  });

  it("leaves ordinary text alone", () => {
    expect(toCsv([["Groceries", "alex@example.com", "a = b", "'quoted'"]])).toBe("Groceries,alex@example.com,a = b,'quoted'\r\n");
  });
});

describe("plainText", () => {
  it("gives back what was exported", () => {
    for (const text of ["=1+1", "-1+1", "@home", "Groceries", "'quoted'", "-12.50"]) {
      const cell = parseCsv(toCsv([[text]]))![0]![0]!;
      expect(plainText(cell)).toBe(text);
    }
  });
});
