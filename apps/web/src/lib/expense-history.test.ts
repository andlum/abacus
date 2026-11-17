import { beforeEach, describe, expect, it } from "vitest";
import { expenseHistory } from "./expense-history.ts";
import { createExpense, editExpense } from "./expenses.ts";
import { createWorld, type World } from "./testing/world.ts";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

async function groceries() {
  return createExpense(w.db, w.householdId, {
    kind: "manual",
    actor: w.alex,
    date: "2027-03-20",
    description: "Groceries",
    category: "groceries",
    totalCents: 9000,
    payerId: w.alex.id,
    today: "2027-03-20",
  });
}

const edit = (id: string, totalCents: number, by = w.sam) =>
  editExpense(w.db, by, id, { date: "2027-03-20", description: "Groceries", category: "groceries", totalCents, payerId: w.alex.id }, "2027-03-21");

describe("expenseHistory", () => {
  it("is just the expense when it was never edited", async () => {
    const e = await groceries();
    const h = await expenseHistory(w.db, w.householdId, e.id);
    expect(h.map((v) => [v.id, v.createdBy, v.status])).toEqual([[e.id, w.alex.id, "posted"]]);
  });

  it("lists every version, newest first, with who entered each", async () => {
    const first = await groceries();
    const second = await edit(first.id, 10000);
    const third = await edit(second.id, 12000, w.alex);
    const h = await expenseHistory(w.db, w.householdId, third.id);
    expect(h.map((v) => [v.id, v.totalCents, v.createdBy, v.status])).toEqual([
      [third.id, 12000, w.alex.id, "posted"],
      [second.id, 10000, w.sam.id, "superseded"],
      [first.id, 9000, w.alex.id, "superseded"],
    ]);
    expect(h[2]!.shares).toEqual({ [w.alex.id]: 4500, [w.sam.id]: 4500 });
  });

  it("from an old version, also finds the versions that replaced it", async () => {
    const first = await groceries();
    const second = await edit(first.id, 10000);
    const h = await expenseHistory(w.db, w.householdId, first.id);
    expect(h.map((v) => v.id)).toEqual([second.id, first.id]);
  });

  it("does not reach into another household", async () => {
    const e = await groceries();
    await expect(expenseHistory(w.db, "00000000-0000-0000-0000-000000000000", e.id)).rejects.toThrow("does not exist");
  });
});
