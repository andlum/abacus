import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { account, auditLog, bankTransaction, cardPayment, expense, type Member } from "@/db/schema";
import { getBalance } from "./balance";
import { connectBank, syncConnection, type BankDeps } from "./bank";
import { cardAccount, findPastPayments, getReview, listCardAccounts, setCardMode, sharePastPayment, submitReview } from "./card-review";
import { editExpense, postDue, voidExpense } from "./expenses";
import { createTemplate } from "./templates";
import { fakePlaid, payment, txn } from "./testing/fake-plaid";
import { agree, createWorld, type World } from "./testing/world";

// Connected on 2027-03-01; the card was paid on 2027-03-08; today is
// 2027-03-10 in New York.
const FROM = "2027-03-01";
const TODAY = "2027-03-10";
const NOW = new Date("2027-03-10T15:00:00Z");

let w: World;
let fake: ReturnType<typeof fakePlaid>;
let bank: BankDeps;
let cardId: string;
let connectionId: string;
let cursor = 0;

beforeEach(async () => {
  cursor = 0;
  w = await createWorld();
  fake = fakePlaid();
  bank = { plaid: fake.plaid, key: randomBytes(32) };
  await agree(w, FROM, { rules: [{ scope: "household", rule: { kind: "even" } }] });
  const made = await connectBank(w.db, bank, w.alex, { publicToken: "alex", institutionName: "First Platypus Bank" }, FROM, NOW);
  connectionId = made.connection.id;
  cardId = made.accounts.find((a) => a.lastFour === "1234")!.id;
});

const PURCHASES = [
  txn("t1", { amount: 100, date: "2027-03-02", merchant_name: "Grocer" }),
  txn("t2", { amount: 30, date: "2027-03-04", merchant_name: "Hardware" }),
  txn("t3", { amount: 12, date: "2027-03-06", merchant_name: "Bakery" }),
  // A refund: shown, never picked.
  txn("r1", { amount: -15, date: "2027-03-05", merchant_name: "Grocer" }),
  // After the payment: waits for the next one.
  txn("t4", { amount: 40, date: "2027-03-09", merchant_name: "Cafe" }),
  // Pending, and another card: never shown.
  txn("t5", { amount: 9, date: "2027-03-07", pending: true }),
  txn("t6", { amount: 9, date: "2027-03-07", account_id: "acc-travel" }),
];

async function syncIn(...added: ReturnType<typeof txn>[]) {
  fake.on("alex", cursor ? `c${cursor}` : "", { added, next_cursor: `c${cursor + 1}` });
  cursor++;
  return syncConnection(w.db, bank, connectionId, NOW);
}

async function sharedPaid(dollars = 1200, date = "2027-03-08") {
  await setCardMode(w.db, w.alex, cardId, "shared");
  fake.hold("alex", ...PURCHASES);
  await syncIn(payment(`p-${date}`, dollars, { date }));
  return (await w.db.select().from(cardPayment).where(eq(cardPayment.plaidTransactionId, `p-${date}`)))[0]!;
}

const share = async (id: string | null) => (id ? (await w.db.select().from(expense).where(eq(expense.id, id)))[0]! : null);
const samOwes = async () => 0 - (await getBalance(w.db, w.householdId)).net[w.sam.id]!;
const pick = (id: string, over: object = {}) => ({ plaidTransactionId: id, ...over });
const allAlex = (who: Member = w.alex) => ({ kind: "percent" as const, bp: { [who.id]: 10000, [(who === w.alex ? w.sam : w.alex).id]: 0 } });

describe("sync", () => {
  it("makes a shared card's payment an expense split the usual way, and stores no purchase", async () => {
    const p = await sharedPaid();
    const e = (await share(p.expenseId))!;
    expect(e).toMatchObject({ totalCents: 120000, payerId: w.alex.id, description: "Card payment · Everyday Card 1234", status: "posted" });
    expect(await samOwes()).toBe(60000);
    await syncIn(txn("t1", { amount: 100 }), txn("r9", { amount: -15 }));
    expect(await w.db.select().from(bankTransaction)).toHaveLength(0);
    expect(await w.db.select().from(cardPayment)).toHaveLength(1);
  });

  it("logs a refund as nothing, and a personal card's payment as no expense", async () => {
    const out = await syncIn(txn("r1", { amount: -15 }), payment("p1", 500));
    expect(out.skipped.refund).toBe(1);
    expect(out.payments).toBe(1);
    const [p] = await w.db.select().from(cardPayment);
    expect(p).toMatchObject({ mode: "personal", expenseId: null, amountCents: 50000 });
    expect(await w.db.select().from(expense)).toHaveLength(0);
  });

  it("applies a switch to shared to the next payment only", async () => {
    await syncIn(payment("p1", 500, { date: "2027-03-03" }));
    await setCardMode(w.db, w.alex, cardId, "shared");
    await syncIn(payment("p2", 700, { date: "2027-03-08" }));
    const rows = await w.db.select().from(cardPayment).orderBy(cardPayment.date);
    expect(rows.map((r) => [r.mode, r.expenseId !== null])).toEqual([
      ["personal", false],
      ["shared", true],
    ]);
    const audit = await w.db.select().from(auditLog).where(eq(auditLog.action, "account.card_mode_changed"));
    expect(audit).toHaveLength(1);
  });
});

describe("a shared card's review", () => {
  it("shows the payment's purchases, newest first, from 30 days before it to its day", async () => {
    const p = await sharedPaid();
    const r = await getReview(w.db, bank, w.alex, cardId, {}, NOW);
    expect(r).toMatchObject({ from: "2027-02-06", to: "2027-03-08" });
    expect(r.payment).toMatchObject({ id: p.id, amountCents: 120000, stillSharedCents: 120000 });
    expect(r.lines.map((l) => [l.plaidTransactionId, l.moneyIn])).toEqual([
      ["t3", false],
      ["r1", true],
      ["t2", false],
      ["t1", false],
    ]);
    expect(fake.getCalls.at(-1)).toMatchObject({ startDate: "2027-02-06", endDate: "2027-03-08", accountIds: ["acc-card"] });
  });

  it("takes three picks out of a $1,200.00 payment, each with its own split", async () => {
    const p = await sharedPaid();
    const out = await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1"), pick("t2", { rule: allAlex(), description: "Shelves" }), pick("t3")] }, NOW);
    expect(out.expenses.map((e) => [e.description, e.totalCents])).toEqual([
      ["Grocer", 10000],
      ["Shelves", 3000],
      ["Bakery", 1200],
    ]);
    expect(out.paymentExpense).toMatchObject({ totalCents: 105800, status: "posted" });
    // 1,058 / 2 + 100 / 2 + 0 + 12 / 2
    expect(await samOwes()).toBe(52900 + 5000 + 600);
    const after = (await w.db.select().from(cardPayment).where(eq(cardPayment.id, p.id)))[0]!;
    expect(after.expenseId).toBe(out.paymentExpense!.id);
    expect(after.amountCents).toBe(120000);
    const rows = await w.db.select().from(bankTransaction).orderBy(bankTransaction.plaidTransactionId);
    expect(rows.map((t) => [t.plaidTransactionId, t.state, t.cardPaymentId])).toEqual([
      ["t1", "added", p.id],
      ["t2", "added", p.id],
      ["t3", "added", p.id],
    ]);
  });

  it("adds nothing when one split is not valid", async () => {
    const p = await sharedPaid();
    const bad = { kind: "percent" as const, bp: { [w.alex.id]: 5000 } };
    await expect(submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1"), pick("t2", { rule: bad })] }, NOW)).rejects.toThrow(/not valid/);
    expect(await w.db.select().from(bankTransaction)).toHaveLength(0);
    expect((await share(p.expenseId))!.totalCents).toBe(120000);
    expect(await samOwes()).toBe(60000);
  });

  it("refuses money in, and opens an earlier payment when asked", async () => {
    await sharedPaid(130, "2027-03-03");
    const later = await sharedPaid(142);
    await expect(submitReview(w.db, bank, w.alex, cardId, { items: [pick("r1")] }, NOW)).rejects.toThrow(/money coming in/);
    const earlier = (await w.db.select().from(cardPayment).where(eq(cardPayment.plaidTransactionId, "p-2027-03-03")))[0]!;
    const r = await getReview(w.db, bank, w.alex, cardId, { payment: earlier.id }, NOW);
    expect(r).toMatchObject({ from: "2027-02-01", to: "2027-03-03" });
    expect(r.lines.map((l) => l.plaidTransactionId)).toEqual(["t1"]);
    // The later one starts the day after the earlier.
    expect(await getReview(w.db, bank, w.alex, cardId, { payment: later.id }, NOW)).toMatchObject({ from: "2027-03-04", to: "2027-03-08" });
    const out = await submitReview(w.db, bank, w.alex, cardId, { payment: earlier.id, items: [pick("t1")] }, NOW);
    expect(out.paymentExpense!.totalCents).toBe(3000);
    expect((await share(later.expenseId))!.totalCents).toBe(14200);
  });

  it("voids the payment's expense when the picks are all of it", async () => {
    const p = await sharedPaid(142);
    const out = await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1"), pick("t2"), pick("t3")] }, NOW);
    expect(out.paymentExpense).toBeNull();
    expect((await share(p.expenseId))!.status).toBe("void");
    expect((await w.db.select().from(cardPayment).where(eq(cardPayment.id, p.id)))[0]!.expenseId).toBeNull();
    await expect(submitReview(w.db, bank, w.alex, cardId, { items: [pick("t4")] }, NOW)).rejects.toThrow(/not on this card in the dates/);
  });

  it("refuses picks that add up to more than is still shared", async () => {
    await sharedPaid(120);
    await expect(submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1"), pick("t2")] }, NOW)).rejects.toThrow(/\$130\.00, more than the \$120\.00/);
    expect(await w.db.select().from(bankTransaction)).toHaveLength(0);
  });

  it("puts a voided purchase back into the payment, and posts a payment again that picks had used up", async () => {
    const p = await sharedPaid(142);
    const out = await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1"), pick("t2"), pick("t3")] }, NOW);
    await voidExpense(w.db, w.alex, out.expenses[1]!.id);
    const again = (await w.db.select().from(cardPayment).where(eq(cardPayment.id, p.id)))[0]!;
    expect((await share(again.expenseId))!).toMatchObject({ totalCents: 3000, status: "posted" });
    const t2 = (await w.db.select().from(bankTransaction).where(eq(bankTransaction.plaidTransactionId, "t2")))[0]!;
    expect(t2).toMatchObject({ state: "dismissed", expenseId: null, cardPaymentId: null });
    await voidExpense(w.db, w.alex, out.expenses[0]!.id);
    expect((await share((await w.db.select().from(cardPayment).where(eq(cardPayment.id, p.id)))[0]!.expenseId))!.totalCents).toBe(13000);
    // Picked again in a later review.
    const r = await getReview(w.db, bank, w.alex, cardId, {}, NOW);
    expect(r.lines.find((l) => l.plaidTransactionId === "t2")!.addedExpenseId).toBeNull();
    const redo = await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t2")] }, NOW);
    expect(redo.paymentExpense!.totalCents).toBe(10000);
  });

  it("keeps a payment a person voided voided when a purchase goes back", async () => {
    const p = await sharedPaid();
    const out = await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1")] }, NOW);
    await voidExpense(w.db, w.alex, out.paymentExpense!.id);
    await voidExpense(w.db, w.alex, out.expenses[0]!.id);
    expect((await w.db.select().from(cardPayment).where(eq(cardPayment.id, p.id)))[0]!.expenseId).toBeNull();
    expect(await samOwes()).toBe(0);
  });

  it("shows unpicked purchases again on reopening, and the added ones as added", async () => {
    await sharedPaid();
    const out = await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t2")] }, NOW);
    const r = await getReview(w.db, bank, w.alex, cardId, {}, NOW);
    expect(r.payment!.stillSharedCents).toBe(117000);
    expect(Object.fromEntries(r.lines.map((l) => [l.plaidTransactionId, l.addedExpenseId]))).toEqual({ t1: null, t2: out.expenses[0]!.id, t3: null, r1: null });
  });

  it("adds a purchase submitted twice once", async () => {
    await sharedPaid();
    const both = await Promise.allSettled([
      submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1")] }, NOW),
      submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1")] }, NOW),
    ]);
    expect(both.filter((b) => b.status === "fulfilled")).toHaveLength(1);
    expect((both.find((b) => b.status === "rejected") as PromiseRejectedResult).reason.message).toMatch(/already been added/);
    const live = await w.db.select().from(expense).where(and(eq(expense.householdId, w.householdId), eq(expense.status, "posted")));
    expect(live.map((e) => e.totalCents).sort()).toEqual([10000, 110000]);
  });

  it("suggests a recurring cost a purchase already is, ticked, and ties it without a new expense", async () => {
    await createTemplate(w.db, w.alex, { name: "Internet", amountCents: 3000, cadence: "monthly", dayOfMonth: 4, payerId: w.alex.id, startDate: FROM });
    await postDue(w.db, w.householdId, TODAY);
    await sharedPaid();
    const r = await getReview(w.db, bank, w.alex, cardId, {}, NOW);
    const t2 = r.lines.find((l) => l.plaidTransactionId === "t2")!;
    expect(t2).toMatchObject({ ticked: true, suggestion: { kind: "recurring", name: "Internet" } });
    expect(r.lines.find((l) => l.plaidTransactionId === "t1")!.ticked).toBe(false);
    const out = await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t2", { tieTo: t2.suggestion!.expenseId })] }, NOW);
    expect(out.expenses[0]!.id).toBe(t2.suggestion!.expenseId);
    expect(out.paymentExpense!.totalCents).toBe(117000);
    expect((await w.db.select().from(expense).where(eq(expense.status, "posted"))).length).toBe(2);
    await expect(submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1", { tieTo: t2.suggestion!.expenseId })] }, NOW)).rejects.toThrow(/does not fit/);
  });
});

describe("what the review found", () => {
  it("gives a withdrawn purchase's amount back to the payment it was taken out of, and keeps syncing", async () => {
    await createTemplate(w.db, w.alex, { name: "Internet", amountCents: 3000, cadence: "monthly", dayOfMonth: 4, payerId: w.alex.id, startDate: FROM });
    await postDue(w.db, w.householdId, TODAY);
    const p = await sharedPaid();
    const r = await getReview(w.db, bank, w.alex, cardId, {}, NOW);
    const t2 = r.lines.find((l) => l.plaidTransactionId === "t2")!;
    await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t2", { tieTo: t2.suggestion!.expenseId })] }, NOW);
    fake.on("alex", `c${cursor}`, { removed: [{ transaction_id: "t2" }], next_cursor: `c${cursor + 1}` });
    cursor++;
    await syncConnection(w.db, bank, connectionId, NOW);
    const [row] = await w.db.select().from(bankTransaction).where(eq(bankTransaction.plaidTransactionId, "t2"));
    expect(row).toMatchObject({ state: "removed", expenseId: null, cardPaymentId: null });
    const [after] = await w.db.select().from(cardPayment).where(eq(cardPayment.id, p.id));
    expect((await share(after!.expenseId))!.totalCents).toBe(120000);
    // The next payment still arrives.
    await syncIn(payment("p2", 300, { date: "2027-03-09" }));
    expect((await w.db.select().from(cardPayment)).length).toBe(2);
  });

  it("takes a purchase already in the ledger out of a shared payment, rather than counting it twice", async () => {
    fake.hold("alex", ...PURCHASES);
    const first = await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1")] }, NOW);
    expect(await samOwes()).toBe(5000);
    const p = await sharedPaid(142);
    expect(await samOwes()).toBe(5000 + 7100);
    const r = await getReview(w.db, bank, w.alex, cardId, {}, NOW);
    const t1 = r.lines.find((l) => l.plaidTransactionId === "t1")!;
    expect(t1).toMatchObject({ addedExpenseId: null, ticked: true, suggestion: { kind: "added", expenseId: first.expenses[0]!.id } });
    const out = await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1", { tieTo: t1.suggestion!.expenseId })] }, NOW);
    expect(out.expenses[0]!.id).toBe(first.expenses[0]!.id);
    expect(out.paymentExpense!.totalCents).toBe(4200);
    expect(await samOwes()).toBe(5000 + 2100);
    const [row] = await w.db.select().from(bankTransaction).where(eq(bankTransaction.plaidTransactionId, "t1"));
    expect(row!.cardPaymentId).toBe(p.id);
    // Taken out once: a second time is refused, and it now reads as added.
    await expect(submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1", { tieTo: t1.suggestion!.expenseId })] }, NOW)).rejects.toThrow(/already been added/);
    expect((await getReview(w.db, bank, w.alex, cardId, {}, NOW)).lines.find((l) => l.plaidTransactionId === "t1")!.addedExpenseId).toBe(first.expenses[0]!.id);
    // Voided, its amount goes back into the payment.
    await voidExpense(w.db, w.alex, first.expenses[0]!.id);
    const [after] = await w.db.select().from(cardPayment).where(eq(cardPayment.id, p.id));
    expect((await share(after!.expenseId))!.totalCents).toBe(14200);
  });

  it("refuses an edit to a card payment's amount or date, and allows one to its description", async () => {
    const p = await sharedPaid();
    const e = (await share(p.expenseId))!;
    const base = { date: e.date, description: e.description, totalCents: e.totalCents!, payerId: e.payerId };
    await expect(editExpense(w.db, w.alex, e.id, { ...base, totalCents: 100000 }, TODAY)).rejects.toThrow(/come from the bank/);
    await expect(editExpense(w.db, w.alex, e.id, { ...base, date: "2027-03-09" }, TODAY)).rejects.toThrow(/come from the bank/);
    const renamed = await editExpense(w.db, w.alex, e.id, { ...base, description: "Shared Visa" }, TODAY);
    const [after] = await w.db.select().from(cardPayment).where(eq(cardPayment.id, p.id));
    expect(after!.expenseId).toBe(renamed.id);
  });
});

describe("a personal card's review", () => {
  it("adds the picks, takes nothing out of anything, and starts the next review after it", async () => {
    fake.hold("alex", ...PURCHASES);
    await syncIn(payment("p1", 500));
    const r = await getReview(w.db, bank, w.alex, cardId, {}, NOW);
    expect(r).toMatchObject({ from: "2027-02-08", to: TODAY, payment: null });
    expect(r.lines.every((l) => !l.ticked)).toBe(true);
    // The payment itself is money in, and shown.
    expect(r.lines.map((l) => l.plaidTransactionId)).toEqual(["t4", "t3", "r1", "t2", "t1"]);
    const out = await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t4"), pick("t1")] }, NOW);
    expect(out.expenses.map((e) => e.totalCents)).toEqual([10000, 4000]);
    expect(out.paymentExpense).toBeNull();
    expect(await samOwes()).toBe(7000);
    expect((await w.db.select().from(account).where(eq(account.id, cardId)))[0]!.reviewedThrough).toBe(TODAY);
    expect(await getReview(w.db, bank, w.alex, cardId, {}, new Date("2027-03-12T15:00:00Z"))).toMatchObject({ from: "2027-03-11", to: "2027-03-12" });
    // Widened back, the added ones show as added.
    const wide = await getReview(w.db, bank, w.alex, cardId, { from: "2027-03-01" }, NOW);
    expect(wide.lines.filter((l) => l.addedExpenseId).map((l) => l.plaidTransactionId)).toEqual(["t4", "t1"]);
  });

  it("sets a purchase aside, not into To sort, when the cost it was tied to is voided, and lets it be picked again", async () => {
    await createTemplate(w.db, w.alex, { name: "Internet", amountCents: 3000, cadence: "monthly", dayOfMonth: 4, payerId: w.alex.id, startDate: FROM });
    await postDue(w.db, w.householdId, TODAY);
    fake.hold("alex", ...PURCHASES);
    const r = await getReview(w.db, bank, w.alex, cardId, {}, NOW);
    const t2 = r.lines.find((l) => l.plaidTransactionId === "t2")!;
    expect(t2).toMatchObject({ ticked: false, suggestion: { kind: "recurring", name: "Internet" } });
    await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t2", { tieTo: t2.suggestion!.expenseId })] }, NOW);
    await voidExpense(w.db, w.alex, t2.suggestion!.expenseId);
    const [row] = await w.db.select().from(bankTransaction).where(eq(bankTransaction.plaidTransactionId, "t2"));
    expect(row).toMatchObject({ state: "dismissed", expenseId: null, cardPaymentId: null });
    const again = await getReview(w.db, bank, w.alex, cardId, { from: FROM }, NOW);
    expect(again.lines.find((l) => l.plaidTransactionId === "t2")!.addedExpenseId).toBeNull();
    const out = await submitReview(w.db, bank, w.alex, cardId, { from: FROM, items: [pick("t2")] }, NOW);
    expect(out.expenses.map((e) => e.totalCents)).toEqual([3000]);
  });
});

describe("who can see what", () => {
  it("reads another member's card as not found, everywhere", async () => {
    await sharedPaid();
    await expect(getReview(w.db, bank, w.sam, cardId, {}, NOW)).rejects.toThrow(/not one of yours/);
    await expect(submitReview(w.db, bank, w.sam, cardId, { items: [pick("t1")] }, NOW)).rejects.toThrow(/not one of yours/);
    await expect(setCardMode(w.db, w.sam, cardId, "personal")).rejects.toThrow(/not one of yours/);
    await expect(cardAccount(w.db, w.sam, cardId)).rejects.toThrow(/not one of yours/);
    expect(await listCardAccounts(w.db, w.sam)).toEqual([]);
  });

  it("lists the person's own cards with the latest payment, and asks Plaid for nothing", async () => {
    await sharedPaid();
    const calls = fake.getCalls.length;
    const cards = await listCardAccounts(w.db, w.alex);
    expect(cards.map((c) => [c.lastFour, c.cardMode, c.latestPayment?.stillSharedCents ?? null])).toEqual([
      ["1234", "shared", 120000],
      ["4321", "personal", null],
    ]);
    await cardAccount(w.db, w.alex, cardId);
    expect(fake.getCalls.length).toBe(calls);
  });

  it("refuses a review while the card shares every purchase", async () => {
    await w.db.update(account).set({ shareAll: true }).where(eq(account.id, cardId));
    await expect(getReview(w.db, bank, w.alex, cardId, {}, NOW)).rejects.toThrow(/shares every purchase/);
  });

  it("says so while Plaid is still bringing the card's transactions in", async () => {
    await setCardMode(w.db, w.alex, cardId, "personal");
    fake.failNext("alex", "PRODUCT_NOT_READY");
    await expect(getReview(w.db, bank, w.alex, cardId, {}, NOW)).rejects.toThrow(/still sending/);
  });
});

describe("the database", () => {
  it("never lets purchases taken out of a payment add up to more than it", async () => {
    const p = await sharedPaid(142);
    await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1"), pick("t2"), pick("t3")] }, NOW);
    const [t1] = await w.db.select().from(bankTransaction).where(eq(bankTransaction.plaidTransactionId, "t1"));
    await expect(w.db.update(bankTransaction).set({ amountCents: 10100 }).where(eq(bankTransaction.id, t1!.id))).rejects.toThrow();
    const [t4] = await w.db
      .insert(bankTransaction)
      .values({ householdId: w.householdId, connectionId, accountId: cardId, plaidTransactionId: "t4", date: "2027-03-09", amountCents: 1, description: "x", state: "added", cardPaymentId: p.id })
      .returning()
      .catch((e) => [e]);
    expect(t4).toBeInstanceOf(Error);
  });
});

describe("earlier payments", () => {
  // Plaid holds the card's purchases and a payment the sync never saw.
  const heldPayment = (id = "p0", dollars = 1200, date = "2027-03-08", over: object = {}) => fake.hold("alex", ...PURCHASES, payment(id, dollars, { date, ...over }));
  const live = async () => (await w.db.select().from(expense).where(eq(expense.status, "posted"))).map((e) => e.totalCents).sort((a, b) => a! - b!);

  it("lists a payment the sync never saw, shares it as an expense Alex paid, and opens its review", async () => {
    await setCardMode(w.db, w.alex, cardId, "shared");
    heldPayment();
    const past = await findPastPayments(w.db, bank, w.alex, cardId, NOW);
    expect(past).toEqual([{ plaidTransactionId: "p0", date: "2027-03-08", amountCents: 120000, description: "Payment, thank you", paymentId: null }]);
    expect(fake.getCalls.at(-1)).toMatchObject({ startDate: "2026-12-10", endDate: TODAY, accountIds: ["acc-card"] });
    const p = await sharePastPayment(w.db, bank, w.alex, cardId, "p0", NOW);
    expect(p).toMatchObject({ plaidTransactionId: "p0", mode: "shared", amountCents: 120000 });
    expect(await share(p.expenseId)).toMatchObject({ totalCents: 120000, payerId: w.alex.id, status: "posted", description: "Card payment · Everyday Card 1234" });
    expect(await samOwes()).toBe(60000);
    expect(await findPastPayments(w.db, bank, w.alex, cardId, NOW)).toEqual([]);
    const r = await getReview(w.db, bank, w.alex, cardId, { payment: p.id }, NOW);
    expect(r).toMatchObject({ to: "2027-03-08", payment: { id: p.id, stillSharedCents: 120000 } });
    // The payment itself is on the page, as money in.
    expect(r.lines.map((l) => [l.plaidTransactionId, l.moneyIn, l.cardPayment])).toEqual([
      ["p0", true, true],
      ["t3", false, false],
      ["r1", true, false],
      ["t2", false, false],
      ["t1", false, false],
    ]);
    const audit = await w.db.select().from(auditLog).where(eq(auditLog.action, "card_payment.recorded"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorMemberId: w.alex.id, entityId: p.id });
  });

  it("lists payments newest first, and only card payments in the last 90 days", async () => {
    await setCardMode(w.db, w.alex, cardId, "shared");
    fake.hold(
      "alex",
      ...PURCHASES,
      payment("old", 100, { date: "2026-12-11" }),
      payment("new", 200, { date: "2027-03-09" }),
      payment("ancient", 300, { date: "2026-12-09" }),
      payment("other", 400, { account_id: "acc-travel" }),
      // A refund keeps the merchant's category.
      txn("r2", { amount: -50 }),
    );
    expect((await findPastPayments(w.db, bank, w.alex, cardId, NOW)).map((p) => [p.plaidTransactionId, p.amountCents])).toEqual([
      ["new", 20000],
      ["old", 10000],
    ]);
  });

  it("shares a payment recorded while the card was personal, and its review shows a purchase added in a personal review as added", async () => {
    fake.hold("alex", ...PURCHASES);
    await syncIn(payment("p1", 500, { date: "2027-03-08" }));
    const added = await submitReview(w.db, bank, w.alex, cardId, { items: [pick("t1")] }, NOW);
    await setCardMode(w.db, w.alex, cardId, "shared");
    const [personal] = await w.db.select().from(cardPayment);
    expect(personal).toMatchObject({ mode: "personal", expenseId: null });
    await expect(getReview(w.db, bank, w.alex, cardId, { payment: personal!.id }, NOW)).rejects.toThrow(/made while the card was personal/);
    heldPayment("p1", 500);
    expect(await findPastPayments(w.db, bank, w.alex, cardId, NOW)).toMatchObject([{ plaidTransactionId: "p1", paymentId: personal!.id }]);
    const p = await sharePastPayment(w.db, bank, w.alex, cardId, "p1", NOW);
    expect(p).toMatchObject({ id: personal!.id, mode: "shared", amountCents: 50000 });
    expect((await share(p.expenseId))!.totalCents).toBe(50000);
    expect(await samOwes()).toBe(5000 + 25000);
    expect(await w.db.select().from(cardPayment)).toHaveLength(1);
    const audit = await w.db.select().from(auditLog).where(eq(auditLog.action, "card_payment.shared"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorMemberId: w.alex.id, entityId: p.id, detail: { was: "personal" } });

    const r = await getReview(w.db, bank, w.alex, cardId, { payment: p.id }, NOW);
    const t1 = r.lines.find((l) => l.plaidTransactionId === "t1")!;
    expect(t1).toMatchObject({ ticked: true, suggestion: { kind: "added", expenseId: added.expenses[0]!.id } });
    const out = await submitReview(w.db, bank, w.alex, cardId, { payment: p.id, items: [pick("t1", { tieTo: t1.suggestion!.expenseId })] }, NOW);
    expect(out.expenses[0]!.id).toBe(added.expenses[0]!.id);
    expect(out.paymentExpense!.totalCents).toBe(40000);
    expect(await live()).toEqual([10000, 40000]);
    expect(await samOwes()).toBe(5000 + 20000);
  });

  it("refuses a personal card, and another member's", async () => {
    heldPayment();
    await expect(findPastPayments(w.db, bank, w.alex, cardId, NOW)).rejects.toThrow(/shared card/);
    await expect(sharePastPayment(w.db, bank, w.alex, cardId, "p0", NOW)).rejects.toThrow(/shared card/);
    await setCardMode(w.db, w.alex, cardId, "shared");
    await expect(findPastPayments(w.db, bank, w.sam, cardId, NOW)).rejects.toThrow(/not one of yours/);
    await expect(sharePastPayment(w.db, bank, w.sam, cardId, "p0", NOW)).rejects.toThrow(/not one of yours/);
    expect(await w.db.select().from(cardPayment)).toHaveLength(0);
  });

  it("refuses what is not a card payment of this card in the last 90 days, and stores nothing", async () => {
    await setCardMode(w.db, w.alex, cardId, "shared");
    fake.hold(
      "alex",
      ...PURCHASES,
      payment("other", 400, { account_id: "acc-travel" }),
      payment("ancient", 300, { date: "2026-12-09" }),
      payment("pending", 300, { pending: true }),
      payment("eur", 300, { iso_currency_code: "EUR" }),
    );
    for (const id of ["r1", "t1", "other", "ancient", "pending", "eur", "nope"]) {
      await expect(sharePastPayment(w.db, bank, w.alex, cardId, id, NOW), id).rejects.toThrow(/not a payment to this card in the last 90 days/);
    }
    expect(await w.db.select().from(cardPayment)).toHaveLength(0);
    expect(await w.db.select().from(expense)).toHaveLength(0);
  });

  it("refuses a payment already shared, and shares one only once", async () => {
    const p = await sharedPaid();
    heldPayment("p-2027-03-08");
    await expect(sharePastPayment(w.db, bank, w.alex, cardId, "p-2027-03-08", NOW)).rejects.toThrow(/already shared/);
    heldPayment();
    const both = await Promise.allSettled([sharePastPayment(w.db, bank, w.alex, cardId, "p0", NOW), sharePastPayment(w.db, bank, w.alex, cardId, "p0", NOW)]);
    expect(both.filter((b) => b.status === "fulfilled")).toHaveLength(1);
    expect((both.find((b) => b.status === "rejected") as PromiseRejectedResult).reason.message).toMatch(/already shared/);
    expect(await live()).toEqual([120000, 120000]);
    expect(await samOwes()).toBe(120000);
    expect((await share(p.expenseId))!.totalCents).toBe(120000);
  });

  it("is not posted twice when the sync later sees a payment shared by hand", async () => {
    await setCardMode(w.db, w.alex, cardId, "shared");
    heldPayment();
    await sharePastPayment(w.db, bank, w.alex, cardId, "p0", NOW);
    const out = await syncIn(payment("p0", 1200, { date: "2027-03-08" }));
    expect(out.payments).toBe(0);
    expect(out.skipped.already_stored).toBe(1);
    expect(await live()).toEqual([120000]);
    expect(await w.db.select().from(cardPayment)).toHaveLength(1);
  });

  it("refuses a payment recorded for a different card", async () => {
    await setCardMode(w.db, w.alex, cardId, "shared");
    heldPayment();
    const [travel] = await w.db.select().from(account).where(eq(account.lastFour, "4321"));
    await w.db.insert(cardPayment).values({ householdId: w.householdId, accountId: travel!.id, plaidTransactionId: "p0", date: "2027-03-08", amountCents: 120000, mode: "personal" });
    await expect(sharePastPayment(w.db, bank, w.alex, cardId, "p0", NOW)).rejects.toThrow(/not on this card/);
    expect(await live()).toEqual([]);
  });
});
