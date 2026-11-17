import { describe, expect, it } from "vitest";
import { resplitLine } from "./resplit";

const people = [
  { id: "a", displayName: "Alex" },
  { id: "s", displayName: "Sam" },
];

describe("resplitLine", () => {
  it("says how the stored shares would change when the same amount splits differently", () => {
    expect(resplitLine(people, { a: 6000, s: 4000 }, { a: 6923, s: 3077 })).toBe(
      "Saving will re-split this: Alex $60.00 → $69.23, Sam $40.00 → $30.77",
    );
  });

  it("says nothing when the split is the same", () => {
    expect(resplitLine(people, { a: 6000, s: 4000 }, { a: 6000, s: 4000 })).toBeNull();
  });

  it("says nothing when the amount itself was changed", () => {
    expect(resplitLine(people, { a: 6000, s: 4000 }, { a: 6000, s: 5000 })).toBeNull();
  });

  it("says nothing for an expense stored without shares", () => {
    expect(resplitLine(people, {}, { a: 5000, s: 5000 })).toBeNull();
  });
});
