import { beforeEach, describe, expect, it } from "vitest";
import { previewSplit } from "./split-preview";
import { agree, createWorld, type World } from "./testing/world";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

const people = () => [w.alex, w.sam];

describe("previewSplit", () => {
  it("uses the even-split default and says so when nothing is agreed", async () => {
    const p = await previewSplit(w.db, w.householdId, people(), {
      totalCents: 10000,
      payerId: w.alex.id,
      category: "groceries",
      date: "2026-10-05",
    });
    expect(p).toMatchObject({ ok: true, isDefault: true, shares: { [w.alex.id]: 5000, [w.sam.id]: 5000 } });
    if (p.ok) expect(p.why).toContain("even-split default");
  });

  it("uses the category rule agreed for the expense's date", async () => {
    await agree(w, "2026-10-01", {
      rules: [{ scope: "category", category: "dining", rule: { kind: "percent", bp: { [w.alex.id]: 7000, [w.sam.id]: 3000 } } }],
    });
    const p = await previewSplit(w.db, w.householdId, people(), {
      totalCents: 10000,
      payerId: w.sam.id,
      category: "dining",
      date: "2026-10-05",
    });
    expect(p).toMatchObject({ ok: true, isDefault: false, shares: { [w.alex.id]: 7000, [w.sam.id]: 3000 } });
    if (p.ok) expect(p.rule).toBe("Alex 70%, Sam 30%");
  });

  it("says who owes whom because of this expense", async () => {
    const p = await previewSplit(w.db, w.householdId, people(), {
      totalCents: 10000,
      payerId: w.alex.id,
      category: "other",
      date: "2026-10-05",
    });
    if (p.ok) expect(p.effect).toBe("Sam will owe Alex $50.00 for this.");
  });

  it("flags an odd cent that is drawn when saved", async () => {
    const p = await previewSplit(w.db, w.householdId, people(), {
      totalCents: 1001,
      payerId: w.alex.id,
      category: "other",
      date: "2026-10-05",
    });
    expect(p).toMatchObject({ ok: true, leftoverCents: 1 });
  });

  it("explains why it cannot be split", async () => {
    const p = await previewSplit(w.db, w.householdId, people(), {
      totalCents: 1000,
      payerId: w.alex.id,
      category: "other",
      date: "2026-10-05",
      rule: { kind: "fixed_plus_remainder", fixedCents: { [w.alex.id]: 5000 }, remainder: { kind: "even" } },
    });
    expect(p).toMatchObject({ ok: false });
    if (!p.ok) {
      expect(p.why).toContain("more than the total");
      expect(p.reason).toBe("fixed_exceeds_total");
    }
  });

  it("answers an invalid split before it looks at the category", async () => {
    const p = await previewSplit(w.db, w.householdId, people(), {
      totalCents: 1000,
      payerId: w.alex.id,
      category: "no such category",
      date: "2026-10-05",
      rule: { kind: "percent", bp: { [w.alex.id]: 5000 } },
    });
    expect(p).toMatchObject({ ok: false, reason: "invalid_rule" });
  });
});
