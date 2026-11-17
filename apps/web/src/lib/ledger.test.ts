import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { expense, household, member, settlement } from "@/db/schema";
import { seedHousehold } from "@/db/test-db";
import { addAccount } from "./accounts";
import { editSettlement, recordSettlement, voidSettlement } from "./balance";
import { seedCategories } from "./categories";
import { createExpense, voidExpense } from "./expenses";
import { listLedger, parseLedgerForm, type LedgerItem } from "./ledger";
import { recordReimbursement } from "./owed-back";
import { createWorld, type World } from "./testing/world";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

const TODAY = "2026-03-31";

const spend = (description: string, totalCents: number, more: Record<string, unknown> = {}) =>
  createExpense(w.db, w.householdId, {
    kind: "manual",
    actor: w.alex,
    date: "2026-03-10",
    description,
    totalCents,
    payerId: w.alex.id,
    today: TODAY,
    ...more,
  });

const pay = (amountCents: number, more: Record<string, unknown> = {}) =>
  recordSettlement(w.db, w.sam, { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents, date: "2026-03-10", ...more }, TODAY);

const ledger = async (params: Record<string, string> = {}, householdId = w.householdId) => {
  const { filter, page } = parseLedgerForm((k) => params[k] ?? "");
  return listLedger(w.db, householdId, filter, page);
};

// Each row as "kind what": the expense's description, the payment's note.
const said = (i: LedgerItem) =>
  i.kind === "expense" ? `expense ${i.expense.description}` : i.kind === "payment" ? `payment ${i.payment.note}` : `repayment ${i.repayment.note}`;
const rows = async (params: Record<string, string> = {}) => (await ledger(params)).items.map(said);

describe("the ledger", () => {
  it("lists expenses and payments together, newest first, with counts for each", async () => {
    await spend("Paper", 1000, { date: "2026-03-01" });
    await pay(5000, { date: "2026-03-15", note: "March" });
    await spend("Ink", 2500, { date: "2026-03-20" });
    const got = await ledger();
    expect(got.items.map(said)).toEqual(["expense Ink", "payment March", "expense Paper"]);
    expect(got).toMatchObject({ count: 3, counts: { expense: 2, payment: 1, repayment: 0 }, expenseTotalCents: 3500, nextCursor: null });
  });

  it("orders one day's rows by when they were entered", async () => {
    const e = await spend("Paper", 1000);
    const p = await pay(5000, { note: "Cash" });
    await w.db.update(expense).set({ createdAt: sql`'2026-03-10 09:00:00.000002+00'::timestamptz` }).where(eq(expense.id, e.id));
    await w.db.update(settlement).set({ createdAt: sql`'2026-03-10 09:00:00.000001+00'::timestamptz` }).where(eq(settlement.id, p.id));
    expect(await rows()).toEqual(["expense Paper", "payment Cash"]);
  });

  it("walks every page once across both kinds", async () => {
    for (let i = 0; i < 4; i++) {
      await spend(`E${i}`, 100, { date: `2026-03-0${i + 1}` });
      await pay(100, { date: `2026-03-0${i + 1}`, note: `P${i}` });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 20; n++) {
      const got = await ledger({ limit: "3", ...(cursor ? { cursor } : {}) });
      seen.push(...got.items.map(said));
      cursor = got.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(8);
    expect(seen).toEqual(await rows({ limit: "50" }));
  });

  it("hides voided and replaced rows unless asked, and says which a payment was", async () => {
    const gone = await spend("Gone", 100);
    await voidExpense(w.db, w.alex, gone.id);
    const voided = await pay(100, { note: "Voided" });
    await voidSettlement(w.db, w.alex, voided.id);
    const old = await pay(5000, { note: "Old" });
    await editSettlement(w.db, w.alex, old.id, { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents: 4000, date: "2026-03-10", note: "New" }, TODAY);
    expect(await rows()).toEqual(["payment New"]);
    expect((await rows({ status: "void" })).sort()).toEqual(["expense Gone", "payment Voided"]);
    expect(await rows({ status: "superseded" })).toEqual(["payment Old"]);
    const all = await ledger({ status: "all" });
    expect(all.items).toHaveLength(4);
    const shown = Object.fromEntries(all.items.filter((i) => i.kind === "payment").map((i) => [i.payment.note, i.kind === "payment" && i.replaced]));
    expect(shown).toEqual({ New: false, Voided: false, Old: true });
  });

  it("narrows payments by date, month, amount, search and who paid; expense-only filters leave them out", async () => {
    await spend("Paper", 1000);
    await pay(5000, { note: "Rent share" });
    await pay(700, { date: "2026-02-10", note: "February" });
    expect(await rows({ month: "2026-02" })).toEqual(["payment February"]);
    expect(await rows({ from: "2026-03-01" })).toEqual(["payment Rent share", "expense Paper"]);
    expect(await rows({ min: "40.00" })).toEqual(["payment Rent share"]);
    expect(await rows({ q: "rent" })).toEqual(["payment Rent share"]);
    expect(await rows({ payer: w.alex.id })).toEqual(["expense Paper"]);
    expect((await rows({ payer: w.sam.id })).sort()).toEqual(["payment February", "payment Rent share"]);
    expect(await rows({ category: "groceries" })).toEqual([]);
    expect(await rows({ source: "manual" })).toEqual(["expense Paper"]);
    expect(await rows({ status: "unassigned" })).toEqual([]);
  });

  it("intersects a month with From and To, and refuses a month it cannot read", async () => {
    await pay(100, { date: "2026-03-05", note: "Early" });
    await pay(100, { date: "2026-03-25", note: "Late" });
    expect(await rows({ month: "2026-03", from: "2026-03-20" })).toEqual(["payment Late"]);
    expect(() => parseLedgerForm((k) => (k === "month" ? "March" : ""))).toThrow(/Month/);
  });

  it("refuses a cursor it did not make", async () => {
    await pay(100);
    await expect(ledger({ cursor: "nonsense!" })).rejects.toThrow("cursor");
    await expect(ledger({ cursor: Buffer.from("payment:not-an-id").toString("base64url") })).rejects.toThrow("cursor");
  });

  it("never shows another group's rows, and refuses its rows as a cursor", async () => {
    await pay(100, { note: "Ours" });
    const other = await seedHousehold(w.db);
    const theirs = await recordSettlement(
      w.db,
      other.alex,
      { fromMemberId: other.sam.id, toMemberId: other.alex.id, amountCents: 100, date: "2026-03-10", note: "Theirs" },
      TODAY,
    );
    expect(await rows({ status: "all" })).toEqual(["payment Ours"]);
    await expect(ledger({ cursor: Buffer.from(`payment:${theirs.id}`).toString("base64url") })).rejects.toThrow("cursor");
  });

  it("lists a business's repayments too", async () => {
    const [biz] = await w.db.insert(household).values({ name: "Alex Studio", kind: "business" }).returning();
    await seedCategories(w.db, biz!.id, "business");
    const [alex] = await w.db
      .insert(member)
      .values({ householdId: biz!.id, email: "alex@example.com", displayName: "Alex", linkedAt: new Date() })
      .returning();
    const card = await addAccount(w.db, alex!, { name: "Studio card", kind: "business" });
    await recordReimbursement(w.db, alex!, { memberId: alex!.id, amountCents: 2000, date: "2026-03-12", note: "Back", accountId: card.id }, TODAY);
    const got = await ledger({}, biz!.id);
    expect(got.items.map(said)).toEqual(["repayment Back"]);
    expect(got.counts).toEqual({ expense: 0, payment: 0, repayment: 1 });
  });
});
