import { describe, expect, it } from "vitest";
import { importCounts } from "./import-counts";
import type { ImportRow } from "./transfer";

const row = (over: Partial<ImportRow>): ImportRow => ({
  line: 2,
  id: null,
  date: "2027-03-01",
  description: "Rent",
  category: "housing",
  totalCents: 200000,
  payerId: "a",
  old: null,
  status: "posted",
  shares: { a: 100000, s: 100000 },
  ruleSource: "household",
  unassignedReason: null,
  ...over,
});
const old = { status: "posted" as const, totalCents: 200000, payerId: "a", shares: { a: 100000, s: 100000 } };

describe("importCounts", () => {
  it("counts new rows, replaced rows, and replaced rows whose split changes", () => {
    expect(
      importCounts([
        row({}),
        row({ id: "e1", old }),
        row({ id: "e2", old, shares: { a: 120000, s: 80000 } }),
        row({ id: "e3", old: { ...old, status: "unassigned" } }),
      ]),
    ).toEqual({ total: 4, added: 1, replaced: 3, resplit: 2, onDefault: 0, unsplit: 0 });
  });

  it("counts rows on the even-split default and rows that cannot be split", () => {
    expect(
      importCounts([row({ ruleSource: "default" }), row({ status: "unassigned", shares: {}, ruleSource: null, unassignedReason: "income_missing" })]),
    ).toMatchObject({ onDefault: 1, unsplit: 1 });
  });
});
