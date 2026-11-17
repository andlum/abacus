import { describe, expect, it } from "vitest";
import { centsToDecimal, formatBp, formatCents, parseBp, parseCents } from "./money.ts";

describe("money as text", () => {
  it("writes cents as a decimal amount", () => {
    expect(centsToDecimal(123456)).toBe("1234.56");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(centsToDecimal(-250)).toBe("-2.50");
  });

  it("writes cents for people to read", () => {
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(-99)).toBe("-$0.99");
  });

  it("reads an amount into whole cents", () => {
    expect(parseCents("1234.56")).toBe(123456);
    expect(parseCents(" $1,234.5 ")).toBe(123450);
    expect(parseCents("12")).toBe(1200);
    // 0.1 + 0.2 style traps: these never pass through a fraction
    expect(parseCents("0.29")).toBe(29);
    expect(parseCents("1.15")).toBe(115);
    expect(parseCents("4.35")).toBe(435);
  });

  it("refuses text that is not an amount", () => {
    for (const bad of ["", "abc", "1.234", "-5", "1e3", "1.", ".5", "12.3.4"]) expect(parseCents(bad)).toBeNull();
  });

  it("writes and reads percentages as basis points", () => {
    expect(formatBp(6000)).toBe("60%");
    expect(formatBp(3333)).toBe("33.33%");
    expect(formatBp(0)).toBe("0%");
    expect(formatBp(10000)).toBe("100%");
    expect(parseBp("60")).toBe(6000);
    expect(parseBp("33.33%")).toBe(3333);
    expect(parseBp("100.01")).toBeNull();
  });
});
