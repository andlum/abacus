// The split calculation. Pure: no database, no clock, no randomness beyond
// the seed it is given. Money is integer cents, percentages integer basis
// points.

export type BaseRule =
  | { kind: "even" }
  | { kind: "percent"; bp: Record<string, number> }
  | { kind: "income_proportional" };

export type Rule =
  | BaseRule
  // Named members pay a fixed amount first; the rest is split by `remainder`.
  | { kind: "fixed_plus_remainder"; fixedCents: Record<string, number>; remainder: BaseRule };

export type RuleKind = Rule["kind"];

export type SplitInput = {
  totalCents: number;
  payerId: string;
  // Order matters only as the starting order for the seeded draw.
  memberIds: string[];
  rule: Rule;
  seed: string;
  // Required when the rule, or its nested rule, is income_proportional.
  ratioBp?: Record<string, number>;
};

// Everything needed to re-derive the shares: see `rederive`.
export type SplitComputation = {
  version: 1;
  rule: Rule;
  totalCents: number;
  payerId: string;
  memberIds: string[];
  ratioBp?: Record<string, number>;
  seed: string;
  rounding: { leftoverCents: number; receivedBy: string[] };
};

export type SplitFailure = "invalid_total" | "invalid_rule" | "ratio_unavailable" | "fixed_exceeds_total";

export type SplitResult =
  | { ok: true; shares: Record<string, number>; computation: SplitComputation }
  | { ok: false; reason: SplitFailure };

const BP = 10000;

function isCents(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

function validBp(bp: Record<string, number>, memberIds: string[]): boolean {
  const keys = Object.keys(bp);
  if (keys.some((k) => !memberIds.includes(k))) return false;
  let sum = 0;
  for (const id of memberIds) {
    const v = bp[id] ?? 0;
    if (!isCents(v)) return false;
    sum += v;
  }
  return sum === BP;
}

// xmur3 string hash feeding mulberry32: small, well-known, and stable across
// platforms, so a stored seed always reproduces the same draw.
function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  let a = (h ^ (h >>> 16)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Round every share down, then hand each leftover cent to a member drawn
// from those whose exact share was not a whole number of cents.
function byWeights(
  totalCents: number,
  memberIds: string[],
  weights: number[],
  seed: string,
): { shares: number[]; leftoverCents: number; receivedBy: string[] } {
  const total = BigInt(totalCents);
  const weightSum = weights.reduce((a, b) => a + BigInt(b), 0n);
  const shares: number[] = [];
  const inexact: number[] = [];
  weights.forEach((w, i) => {
    const product = total * BigInt(w);
    shares.push(Number(product / weightSum));
    if (product % weightSum !== 0n) inexact.push(i);
  });
  const leftoverCents = totalCents - shares.reduce((a, b) => a + b, 0);

  const next = rng(seed);
  const receivedBy: string[] = [];
  for (let n = 0; n < leftoverCents; n++) {
    const pick = Math.floor(next() * inexact.length);
    const [index] = inexact.splice(pick, 1);
    shares[index!]! += 1;
    receivedBy.push(memberIds[index!]!);
  }
  return { shares, leftoverCents, receivedBy };
}

export function computeSplit(input: SplitInput): SplitResult {
  const { totalCents, payerId, memberIds, rule, seed, ratioBp } = input;
  if (!isCents(totalCents)) return { ok: false, reason: "invalid_total" };
  if (memberIds.length === 0 || new Set(memberIds).size !== memberIds.length) {
    return { ok: false, reason: "invalid_rule" };
  }

  const base: BaseRule = rule.kind === "fixed_plus_remainder" ? rule.remainder : rule;
  const fixed = memberIds.map(() => 0);
  if (rule.kind === "fixed_plus_remainder") {
    for (const [id, cents] of Object.entries(rule.fixedCents)) {
      const index = memberIds.indexOf(id);
      if (index < 0 || !isCents(cents)) return { ok: false, reason: "invalid_rule" };
      fixed[index] = cents;
    }
  }
  const fixedSum = fixed.reduce((a, b) => a + b, 0);
  if (fixedSum > totalCents) return { ok: false, reason: "fixed_exceeds_total" };

  let weights: number[];
  let usedRatio = false;
  if (base.kind === "even") {
    weights = memberIds.map(() => 1);
  } else if (base.kind === "percent") {
    if (!validBp(base.bp, memberIds)) return { ok: false, reason: "invalid_rule" };
    weights = memberIds.map((id) => base.bp[id] ?? 0);
  } else if (base.kind === "income_proportional") {
    if (!ratioBp) return { ok: false, reason: "ratio_unavailable" };
    if (!validBp(ratioBp, memberIds)) return { ok: false, reason: "ratio_unavailable" };
    weights = memberIds.map((id) => ratioBp[id] ?? 0);
    usedRatio = true;
  } else {
    return { ok: false, reason: "invalid_rule" };
  }

  const split = byWeights(totalCents - fixedSum, memberIds, weights, seed);
  const shares: Record<string, number> = {};
  memberIds.forEach((id, i) => {
    shares[id] = fixed[i]! + split.shares[i]!;
  });

  return {
    ok: true,
    shares,
    computation: {
      version: 1,
      rule,
      totalCents,
      payerId,
      memberIds,
      ...(usedRatio ? { ratioBp } : {}),
      seed,
      rounding: { leftoverCents: split.leftoverCents, receivedBy: split.receivedBy },
    },
  };
}

// Re-derive the shares from a stored computation record alone.
export function rederive(computation: SplitComputation): Record<string, number> {
  const result = computeSplit({
    totalCents: computation.totalCents,
    payerId: computation.payerId,
    memberIds: computation.memberIds,
    rule: computation.rule,
    seed: computation.seed,
    ratioBp: computation.ratioBp,
  });
  if (!result.ok) throw new Error(`computation cannot be re-derived: ${result.reason}`);
  return result.shares;
}

export type RatioResult =
  | { ok: true; bp: Record<string, number> }
  | { ok: false; reason: "income_missing" | "all_incomes_zero" };

// Incomes to basis points summing to 10000. A leftover basis point goes to
// the largest fractional part, then by member order. No randomness here.
export function incomeRatio(memberIds: string[], annualCents: Record<string, number>): RatioResult {
  const incomes: bigint[] = [];
  for (const id of memberIds) {
    const v = annualCents[id];
    if (v === undefined || !isCents(v)) return { ok: false, reason: "income_missing" };
    incomes.push(BigInt(v));
  }
  const sum = incomes.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return { ok: false, reason: "all_incomes_zero" };

  const floors = incomes.map((v) => Number((v * BigInt(BP)) / sum));
  const fractions = incomes.map((v) => (v * BigInt(BP)) % sum);
  let leftover = BP - floors.reduce((a, b) => a + b, 0);
  const order = memberIds
    .map((_, i) => i)
    .sort((a, b) => (fractions[a]! === fractions[b]! ? a - b : fractions[a]! > fractions[b]! ? -1 : 1));
  for (const i of order) {
    if (leftover === 0) break;
    floors[i]! += 1;
    leftover -= 1;
  }

  const bp: Record<string, number> = {};
  memberIds.forEach((id, i) => {
    bp[id] = floors[i]!;
  });
  return { ok: true, bp };
}

// Whether a value, for example one read from a form or from JSON, is a rule
// this calculation can run for these members.
export function isValidRule(value: unknown, memberIds: string[]): value is Rule {
  if (typeof value !== "object" || value === null) return false;
  const rule = value as Rule;
  if (rule.kind === "fixed_plus_remainder") {
    if (typeof rule.fixedCents !== "object" || rule.fixedCents === null) return false;
    for (const [id, cents] of Object.entries(rule.fixedCents)) {
      if (!memberIds.includes(id) || !isCents(cents)) return false;
    }
    const inner = rule.remainder as Rule | undefined;
    return inner?.kind !== "fixed_plus_remainder" && isValidRule(inner, memberIds);
  }
  if (rule.kind === "even" || rule.kind === "income_proportional") return true;
  if (rule.kind === "percent") {
    return typeof rule.bp === "object" && rule.bp !== null && validBp(rule.bp, memberIds);
  }
  return false;
}

export function usesIncome(rule: Rule): boolean {
  return (rule.kind === "fixed_plus_remainder" ? rule.remainder : rule).kind === "income_proportional";
}
