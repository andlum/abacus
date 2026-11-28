// The card review in a business group
// (docs/specs/2026-11-27-business-card-log.md): pick, label, log.
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { account, cardPayment, expense, household, member, merchantCategory, type Member } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import type { Db } from "@/db/types";
import { UserError } from "@abacus/core/errors";
import { setAccountKind } from "./accounts";
import { connectBank, syncConnection, type BankDeps } from "./bank";
import { cardAccount, getReview, submitReview } from "./card-review";
import { addStarterCategories, DEFAULT_CATEGORIES, listCategories, missingStarters, seedCategories, setCategoryTax } from "./categories";
import { createExpense, editExpense } from "./expenses";
import { getOwedBack } from "./owed-back";
import { fakePlaid, payment, txn } from "./testing/fake-plaid";
import { createWorld } from "./testing/world";

const FROM = "2027-03-01";
const TODAY = "2027-03-10";
const NOW = new Date("2027-03-10T15:00:00Z");

let db: Db;
let fake: ReturnType<typeof fakePlaid>;
let bank: BankDeps;
let bizId: string;
let alex: Member;
let cardId: string;
let travelId: string;
let connectionId: string;

async function addMember(name: string) {
  const [m] = await db
    .insert(member)
    .values({ householdId: bizId, email: `${name.toLowerCase()}@example.com`, displayName: name, linkedAt: new Date() })
    .returning();
  return m!;
}

// Alex's one-person business with two cards connected, neither marked yet.
beforeEach(async () => {
  db = await createTestDb();
  fake = fakePlaid();
  bank = { plaid: fake.plaid, key: randomBytes(32) };
  const [biz] = await db.insert(household).values({ name: "Alex Studio", kind: "business", timezone: "America/New_York" }).returning();
  bizId = biz!.id;
  await seedCategories(db, bizId, "business");
  alex = await addMember("Alex");
  const made = await connectBank(db, bank, alex, { publicToken: "alex", institutionName: "First Platypus Bank" }, FROM, NOW);
  connectionId = made.connection.id;
  cardId = made.accounts.find((a) => a.lastFour === "1234")!.id;
  travelId = made.accounts.find((a) => a.lastFour === "4321")!.id;
});

// Sixteen purchases of $10.00 to $160.00 on the Everyday Card, one a day.
const SIXTEEN = Array.from({ length: 16 }, (_, i) =>
  txn(`b${i + 1}`, { amount: (i + 1) * 10, date: `2027-02-${String(i + 10).padStart(2, "0")}`, merchant_name: `Shop ${i + 1}` }),
);

const review = (id = cardId, opts: { from?: string } = {}) => getReview(db, bank, alex, id, opts, NOW);
const log = (items: Parameters<typeof submitReview>[4]["items"], id = cardId, from?: string) => submitReview(db, bank, alex, id, { items, from }, NOW);
const pick = (id: string, over: object = {}) => ({ plaidTransactionId: id, ...over });
const owed = async () => (await getOwedBack(db, bizId))!.members.find((m) => m.memberId === alex.id)!.owedCents;

describe("whose card it is", () => {
  it("refuses a review until the card is marked, then opens it", async () => {
    fake.hold("alex", ...SIXTEEN);
    await expect(review()).rejects.toThrow("first say whether this account is personal or business");
    await expect(log([pick("b1")])).rejects.toThrow("first say whether this account is personal or business");
    expect((await cardAccount(db, alex, cardId)).kind).toBeNull();
    await setAccountKind(db, alex, cardId, "business");
    expect((await cardAccount(db, alex, cardId)).kind).toBe("business");
    expect((await review()).lines).toHaveLength(16);
  });

  it("asks nothing of a household's card", async () => {
    const w = await createWorld();
    const made = await connectBank(w.db, bank, w.alex, { publicToken: "alex", institutionName: "First Platypus Bank" }, FROM, NOW);
    const r = await getReview(w.db, bank, w.alex, made.accounts[0]!.id, {}, NOW);
    expect(r.account.kind).toBeNull();
    expect(r.splits).toBe(true);
  });
});

describe("pick", () => {
  it("starts every purchase on a business card picked, and none on a personal card", async () => {
    fake.hold("alex", ...SIXTEEN, txn("r1", { amount: -15, date: "2027-02-20" }), txn("p1", { account_id: "acc-travel", amount: 62, date: "2027-03-02" }));
    await setAccountKind(db, alex, cardId, "business");
    await setAccountKind(db, alex, travelId, "personal");
    const mine = await review();
    expect(mine.account.kind).toBe("business");
    expect(mine.lines.filter((l) => !l.moneyIn).every((l) => l.picked)).toBe(true);
    // A refund is shown and cannot be picked.
    expect(mine.lines.find((l) => l.plaidTransactionId === "r1")).toMatchObject({ moneyIn: true, picked: false });
    const theirs = await review(travelId);
    expect(theirs.lines.map((l) => l.picked)).toEqual([false]);
  });

  it("logs 14 of 16 with no rule, all the owner's, and the two left out stay out", async () => {
    fake.hold("alex", ...SIXTEEN);
    await setAccountKind(db, alex, cardId, "business");
    const done = await log(SIXTEEN.slice(0, 14).map((t) => pick(t.transaction_id)));
    expect(done.expenses).toHaveLength(14);
    const rows = await db.select().from(expense).where(eq(expense.householdId, bizId));
    expect(rows).toHaveLength(14);
    for (const e of rows) {
      expect(e).toMatchObject({ chosenRule: null, status: "posted", payerId: alex.id, accountId: cardId, businessUseBp: 10000 });
    }
    expect(done.expenses.every((e) => (e as { shares?: Record<string, number> }).shares?.[alex.id] === e.totalCents)).toBe(true);
    const [a] = await db.select().from(account).where(eq(account.id, cardId));
    expect(a!.reviewedThrough).toBe(TODAY);
    // Nothing since: the two left out are behind the reviewed date.
    expect((await review()).lines).toHaveLength(0);
    const wide = await review(cardId, { from: "2027-02-10" });
    expect(wide.lines.filter((l) => !l.addedExpenseId).map((l) => l.plaidTransactionId).sort()).toEqual(["b15", "b16"]);
  });

  it("says a one-person group has nothing to split, and a two-person one has", async () => {
    fake.hold("alex", ...SIXTEEN);
    await setAccountKind(db, alex, cardId, "business");
    expect((await review()).splits).toBe(false);
    await addMember("Sam");
    expect((await review()).splits).toBe(true);
  });
});

describe("what the business owes its owner", () => {
  it("counts a purchase picked on a personal card, and not one on a business card", async () => {
    fake.hold("alex", txn("b1", { amount: 40, date: "2027-03-02" }), txn("p1", { account_id: "acc-travel", amount: 62, date: "2027-03-02" }));
    await setAccountKind(db, alex, cardId, "business");
    await setAccountKind(db, alex, travelId, "personal");
    await log([pick("b1")]);
    expect(await owed()).toBe(0);
    await log([pick("p1")], travelId);
    expect(await owed()).toBe(6200);
  });

  it("counts only the business part of a purchase, and keeps the whole amount on the expense", async () => {
    fake.hold("alex", txn("p1", { account_id: "acc-travel", amount: 100, date: "2027-03-02", merchant_name: "Phone Co" }));
    await setAccountKind(db, alex, travelId, "personal");
    await expect(log([pick("p1", { businessUseBp: 5000 })], travelId)).rejects.toThrow("say why");
    await expect(log([pick("p1", { businessUseBp: 0, useBasis: "none of it" })], travelId)).rejects.toThrow(UserError);
    const done = await log([pick("p1", { businessUseBp: 5000, useBasis: "half the calls are clients", note: "March bill" })], travelId);
    expect(done.expenses[0]).toMatchObject({ totalCents: 10000, businessUseBp: 5000, useBasis: "half the calls are clients", note: "March bill", vendor: "Phone Co" });
    expect(await owed()).toBe(5000);
  });

  it("rounds the business part to the cent for each expense", async () => {
    const [acct] = await db.select().from(account).where(eq(account.id, travelId));
    await setAccountKind(db, alex, travelId, "personal");
    const spend = (totalCents: number) =>
      createExpense(db, bizId, {
        kind: "manual", actor: alex, date: "2027-03-02", description: "Desk", totalCents, payerId: alex.id, accountId: acct!.id, today: TODAY,
        businessUseBp: 3333, useBasis: "a third of the room",
      });
    await spend(1000);
    await spend(1000);
    // 333.3 rounds to 333 each: 666, not round(666.6) = 667.
    expect(await owed()).toBe(666);
  });

  it("keeps vendor, note and business use on an edit that leaves them out, and changes them when given", async () => {
    await setAccountKind(db, alex, travelId, "personal");
    const first = await createExpense(db, bizId, {
      kind: "manual", actor: alex, date: "2027-03-02", description: "Phone", totalCents: 10000, payerId: alex.id, accountId: travelId, today: TODAY,
      vendor: "Phone Co", note: "March", businessUseBp: 5000, useBasis: "half the calls are clients",
    });
    const same = { date: first.date, description: "Phone bill", totalCents: 10000, payerId: alex.id };
    const kept = await editExpense(db, alex, first.id, same, TODAY);
    expect(kept).toMatchObject({ vendor: "Phone Co", note: "March", businessUseBp: 5000, useBasis: "half the calls are clients" });
    const whole = await editExpense(db, alex, kept.id, { ...same, businessUseBp: 10000, note: "" }, TODAY);
    expect(whole).toMatchObject({ vendor: "Phone Co", note: null, businessUseBp: 10000, useBasis: null });
    expect(await owed()).toBe(10000);
  });

  it("refuses a business-use share in a household", async () => {
    const w = await createWorld();
    await expect(
      createExpense(w.db, w.householdId, {
        kind: "manual", actor: w.alex, date: "2027-03-02", description: "Phone", totalCents: 10000, payerId: w.alex.id, today: TODAY,
        businessUseBp: 5000, useBasis: "half",
      }),
    ).rejects.toThrow("only in a business group");
  });
});

describe("the category remembered by merchant", () => {
  it("starts a merchant's rows in the category last chosen, and the newest choice wins", async () => {
    fake.hold(
      "alex",
      txn("b1", { amount: 20, date: "2027-03-02", merchant_name: "Cloud  Host" }),
      txn("b2", { amount: 20, date: "2027-03-03", merchant_name: "Cloud Host" }),
      txn("b3", { amount: 20, date: "2027-03-04", merchant_name: "cloud host" }),
      txn("b4", { amount: 9, date: "2027-03-04", merchant_name: "Corner Shop" }),
    );
    await setAccountKind(db, alex, cardId, "business");
    expect((await review()).lines.map((l) => l.category)).toEqual(["other", "other", "other", "other"]);
    await log([pick("b1", { category: "software" })], cardId, FROM);
    const again = await review(cardId, { from: FROM });
    expect(Object.fromEntries(again.lines.map((l) => [l.plaidTransactionId, l.category]))).toMatchObject({ b2: "software", b3: "software", b4: "other" });
    await log([pick("b2", { category: "travel" })], cardId, FROM);
    const third = await review(cardId, { from: FROM });
    expect(third.lines.find((l) => l.plaidTransactionId === "b3")!.category).toBe("travel");
    expect(await db.select().from(merchantCategory)).toHaveLength(1);
  });
});

describe("a card payment in a business group", () => {
  it("makes no expense, whatever card_mode says, and the review runs by date", async () => {
    await setAccountKind(db, alex, cardId, "business");
    // As a card made shared before business groups stopped asking.
    await db.update(account).set({ cardMode: "shared" }).where(eq(account.id, cardId));
    fake.on("alex", "", { added: [payment("pay1", 500, { date: "2027-03-08" })], next_cursor: "c1" });
    await syncConnection(db, bank, connectionId, NOW);
    const [p] = await db.select().from(cardPayment);
    expect(p).toMatchObject({ mode: "personal", expenseId: null, amountCents: 50000 });
    expect(await db.select().from(expense)).toHaveLength(0);
    fake.hold("alex", txn("b1", { amount: 40, date: "2027-03-09" }));
    const r = await review();
    expect(r).toMatchObject({ payment: null, to: TODAY });
    expect(r.lines.map((l) => l.plaidTransactionId)).toEqual(["b1"]);
  });
});

describe("categories for the tax form", () => {
  it("starts a new business with the Schedule C list, meals at half", async () => {
    const rows = await listCategories(db, bizId);
    expect(rows).toHaveLength(DEFAULT_CATEGORIES.business.length);
    const by = Object.fromEntries(rows.map((c) => [c.slug, c]));
    expect(by.advertising).toMatchObject({ label: "Advertising", taxLine: "8", halfDeductible: false });
    expect(by.meals).toMatchObject({ taxLine: "24b", halfDeductible: true });
    expect(by.software).toMatchObject({ label: "Software and subscriptions", taxLine: "27b" });
    expect(by.other).toMatchObject({ taxLine: null });
  });

  it("offers an older business the ones it lacks, and adds them when asked", async () => {
    const [old] = await db.insert(household).values({ name: "Old Studio", kind: "business" }).returning();
    const { category } = await import("@/db/schema");
    await db.insert(category).values([
      { householdId: old!.id, slug: "software", label: "Software" },
      { householdId: old!.id, slug: "other", label: "Other" },
    ]);
    const [sam] = await db.insert(member).values({ householdId: old!.id, email: "sam@example.com", displayName: "Sam", linkedAt: new Date() }).returning();
    const missing = await missingStarters(db, old!.id, "business");
    expect(missing.map((c) => c.slug)).toContain("advertising");
    expect(missing.map((c) => c.slug)).not.toContain("software");
    await addStarterCategories(db, sam!);
    expect(await missingStarters(db, old!.id, "business")).toEqual([]);
    const rows = await listCategories(db, old!.id);
    // What it had keeps its name and gets no line by itself.
    expect(rows.find((c) => c.slug === "software")).toMatchObject({ label: "Software", taxLine: null });
    expect(rows.find((c) => c.slug === "meals")).toMatchObject({ taxLine: "24b", halfDeductible: true });
  });

  it("lets a group set the line on its own category", async () => {
    const set = await setCategoryTax(db, alex, "software", { taxLine: " 18 ", halfDeductible: false });
    expect(set).toMatchObject({ taxLine: "18", halfDeductible: false });
    const cleared = await setCategoryTax(db, alex, "software", { taxLine: "", halfDeductible: true });
    expect(cleared).toMatchObject({ taxLine: null, halfDeductible: true });
    await expect(setCategoryTax(db, alex, "software", { taxLine: "x".repeat(20), halfDeductible: false })).rejects.toThrow(UserError);
  });
});
