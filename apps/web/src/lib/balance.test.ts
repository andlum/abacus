import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog } from "@/db/schema";
import { seedHousehold } from "@/db/test-db";
import { editSettlement, getBalance, getSettlement, listSettlements, recordSettlement, voidSettlement } from "./balance";
import { addAccount } from "./accounts";
import { createExpense, voidExpense } from "./expenses";
import { createWorld, type World } from "./testing/world";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

const today = "2026-10-31";

const spend = (payer: "alex" | "sam", totalCents: number, over: object = {}) =>
  createExpense(w.db, w.householdId, {
    kind: "manual",
    actor: w[payer],
    date: "2026-10-10",
    description: "Groceries",
    totalCents,
    payerId: w[payer].id,
    today,
    ...over,
  });

const pay = (from: "alex" | "sam", amountCents: number, over: object = {}) =>
  recordSettlement(
    w.db,
    w[from],
    { fromMemberId: w[from].id, toMemberId: w[from === "alex" ? "sam" : "alex"].id, amountCents, date: today, ...over },
    today,
  );

describe("getBalance", () => {
  it("is zero for everyone in a new household", async () => {
    expect(await getBalance(w.db, w.householdId)).toEqual({
      net: { [w.alex.id]: 0, [w.sam.id]: 0 },
      owes: [],
      entries: [],
    });
  });

  it("says the other partner owes their share to whoever paid", async () => {
    await spend("alex", 10000);
    const balance = await getBalance(w.db, w.householdId);
    expect(balance.net).toEqual({ [w.alex.id]: 5000, [w.sam.id]: -5000 });
    expect(balance.owes).toEqual([{ from: w.sam.id, to: w.alex.id, amountCents: 5000 }]);
  });

  it("nets expenses paid by each partner against each other", async () => {
    await spend("alex", 10000);
    await spend("sam", 4000);
    const balance = await getBalance(w.db, w.householdId);
    expect(balance.owes).toEqual([{ from: w.sam.id, to: w.alex.id, amountCents: 3000 }]);
  });

  it("lists what each entry did to each position", async () => {
    const e = await spend("alex", 10000);
    const p = await pay("sam", 2000);
    const { entries } = await getBalance(w.db, w.householdId);
    expect(entries).toEqual([
      { kind: "expense", id: e.id, date: "2026-10-10", description: "Groceries", effect: { [w.alex.id]: 5000, [w.sam.id]: -5000 } },
      { kind: "settlement", id: p.id, date: today, description: "", effect: { [w.sam.id]: 2000, [w.alex.id]: -2000 } },
    ]);
  });

  it("counts every account's costs in a household, whose accounts have no kind", async () => {
    const card = await addAccount(w.db, w.alex, { name: "Joint card" });
    expect(card.kind).toBeNull();
    const e = await spend("alex", 10000, { accountId: card.id });
    const balance = await getBalance(w.db, w.householdId);
    expect(balance.owes).toEqual([{ from: w.sam.id, to: w.alex.id, amountCents: 5000 }]);
    expect(balance.entries.map((x) => x.id)).toEqual([e.id]);
  });

  it("leaves out expenses that are voided, unassigned, or waiting", async () => {
    const gone = await spend("alex", 10000);
    await voidExpense(w.db, w.alex, gone.id);
    await spend("alex", 6000, { rule: { kind: "income_proportional" } });
    const balance = await getBalance(w.db, w.householdId);
    expect(balance.net).toEqual({ [w.alex.id]: 0, [w.sam.id]: 0 });
    expect(balance.entries).toEqual([]);
  });
});

describe("settling up", () => {
  it("brings the balance to zero when the full amount is paid", async () => {
    await spend("alex", 10000);
    await pay("sam", 5000);
    const balance = await getBalance(w.db, w.householdId);
    expect(balance.net).toEqual({ [w.alex.id]: 0, [w.sam.id]: 0 });
    expect(balance.owes).toEqual([]);
  });

  it("can be recorded by either partner, for either direction", async () => {
    await spend("alex", 10000);
    await recordSettlement(
      w.db,
      w.alex,
      { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents: 5000, date: today, note: "Bank transfer" },
      today,
    );
    expect((await getBalance(w.db, w.householdId)).owes).toEqual([]);
    expect((await listSettlements(w.db, w.householdId))[0]).toMatchObject({ note: "Bank transfer", createdBy: w.alex.id });
  });

  it("flips who owes whom when someone overpays", async () => {
    await spend("alex", 10000);
    await pay("sam", 7000);
    expect((await getBalance(w.db, w.householdId)).owes).toEqual([{ from: w.alex.id, to: w.sam.id, amountCents: 2000 }]);
  });

  it("is undone by voiding the payment, which stays on record", async () => {
    await spend("alex", 10000);
    const payment = await pay("sam", 5000);
    await voidSettlement(w.db, w.alex, payment.id);
    expect((await getBalance(w.db, w.householdId)).net[w.sam.id]).toBe(-5000);
    expect((await listSettlements(w.db, w.householdId))[0]).toMatchObject({ status: "void", voidedBy: w.alex.id });
    await expect(voidSettlement(w.db, w.alex, payment.id)).rejects.toThrow(/already voided/);
  });

  it("refuses a zero amount, a future date, and paying yourself", async () => {
    await expect(pay("sam", 0)).rejects.toThrow(/amount/);
    await expect(pay("sam", 100, { date: "2026-11-01" })).rejects.toThrow(/later than today/);
    await expect(pay("sam", 100, { toMemberId: w.sam.id })).rejects.toThrow(/different people/);
  });
});

describe("editing a payment", () => {
  const edit = (id: string, over: object = {}) =>
    editSettlement(w.db, w.alex, id, { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents: 4000, date: today, note: "", ...over }, today);

  it("replaces the old row with a new one that points back at it, and only the new one counts", async () => {
    await spend("alex", 10000);
    const old = await pay("sam", 5000);
    const next = await edit(old.id, { note: "Rent" });
    expect(next).toMatchObject({ supersedesId: old.id, amountCents: 4000, note: "Rent", status: "recorded", createdBy: w.alex.id });
    expect((await getBalance(w.db, w.householdId)).owes).toEqual([{ from: w.sam.id, to: w.alex.id, amountCents: 1000 }]);
    const rows = await listSettlements(w.db, w.householdId);
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      [old.id, "void"],
      [next.id, "recorded"],
    ]);
  });

  it("leaves the payment alone when it is saved with nothing changed", async () => {
    const old = await pay("sam", 4000);
    const same = await edit(old.id, { date: old.date, note: old.note });
    expect(same.id).toBe(old.id);
    expect((await listSettlements(w.db, w.householdId)).map((r) => [r.id, r.status])).toEqual([[old.id, "recorded"]]);
  });

  it("writes one audit entry naming both rows, without the amount", async () => {
    const old = await pay("sam", 5000);
    const next = await edit(old.id);
    const entries = await w.db.select().from(auditLog).where(eq(auditLog.action, "settlement.edited"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entityType: "settlement", entityId: next.id, detail: { supersedesId: old.id } });
  });

  it("refuses a payment already replaced or voided, so two edits of one payment cannot both go through", async () => {
    const old = await pay("sam", 5000);
    await edit(old.id);
    await expect(edit(old.id, { amountCents: 3000 })).rejects.toThrow(/replaced or voided/);
    const gone = await pay("sam", 2000);
    await voidSettlement(w.db, w.alex, gone.id);
    await expect(edit(gone.id)).rejects.toThrow(/replaced or voided/);
    expect((await listSettlements(w.db, w.householdId)).filter((r) => r.status === "recorded")).toHaveLength(1);
  });

  it("lets only one of two edits started together through", async () => {
    const old = await pay("sam", 5000);
    const results = await Promise.allSettled([edit(old.id, { amountCents: 4000 }), edit(old.id, { amountCents: 3000 })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await listSettlements(w.db, w.householdId)).filter((r) => r.status === "recorded")).toHaveLength(1);
  });

  it("checks the new values as a new payment is checked, and leaves the old row when it refuses", async () => {
    const old = await pay("sam", 5000);
    await expect(edit(old.id, { amountCents: 0 })).rejects.toThrow(/amount/);
    await expect(edit(old.id, { date: "2026-11-01" })).rejects.toThrow(/later than today/);
    await expect(edit(old.id, { toMemberId: w.sam.id })).rejects.toThrow(/different people/);
    expect((await listSettlements(w.db, w.householdId))[0]).toMatchObject({ id: old.id, status: "recorded" });
  });

  it("does not find another group's payment", async () => {
    const old = await pay("sam", 5000);
    const other = await seedHousehold(w.db);
    await expect(
      editSettlement(w.db, other.alex, old.id, { fromMemberId: other.sam.id, toMemberId: other.alex.id, amountCents: 100, date: today }, today),
    ).rejects.toThrow(/does not exist/);
    await expect(edit("not-an-id")).rejects.toThrow(/does not exist/);
  });
});

describe("getSettlement", () => {
  it("gives the payment with the one it replaced and the one that replaced it", async () => {
    const first = await pay("sam", 5000);
    const second = await editSettlement(w.db, w.alex, first.id, { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents: 4000, date: today }, today);
    const shown = await getSettlement(w.db, w.householdId, second.id);
    expect(shown).toMatchObject({ row: { id: second.id }, replaced: { id: first.id, amountCents: 5000 }, replacedBy: null });
    expect(await getSettlement(w.db, w.householdId, first.id)).toMatchObject({ row: { id: first.id }, replaced: null, replacedBy: { id: second.id } });
    expect(await getSettlement(w.db, w.householdId, "not-an-id")).toBeNull();
    const other = await seedHousehold(w.db);
    expect(await getSettlement(w.db, other.household.id, second.id)).toBeNull();
  });
});

describe("for any run of expenses and payments", () => {
  it("positions always sum to zero, and paying what is owed settles everything", async () => {
    const step = fc.record({
      kind: fc.constantFrom("expense" as const, "payment" as const),
      who: fc.constantFrom("alex" as const, "sam" as const),
      cents: fc.integer({ min: 1, max: 500000 }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 8 }), async (steps) => {
        w = await createWorld();
        for (const s of steps) {
          if (s.kind === "expense") await spend(s.who, s.cents);
          else await pay(s.who, s.cents);
        }
        const balance = await getBalance(w.db, w.householdId);
        expect(balance.net[w.alex.id]! + balance.net[w.sam.id]!).toBe(0);
        for (const o of balance.owes) {
          await recordSettlement(w.db, w.alex, { fromMemberId: o.from, toMemberId: o.to, amountCents: o.amountCents, date: today }, today);
        }
        const after = await getBalance(w.db, w.householdId);
        expect(Object.values(after.net)).toEqual([0, 0]);
      }),
      { numRuns: 15 },
    );
  }, 60_000);
});
