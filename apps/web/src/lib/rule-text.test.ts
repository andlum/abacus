import { describe, expect, it } from "vitest";
import { describeRule, explain, readRule } from "./rule-text";

const people = [
  { id: "a", displayName: "Alex" },
  { id: "s", displayName: "Sam" },
];

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe("describeRule", () => {
  it("says each kind of rule in words", () => {
    expect(describeRule({ kind: "even" }, people)).toBe("split evenly");
    expect(describeRule({ kind: "income_proportional" }, people)).toBe("split by income");
    expect(describeRule({ kind: "percent", bp: { a: 6000, s: 4000 } }, people)).toBe("Alex 60%, Sam 40%");
    expect(
      describeRule({ kind: "fixed_plus_remainder", fixedCents: { a: 40000 }, remainder: { kind: "income_proportional" } }, people),
    ).toBe("Alex pays $400.00 first, the rest split by income");
  });
});

describe("explain", () => {
  it("walks through the stored computation, including the leftover cent", () => {
    const lines = explain(
      {
        version: 1,
        rule: { kind: "income_proportional" },
        totalCents: 100001,
        payerId: "a",
        memberIds: ["a", "s"],
        ratioBp: { a: 6000, s: 4000 },
        seed: "rent:2026-10",
        rounding: { leftoverCents: 1, receivedBy: ["s"] },
        ruleSource: "household",
        ruleId: "r1",
        rulesAsOf: "2026-10-01",
      },
      { a: 60000, s: 40001 },
      people,
    );
    expect(lines).toEqual([
      "Total $1,000.01, paid by Alex.",
      "Rule: split by income. This is the rule for the household.",
      "Rules and incomes as they stood on 2026-10-01.",
      "Income ratio: Alex 60%, Sam 40%.",
      "Alex: 60% of $1,000.01 = $600.006, rounded down to $600.00.",
      "Sam: 40% of $1,000.01 = $400.004, rounded down to $400.00.",
      "Rounding every segment down left 1 cent, which went to Sam by a random draw (seed rent:2026-10).",
      "Segments: Alex $600.00, Sam $400.01.",
      "So Sam owes Alex $400.01 for this.",
    ]);
  });

  const base = {
    version: 1 as const,
    payerId: "a",
    memberIds: ["a", "s"],
    seed: "x",
    rounding: { leftoverCents: 0, receivedBy: [] },
    ruleSource: "entry" as const,
    ruleId: null,
    rulesAsOf: "2027-03-20",
  };

  it("divides an even split by the number of people", () => {
    const lines = explain({ ...base, rule: { kind: "even" }, totalCents: 9000 }, { a: 4500, s: 4500 }, people);
    expect(lines).toContain("Alex and Sam: $90.00 ÷ 2 = $45.00 each.");
    expect(lines.at(-1)).toBe("So Sam owes Alex $45.00 for this.");
  });

  it("marks a share that runs on past a tenth of a cent", () => {
    const lines = explain(
      { ...base, rule: { kind: "even" }, totalCents: 10000, memberIds: ["a", "s", "j"] },
      { a: 3334, s: 3333, j: 3333 },
      [...people, { id: "j", displayName: "Jo" }],
    );
    expect(lines).toContain("Alex, Sam and Jo: $100.00 ÷ 3 = $33.333…, rounded down to $33.33 each.");
  });

  it("takes the fixed amounts off first, then splits what is left", () => {
    const lines = explain(
      {
        ...base,
        rule: { kind: "fixed_plus_remainder", fixedCents: { s: 20000 }, remainder: { kind: "percent", bp: { a: 7500, s: 2500 } } },
        totalCents: 30000,
        payerId: "s",
      },
      { a: 7500, s: 22500 },
      people,
    );
    expect(lines).toEqual([
      "Total $300.00, paid by Sam.",
      "Rule: Sam pays $200.00 first, the rest Alex 75%, Sam 25%. This is a split picked for this one expense.",
      "Rules and incomes as they stood on 2027-03-20.",
      "First, Sam pays $200.00. That leaves $100.00.",
      "Alex: 75% of $100.00 = $75.00.",
      "Sam: 25% of $100.00 = $25.00, plus $200.00 first = $225.00.",
      "Segments: Alex $75.00, Sam $225.00.",
      "So Alex owes Sam $75.00 for this.",
    ]);
  });

  it("says when the payer's own share is all there is", () => {
    const lines = explain(
      { ...base, rule: { kind: "percent", bp: { a: 10000, s: 0 } }, totalCents: 5000 },
      { a: 5000, s: 0 },
      people,
    );
    expect(lines.at(-1)).toBe("Alex paid for all of it, so nobody owes anything for this.");
  });
});

describe("readRule", () => {
  it("reads nothing when no rule was picked", () => {
    expect(readRule(form({}), "", people)).toBeNull();
    expect(readRule(form({ kind: "none" }), "", people)).toBeNull();
  });

  it("reads percentages into basis points", () => {
    expect(readRule(form({ r1_kind: "percent", r1_pct_a: "62.5", r1_pct_s: "37.5" }), "r1_", people)).toEqual({
      kind: "percent",
      bp: { a: 6250, s: 3750 },
    });
  });

  it("refuses percentages that do not add up to 100", () => {
    expect(() => readRule(form({ kind: "percent", pct_a: "60", pct_s: "30" }), "", people)).toThrow(/add up to 100/);
  });

  it("reads a fixed amount with the rest split by another rule", () => {
    expect(readRule(form({ kind: "fixed_plus_remainder", fixed_a: "400", remainder: "income_proportional" }), "", people)).toEqual({
      kind: "fixed_plus_remainder",
      fixedCents: { a: 40000 },
      remainder: { kind: "income_proportional" },
    });
    expect(() => readRule(form({ kind: "fixed_plus_remainder" }), "", people)).toThrow(/fixed amount/);
  });
});
