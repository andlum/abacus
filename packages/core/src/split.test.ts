import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeSplit, incomeRatio, rederive, type BaseRule, type Rule } from "./split.ts";

const alex = "alex";
const sam = "sam";
const members = [alex, sam];

function split(totalCents: number, rule: Rule, opts: { seed?: string; ratioBp?: Record<string, number> } = {}) {
  return computeSplit({
    totalCents,
    payerId: alex,
    memberIds: members,
    rule,
    seed: opts.seed ?? "seed-1",
    ratioBp: opts.ratioBp,
  });
}

function shares(result: ReturnType<typeof computeSplit>) {
  if (!result.ok) throw new Error(`expected shares, got ${result.reason}`);
  return result.shares;
}

describe("computeSplit", () => {
  it("splits an even total in equal parts", () => {
    expect(shares(split(100000, { kind: "even" }))).toEqual({ alex: 50000, sam: 50000 });
  });

  it("gives the leftover cent of an odd total to exactly one member", () => {
    const result = shares(split(100001, { kind: "even" }));
    expect(Object.values(result).sort()).toEqual([50000, 50001]);
  });

  it("gives the same answer for the same seed", () => {
    const first = split(100001, { kind: "even" }, { seed: "rent:2026-10" });
    const second = split(100001, { kind: "even" }, { seed: "rent:2026-10" });
    expect(second).toEqual(first);
  });

  it("lets the seed decide who receives the leftover cent", () => {
    const winners = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const result = shares(split(100001, { kind: "even" }, { seed: `seed-${i}` }));
      winners.add(result[alex] === 50001 ? alex : sam);
    }
    expect(winners).toEqual(new Set([alex, sam]));
  });

  it("splits by fixed percentages", () => {
    const rule: Rule = { kind: "percent", bp: { alex: 6000, sam: 4000 } };
    expect(shares(split(250000, rule))).toEqual({ alex: 150000, sam: 100000 });
  });

  it("never gives a leftover cent to a member whose share is exact", () => {
    const rule: Rule = { kind: "percent", bp: { alex: 10000, sam: 0 } };
    for (let i = 0; i < 20; i++) {
      expect(shares(split(100001, rule, { seed: `s${i}` }))).toEqual({ alex: 100001, sam: 0 });
    }
  });

  it("splits by the income ratio it is given", () => {
    const result = split(200000, { kind: "income_proportional" }, { ratioBp: { alex: 6000, sam: 4000 } });
    expect(shares(result)).toEqual({ alex: 120000, sam: 80000 });
  });

  it("cannot split by income without a ratio", () => {
    expect(split(200000, { kind: "income_proportional" })).toEqual({ ok: false, reason: "ratio_unavailable" });
  });

  it("takes fixed amounts first and splits the remainder by the nested rule", () => {
    const rule: Rule = {
      kind: "fixed_plus_remainder",
      fixedCents: { alex: 40000 },
      remainder: { kind: "income_proportional" },
    };
    const result = split(240000, rule, { ratioBp: { alex: 6000, sam: 4000 } });
    expect(shares(result)).toEqual({ alex: 160000, sam: 80000 });
  });

  it("cannot split when fixed amounts exceed the total", () => {
    const rule: Rule = { kind: "fixed_plus_remainder", fixedCents: { alex: 50000 }, remainder: { kind: "even" } };
    expect(split(40000, rule)).toEqual({ ok: false, reason: "fixed_exceeds_total" });
  });

  it("rejects percentages that do not sum to 100%", () => {
    const rule: Rule = { kind: "percent", bp: { alex: 6000, sam: 3000 } };
    expect(split(1000, rule)).toEqual({ ok: false, reason: "invalid_rule" });
  });

  it("rejects a total that is not a whole, non-negative number of cents", () => {
    expect(split(10.5, { kind: "even" })).toEqual({ ok: false, reason: "invalid_total" });
    expect(split(-1, { kind: "even" })).toEqual({ ok: false, reason: "invalid_total" });
  });

  it("records the rule, total, payer, ratio, seed and who received leftover cents", () => {
    const result = split(100001, { kind: "income_proportional" }, { seed: "abc", ratioBp: { alex: 5000, sam: 5000 } });
    if (!result.ok) throw new Error(result.reason);
    const receiver = result.shares[alex] === 50001 ? alex : sam;
    expect(result.computation).toEqual({
      version: 1,
      rule: { kind: "income_proportional" },
      totalCents: 100001,
      payerId: alex,
      memberIds: members,
      ratioBp: { alex: 5000, sam: 5000 },
      seed: "abc",
      rounding: { leftoverCents: 1, receivedBy: [receiver] },
    });
  });
});

const baseRule = fc.oneof(
  fc.constant<BaseRule>({ kind: "even" }),
  fc.constant<BaseRule>({ kind: "income_proportional" }),
  fc.integer({ min: 0, max: 10000 }).map((a): BaseRule => ({ kind: "percent", bp: { alex: a, sam: 10000 - a } })),
);

describe("computeSplit, for any total, rule, ratio and seed", () => {
  it("returns non-negative whole shares that sum exactly to the total, and can be re-derived from the record", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000_00 }),
        baseRule,
        fc.integer({ min: 0, max: 10000 }),
        fc.string(),
        fc.option(fc.integer({ min: 0, max: 500000 }), { nil: undefined }),
        (totalCents, base, alexBp, seed, fixed) => {
          const rule: Rule =
            fixed === undefined ? base : { kind: "fixed_plus_remainder", fixedCents: { sam: fixed }, remainder: base };
          const result = split(totalCents, rule, { seed, ratioBp: { alex: alexBp, sam: 10000 - alexBp } });
          if (!result.ok) {
            expect(result.reason).toBe("fixed_exceeds_total");
            expect(fixed).toBeGreaterThan(totalCents);
            return;
          }
          const values = Object.values(result.shares);
          expect(values.every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
          expect(values.reduce((a, b) => a + b, 0)).toBe(totalCents);
          expect(rederive(result.computation)).toEqual(result.shares);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("splits evenly among three members too", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_00 }), fc.string(), (totalCents, seed) => {
        const result = computeSplit({
          totalCents,
          payerId: "a",
          memberIds: ["a", "b", "c"],
          rule: { kind: "even" },
          seed,
        });
        const values = Object.values(shares(result));
        expect(values.reduce((x, y) => x + y, 0)).toBe(totalCents);
        expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
      }),
    );
  });
});

describe("incomeRatio", () => {
  it("turns incomes into basis points that sum to 10000", () => {
    expect(incomeRatio(members, { alex: 9000000, sam: 6000000 })).toEqual({ ok: true, bp: { alex: 6000, sam: 4000 } });
  });

  it("gives a leftover basis point to the largest fractional part, then by member order", () => {
    // thirds: 3333.33 each, one basis point left over, all fractions equal
    expect(incomeRatio(["a", "b", "c"], { a: 100, b: 100, c: 100 })).toEqual({
      ok: true,
      bp: { a: 3334, b: 3333, c: 3333 },
    });
    // 1/3 and 2/3: 3333.33 and 6666.67, the larger fraction wins
    expect(incomeRatio(members, { alex: 100, sam: 200 })).toEqual({ ok: true, bp: { alex: 3333, sam: 6667 } });
  });

  it("allows one income of zero", () => {
    expect(incomeRatio(members, { alex: 0, sam: 5000000 })).toEqual({ ok: true, bp: { alex: 0, sam: 10000 } });
  });

  it("cannot be computed when a member has no income", () => {
    expect(incomeRatio(members, { alex: 5000000 })).toEqual({ ok: false, reason: "income_missing" });
  });

  it("cannot be computed when every income is zero", () => {
    expect(incomeRatio(members, { alex: 0, sam: 0 })).toEqual({ ok: false, reason: "all_incomes_zero" });
  });

  it("always sums to 10000", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e11 }), fc.integer({ min: 1, max: 1e11 }), (a, b) => {
        const result = incomeRatio(members, { alex: a, sam: b });
        if (!result.ok) throw new Error(result.reason);
        expect(result.bp[alex]! + result.bp[sam]!).toBe(10000);
      }),
    );
  });
});
