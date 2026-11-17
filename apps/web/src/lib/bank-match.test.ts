import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { account, auditLog, bankConnection, bankTransaction, expense, household, member, type Member } from "@/db/schema";
import { addFromBank, billSuggestions, notThisPurchase, connectBank, listToSort, matchBill, setShareAll, syncConnection, type BankDeps } from "./bank";
import { listTies, tieFor } from "./bank-match";
import { seedCategories } from "./categories";
import { recentActivity } from "./activity";
import { agree } from "./testing/world";
import { editExpense, postDue, voidExpense } from "./expenses";
import { createTemplate } from "./templates";
import { fakePlaid, txn } from "./testing/fake-plaid";
import { createWorld, type World } from "./testing/world";

const FROM = "2027-03-01";
const NOW = new Date("2027-03-20T15:00:00Z");
const TODAY = "2027-03-20";

let w: World;
let fake: ReturnType<typeof fakePlaid>;
let bank: BankDeps;
let connectionId: string;
let cardId: string;
let cursor = "";
let n = 0;

beforeEach(async () => {
  cursor = "";
  w = await createWorld();
  fake = fakePlaid();
  bank = { plaid: fake.plaid, key: randomBytes(32) };
  const { connection, accounts } = await connectBank(w.db, bank, w.alex, { publicToken: "alex", institutionName: "Bank" }, FROM, NOW);
  connectionId = connection.id;
  cardId = accounts[0]!.id;
});


async function sync(added: ReturnType<typeof txn>[] = [], removed: string[] = []) {
  const next = `c${++n}`;
  fake.on("alex", cursor, { added, removed: removed.map((transaction_id) => ({ transaction_id })), next_cursor: next });
  cursor = next;
  return syncConnection(w.db, bank, connectionId, NOW);
}

// A recurring cost on `day` (the 5th), in March 2027.
const cost = (name: string, over: { amountCents?: number | null; day?: number; payer?: Member } = {}) =>
  createTemplate(w.db, w.alex, {
    name,
    amountCents: over.amountCents === undefined ? 8000 : over.amountCents,
    cadence: "monthly",
    dayOfMonth: over.day ?? 5,
    payerId: (over.payer ?? w.alex).id,
    startDate: FROM,
  });
const post = () => postDue(w.db, w.householdId, TODAY);
const expenses = () => w.db.select().from(expense);
const tx = async (id: string) => (await w.db.select().from(bankTransaction).where(eq(bankTransaction.plaidTransactionId, id)))[0]!;
const actions = async () => (await w.db.select().from(auditLog)).map((a) => a.action);

describe("a purchase that is a recurring cost", () => {
  it("is tied to the expense, with no second expense, and never appears in To sort", async () => {
    await cost("Internet");
    const [internet] = await post();
    const summary = await sync([txn("t1", { amount: 80, date: "2027-03-06" })]);
    expect(summary).toMatchObject({ tied: 1, toSort: 0, added: 0 });
    expect(await expenses()).toHaveLength(1);
    expect(await tx("t1")).toMatchObject({ state: "added", expenseId: internet!.id });
    expect(await listToSort(w.db, w.alex)).toEqual([]);
    const [entry] = await w.db.select().from(auditLog).where(eq(auditLog.action, "bank_transaction.tied"));
    expect(entry).toMatchObject({ actorKind: "system", detail: { expenseId: internet!.id } });
    expect(internet!.shares && Object.values(internet!.shares).reduce((a, b) => a + b, 0)).toBe(8000);
  });

  it.each([
    ["4 days before", "2027-03-06", "added"],
    ["4 days after", "2027-03-14", "added"],
    ["5 days before", "2027-03-05", "to_sort"],
    ["5 days after", "2027-03-15", "to_sort"],
  ])("%s the expense: %s is %s", async (_, date, state) => {
    await cost("Internet", { day: 10 });
    await post();
    await sync([txn("t1", { amount: 80, date })]);
    expect((await tx("t1")).state).toBe(state);
  });

  it("is not tied when the amount differs or another member paid", async () => {
    await cost("Internet");
    await cost("Gym", { payer: w.sam, amountCents: 3000 });
    await post();
    await sync([txn("t1", { amount: 80.01 }), txn("t2", { amount: 30 })]);
    expect((await tx("t1")).state).toBe("to_sort");
    expect((await tx("t2")).state).toBe("to_sort");
  });

  it("is left to sort when two expenses fit", async () => {
    await cost("Internet");
    await cost("Phone");
    await post();
    expect(await sync([txn("t1", { amount: 80 })])).toMatchObject({ tied: 0, toSort: 1 });
  });

  it("ties neither of two same-amount purchases in one sync", async () => {
    await cost("Internet");
    await post();
    expect(await sync([txn("t1", { amount: 80 }), txn("t2", { amount: 80 })])).toMatchObject({ tied: 0, toSort: 2 });
  });

  it("does not reuse an expense that is already tied", async () => {
    await cost("Internet");
    await post();
    await sync([txn("t1", { amount: 80 })]);
    expect(await sync([txn("t2", { amount: 80 })])).toMatchObject({ tied: 0, toSort: 1 });
    expect((await tx("t1")).state).toBe("added");
  });

  it("ties nothing when one purchase is already waiting as the cost posts and a second fits", async () => {
    await cost("Internet");
    await sync([txn("t1", { amount: 80 }), txn("t2", { amount: 80, date: "2027-03-07" })]);
    await post();
    expect((await tx("t1")).state).toBe("to_sort");
    expect((await tx("t2")).state).toBe("to_sort");
  });

  it("ties only a purchase on the account the cost is paid from", async () => {
    const [card, other] = await w.db.select().from(account).where(eq(account.householdId, w.householdId));
    await w.db.update(account).set({ name: "Other" }).where(eq(account.id, other!.id));
    await createTemplate(w.db, w.alex, { name: "Internet", amountCents: 8000, cadence: "monthly", dayOfMonth: 5, payerId: w.alex.id, accountId: other!.id, startDate: FROM });
    await post();
    await sync([txn("t1", { amount: 80 })]);
    expect((await tx("t1")).accountId).toBe(card!.id);
    expect((await tx("t1")).state).toBe("to_sort");
    await sync([txn("t2", { amount: 80, account_id: other!.plaidAccountId! })]);
    expect((await tx("t2")).state).toBe("added");
  });

  it("is not counted twice when the account shares everything", async () => {
    await cost("Internet");
    await post();
    await setShareAll(w.db, w.alex, cardId, true);
    await sync([txn("t1", { amount: 80 }), txn("t2", { amount: 20 })]);
    expect((await expenses()).map((e) => e.source).sort()).toEqual(["bank", "template"]);
    expect((await tx("t1")).state).toBe("added");
    expect((await tx("t1")).expenseId).not.toBe((await tx("t2")).expenseId);
  });

  it("is tied when it arrived before the cost was posted", async () => {
    await cost("Internet");
    await sync([txn("t1", { amount: 80, date: "2027-03-08" })]);
    expect((await tx("t1")).state).toBe("to_sort");
    const [internet] = await post();
    expect(await tx("t1")).toMatchObject({ state: "added", expenseId: internet!.id });
    expect(await expenses()).toHaveLength(1);
  });

  it("is not tied backwards when two waiting purchases fit the cost", async () => {
    await cost("Internet");
    await sync([txn("t1", { amount: 80 }), txn("t2", { amount: 80 })]);
    await post();
    expect((await tx("t1")).state).toBe("to_sort");
    expect((await tx("t2")).state).toBe("to_sort");
  });

  it("leaves a purchase already added as its own expense alone when the cost posts later", async () => {
    await cost("Internet");
    await sync([txn("t1", { amount: 80, date: "2027-03-08" })]);
    const own = await addFromBank(w.db, w.alex, (await tx("t1")).id, {}, TODAY);
    await post();
    expect(await expenses()).toHaveLength(2);
    expect((await tx("t1")).expenseId).toBe(own.id);
    expect(own.status).toBe("posted");
  });

  it("lets the bank withdraw it: the tie is dropped and the expense stays", async () => {
    await cost("Internet");
    const [internet] = await post();
    await sync([txn("t1", { amount: 80 })]);
    const summary = await sync([], ["t1"]);
    expect(summary.removed).toBe(1);
    expect(await tx("t1")).toMatchObject({ state: "removed", expenseId: null });
    expect((await expenses())[0]).toMatchObject({ id: internet!.id, status: "posted", totalCents: 8000 });
    expect(await actions()).toContain("bank_transaction.untied");
  });

  it("goes back to To sort when the expense is voided", async () => {
    await cost("Internet");
    const [internet] = await post();
    await sync([txn("t1", { amount: 80 })]);
    await voidExpense(w.db, w.alex, internet!.id);
    expect(await tx("t1")).toMatchObject({ state: "to_sort", expenseId: null, sortedAt: null });
    expect(await listToSort(w.db, w.alex)).toHaveLength(1);
  });

  it("follows the expense when it is edited", async () => {
    await cost("Internet");
    const [internet] = await post();
    await sync([txn("t1", { amount: 80 })]);
    const next = await editExpense(w.db, w.alex, internet!.id, { date: internet!.date, description: "Internet", totalCents: 8000, payerId: w.alex.id }, TODAY);
    expect(await tx("t1")).toMatchObject({ state: "added", expenseId: next.id });
    expect(await actions()).toContain("bank_transaction.retied");
    // And still can be voided back to the list.
    await voidExpense(w.db, w.alex, next.id);
    expect((await tx("t1")).state).toBe("to_sort");
  });

  it("shows its description only to the connection's owner", async () => {
    await cost("Internet");
    const [internet] = await post();
    await sync([txn("t1", { amount: 80, merchant_name: "Fibre Co" })]);
    expect(await tieFor(w.db, w.alex, internet!.id)).toMatchObject({ date: "2027-03-05", description: "Fibre Co" });
    expect(await tieFor(w.db, w.sam, internet!.id)).toBeNull();
  });
});

describe("a bill waiting for its amount", () => {
  async function electricity(over: Parameters<typeof cost>[1] = {}) {
    await cost("Electricity", { amountCents: null, ...over });
    const [bill] = await post();
    return bill!;
  }

  it("is only offered, and choosing it sets the amount and ties the purchase", async () => {
    const bill = await electricity();
    expect(bill.status).toBe("needs_amount");
    expect(await sync([txn("t1", { amount: 123.45, date: "2027-03-12" })])).toMatchObject({ tied: 0, toSort: 1 });
    const waiting = await listToSort(w.db, w.alex);
    const offer = (await billSuggestions(w.db, w.alex, waiting)).get(waiting[0]!.id);
    expect(offer).toEqual([{ expenseId: bill.id, name: "Electricity", date: "2027-03-05" }]);

    const done = await matchBill(w.db, w.alex, waiting[0]!.id, bill.id);
    expect(done).toMatchObject({ status: "posted", totalCents: 12345 });
    expect(Object.values(done.shares).reduce((a, b) => a + b, 0)).toBe(12345);
    expect(await tx("t1")).toMatchObject({ state: "added", expenseId: bill.id });
    expect(await actions()).toEqual(expect.arrayContaining(["expense.amount_entered", "bank_transaction.tied"]));
  });

  it("is not offered beyond 10 days, for another payer, or in a list of more than three", async () => {
    await electricity();
    await sync([txn("far", { amount: 50, date: "2027-03-16" }), txn("near", { amount: 50, date: "2027-03-14" })]);
    const waiting = await listToSort(w.db, w.alex);
    const offers = await billSuggestions(w.db, w.alex, waiting);
    expect(offers.get(waiting.find((t) => t.plaidTransactionId === "far")!.id)).toBeUndefined();
    expect(offers.get(waiting.find((t) => t.plaidTransactionId === "near")!.id)).toHaveLength(1);
    for (const name of ["Water", "Gas", "Trash"]) await cost(name, { amountCents: null, day: 12 });
    await post();
    const again = await billSuggestions(w.db, w.alex, waiting);
    expect(again.get(waiting.find((t) => t.plaidTransactionId === "near")!.id)).toHaveLength(3);
  });

  it("cannot be taken by the other member, another group, or for a bill someone else pays", async () => {
    const bill = await electricity();
    await sync([txn("t1", { amount: 50, date: "2027-03-12" })]);
    const row = await tx("t1");
    await expect(matchBill(w.db, w.sam, row.id, bill.id)).rejects.toThrow(/not one of yours/);
    const [h] = await w.db.insert(household).values({ name: "Jo's place", timezone: "America/New_York" }).returning();
    await seedCategories(w.db, h!.id, "household");
    const [jo] = await w.db.insert(member).values({ householdId: h!.id, email: "jo@example.com", displayName: "Jo", linkedAt: new Date() }).returning();
    await expect(matchBill(w.db, jo!, row.id, bill.id)).rejects.toThrow(/not one of yours/);
    expect((await tx("t1")).state).toBe("to_sort");

    await w.db.update(expense).set({ payerId: w.sam.id }).where(eq(expense.id, bill.id));
    await expect(matchBill(w.db, w.alex, row.id, bill.id)).rejects.toThrow(/not waiting for an amount/);
    expect(await billSuggestions(w.db, w.alex, [row])).toEqual(new Map());
    expect((await expenses())[0]!.status).toBe("needs_amount");
  });
});

describe("edits, privacy and mistakes", () => {
  const edit = (id: string, date: string, over: { totalCents?: number; payerId?: string }) =>
    editExpense(w.db, w.alex, id, { date, description: "Internet", totalCents: over.totalCents ?? 8000, payerId: over.payerId ?? w.alex.id }, TODAY);

  it("drops the tie when an edit changes the total", async () => {
    await cost("Internet");
    const [internet] = await post();
    await sync([txn("t1", { amount: 80 })]);
    await edit(internet!.id, internet!.date, { totalCents: 9000 });
    expect(await tx("t1")).toMatchObject({ state: "to_sort", expenseId: null });
    expect(await actions()).toContain("bank_transaction.untied");
  });

  it("drops the tie when an edit changes the payer", async () => {
    await cost("Internet");
    const [internet] = await post();
    await sync([txn("t1", { amount: 80 })]);
    await edit(internet!.id, internet!.date, { payerId: w.sam.id });
    expect(await tx("t1")).toMatchObject({ state: "to_sort", expenseId: null });
  });

  it("keeps a bank-made expense's purchase with its edit", async () => {
    await sync([txn("t1", { amount: 20 })]);
    const own = await addFromBank(w.db, w.alex, (await tx("t1")).id, {}, TODAY);
    const next = await editExpense(w.db, w.alex, own.id, { date: own.date, description: "Shop", totalCents: 2500, payerId: w.alex.id }, TODAY);
    expect(await tx("t1")).toMatchObject({ state: "added", expenseId: next.id });
  });

  it("shows ties, unties and retied matches only to the connection's owner, and Sam's void does not make Sam the sorter", async () => {
    await cost("Internet");
    const [internet] = await post();
    await sync([txn("t1", { amount: 80 })]);
    await edit(internet!.id, internet!.date, {});
    const names = new Map<string, string>();
    const mine = (await recentActivity(w.db, w.householdId, names, 50, w.alex)).map((a) => a.text);
    expect(mine).toEqual(expect.arrayContaining(["Matched a card purchase to a recurring cost"]));
    for (const viewer of [w.sam, undefined]) {
      const texts = (await recentActivity(w.db, w.householdId, names, 50, viewer)).map((a) => a.text);
      expect(texts.filter((t) => /card purchase/.test(t))).toEqual([]);
    }
    await w.db.update(bankTransaction).set({ sortedBy: null });
    const [live] = await w.db.select().from(expense).where(eq(expense.status, "posted"));
    await voidExpense(w.db, w.sam, live!.id);
    expect(await tx("t1")).toMatchObject({ state: "to_sort", sortedBy: null });
    const sams = (await recentActivity(w.db, w.householdId, names, 50, w.sam)).map((a) => a.text);
    expect(sams.filter((t) => /card purchase/.test(t))).toEqual([]);
  });

  it("sets a voided tie aside in the owner's name, not the partner's, when the bank is gone", async () => {
    await cost("Internet");
    const [internet] = await post();
    await sync([txn("t1", { amount: 80 })]);
    await w.db.update(bankConnection).set({ accessToken: null, removedAt: NOW });
    await voidExpense(w.db, w.sam, internet!.id);
    expect(await tx("t1")).toMatchObject({ state: "dismissed", sortedBy: w.alex.id });
  });

  it("lets the owner say 'not this purchase', and never ties it again", async () => {
    await cost("Internet");
    const [internet] = await post();
    await sync([txn("t1", { amount: 80 })]);
    const row = await tx("t1");
    const [line] = await listTies(w.db, w.alex, TODAY);
    expect(line).toMatchObject({ transactionId: row.id, costName: "Internet", amountCents: 8000 });
    expect(await listTies(w.db, w.sam, TODAY)).toEqual([]);

    await expect(notThisPurchase(w.db, w.sam, row.id)).rejects.toThrow(/not one of yours/);
    const [h] = await w.db.insert(household).values({ name: "Jo's place", timezone: "America/New_York" }).returning();
    await seedCategories(w.db, h!.id, "household");
    const [jo] = await w.db.insert(member).values({ householdId: h!.id, email: "jo@example.com", displayName: "Jo", linkedAt: new Date() }).returning();
    await expect(notThisPurchase(w.db, jo!, row.id)).rejects.toThrow(/not one of yours/);
    expect((await tx("t1")).state).toBe("added");

    await notThisPurchase(w.db, w.alex, row.id);
    expect(await tx("t1")).toMatchObject({ state: "to_sort", expenseId: null, noAutoTie: true });
    expect((await expenses())[0]).toMatchObject({ id: internet!.id, status: "posted" });
    expect(await actions()).toContain("bank_transaction.untied");
    await expect(notThisPurchase(w.db, w.alex, row.id)).rejects.toThrow(/not matched/);

    // Not on the next sync, and not when the next cost posts.
    await sync([]);
    expect((await tx("t1")).state).toBe("to_sort");
    await cost("Phone", { day: 7 });
    await post();
    expect((await tx("t1")).state).toBe("to_sort");
  });

  it("does not offer or tie a purchase set aside from matching when its cost posts later", async () => {
    await cost("Internet");
    await sync([txn("t1", { amount: 80 })]);
    await w.db.update(bankTransaction).set({ noAutoTie: true });
    await post();
    expect((await tx("t1")).state).toBe("to_sort");
  });

  it("sets the amount of a bill whose shares come out unassigned, and ties it", async () => {
    await agree(w, FROM, { rules: [{ scope: "household", rule: { kind: "income_proportional" } }] });
    await cost("Electricity", { amountCents: null });
    const [bill] = await post();
    await sync([txn("t1", { amount: 60, date: "2027-03-08" })]);
    const done = await matchBill(w.db, w.alex, (await tx("t1")).id, bill!.id);
    expect(done).toMatchObject({ status: "unassigned", totalCents: 6000 });
    expect(await tx("t1")).toMatchObject({ state: "added", expenseId: bill!.id });
  });
});
