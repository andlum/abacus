import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { expense, household } from "@/db/schema";
import { seedHousehold } from "@/db/test-db";
import { addAccount } from "./accounts";
import { addCategory } from "./categories";
import {
  DEFAULT_LIMIT,
  FORM_NAMES,
  listExpenses,
  MAX_LIMIT,
  parseExpenseFilter,
  parseExpensePage,
  parseListForm,
  type ExpenseFilter,
  type ExpensePage,
} from "./expense-list";
import { createExpense, editExpense, postDue, voidExpense } from "./expenses";
import { createTemplate } from "./templates";
import { createWorld, legacyProposal, type World } from "./testing/world";

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

const filter = (params: Record<string, string> = {}): ExpenseFilter => parseExpenseFilter((k) => params[k]);
const page = (params: Record<string, string> = {}): ExpensePage => parseExpensePage((k) => params[k]);
const list = async (params: Record<string, string> = {}) => listExpenses(w.db, w.householdId, filter(params), page(params));
const names = async (params: Record<string, string> = {}) => (await list(params)).items.map((e) => e.description);

// Every page, following nextCursor, as descriptions.
async function walk(params: Record<string, string>, between?: (n: number) => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 100; n++) {
    const got = await list({ ...params, ...(cursor ? { cursor } : {}) });
    seen.push(...got.items.map((e) => e.description));
    if (!got.nextCursor) return seen;
    cursor = got.nextCursor;
    await between?.(n);
  }
  throw new Error("did not end");
}

// Sets a row's created_at exactly, microseconds included.
const stamp = (id: string, at: string) => w.db.update(expense).set({ createdAt: sql`${at}::timestamptz` }).where(eq(expense.id, id));

describe("the list of all expenses", () => {
  it("lists newest first, with how many match and what they add up to", async () => {
    await spend("Paper", 1000, { date: "2026-03-01" });
    await spend("Ink", 2500, { date: "2026-03-20" });
    const got = await list();
    expect(got.items.map((e) => e.description)).toEqual(["Ink", "Paper"]);
    expect(got).toMatchObject({ count: 2, totalCents: 3500, nextCursor: null });
    expect(Object.values(got.items[0]!.shares).reduce((a, b) => a + b, 0)).toBe(2500);
  });

  it("orders one day's expenses by when they were entered, then by id", async () => {
    const a = await spend("A", 100);
    const b = await spend("B", 100);
    const c = await spend("C", 100);
    const d = await spend("D", 100);
    await stamp(a.id, "2026-03-10 09:00:00.000001+00");
    await stamp(b.id, "2026-03-10 09:00:00.000002+00");
    // Same instant: the larger id comes first.
    await stamp(c.id, "2026-03-10 08:00:00+00");
    await stamp(d.id, "2026-03-10 08:00:00+00");
    const sameInstant = [c, d].sort((x, y) => (x.id < y.id ? 1 : -1)).map((e) => e.description);
    expect(await names()).toEqual(["B", "A", ...sameInstant]);
  });

  it("walks every page once, even when rows differ only in microseconds", async () => {
    const made: string[] = [];
    for (let i = 0; i < 7; i++) {
      const e = await spend(`E${i}`, 100 + i, { date: i < 5 ? "2026-03-10" : "2026-03-11" });
      made.push(e.description);
      // Several share a millisecond; JS dates would lose the difference.
      await stamp(e.id, `2026-03-10 09:00:00.00010${i % 3}+00`);
    }
    const seen = await walk({ limit: "2" });
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual(await names({ limit: "50" }));
  });

  it("neither repeats nor skips older rows when an expense is added between pages", async () => {
    for (let i = 0; i < 5; i++) await spend(`Old ${i}`, 100, { date: `2026-03-0${i + 1}` });
    const seen = await walk({ limit: "2" }, async (n) => {
      if (n === 0) await spend("New", 100, { date: "2026-03-30" });
    });
    expect(seen).toEqual(["Old 4", "Old 3", "Old 2", "Old 1", "Old 0"]);
  });

  it("pages with limit while count and total cover every match", async () => {
    await spend("A", 100, { date: "2026-03-01" });
    await spend("B", 200, { date: "2026-03-02" });
    await spend("C", 300, { date: "2026-03-03" });
    const first = await list({ limit: "2" });
    expect(first.items.map((e) => e.description)).toEqual(["C", "B"]);
    expect(first).toMatchObject({ count: 3, totalCents: 600 });
    const second = await list({ limit: "2", cursor: first.nextCursor! });
    expect(second.items.map((e) => e.description)).toEqual(["A"]);
    expect(second).toMatchObject({ count: 3, totalCents: 600, nextCursor: null });
  });

  it("refuses a cursor it did not make, or one from another group", async () => {
    await spend("A", 100);
    await expect(list({ cursor: "nonsense!" })).rejects.toThrow("cursor");
    await expect(list({ cursor: Buffer.from("not an id").toString("base64url") })).rejects.toThrow("cursor");
    const other = await seedHousehold(w.db);
    const theirs = await createExpense(w.db, other.household.id, {
      kind: "manual",
      actor: other.alex,
      date: "2026-03-10",
      description: "Theirs",
      totalCents: 100,
      payerId: other.alex.id,
      today: TODAY,
    });
    await createExpense(w.db, other.household.id, {
      kind: "manual",
      actor: other.alex,
      date: "2026-03-09",
      description: "Theirs too",
      totalCents: 100,
      payerId: other.alex.id,
      today: TODAY,
    });
    const theirCursor = (await listExpenses(w.db, other.household.id, filter(), { limit: 1 })).nextCursor!;
    expect(theirCursor).toBeTruthy();
    expect(theirs.id).toBeTruthy();
    await expect(list({ cursor: theirCursor })).rejects.toThrow("cursor");
  });

  it("says the same about a cursor for no expense as for another group's, so neither reveals the other", async () => {
    const other = await seedHousehold(w.db);
    const theirs = await createExpense(w.db, other.household.id, {
      kind: "manual",
      actor: other.alex,
      date: "2026-03-10",
      description: "Theirs",
      totalCents: 100,
      payerId: other.alex.id,
      today: TODAY,
    });
    const cursorFor = (id: string) => Buffer.from(id).toString("base64url");
    const message = (cursor: string) => list({ cursor }).then(() => "listed", (e: Error) => e.message);
    const nobody = await message(cursorFor("00000000-0000-4000-8000-000000000000"));
    expect(nobody).toContain("cursor");
    expect(await message(cursorFor(theirs.id))).toBe(nobody);
  });

  it("pages on when the last row of a page is voided or replaced before the next page is asked for", async () => {
    const made: { id: string }[] = [];
    for (let i = 0; i < 6; i++) made.push(await spend(`E${i}`, 100, { date: `2026-03-0${i + 1}` }));
    // Pages of two: E5 E4 | E3 E2 | E1 E0. Each page's last row goes away
    // before the next page is read.
    const seen = await walk({ limit: "2" }, async (n) => {
      if (n === 0) await voidExpense(w.db, w.alex, made[4]!.id);
      if (n === 1) await editExpense(w.db, w.alex, made[2]!.id, { date: "2026-03-03", description: "E2 again", totalCents: 200, payerId: w.alex.id }, TODAY);
    });
    expect(seen).toEqual(["E5", "E4", "E3", "E2", "E1", "E0"]);
  });

  it("leaves out replaced and voided expenses unless asked, and never shows old agent proposals", async () => {
    const paper = await spend("Paper", 1000);
    await editExpense(w.db, w.alex, paper.id, { date: paper.date, description: "Paper, A4", totalCents: 1100, payerId: w.alex.id }, TODAY);
    await voidExpense(w.db, w.alex, (await spend("Mistake", 900)).id);
    await legacyProposal(w, { date: "2026-03-10", description: "Proposed", totalCents: 500 });
    await legacyProposal(w, { date: "2026-03-10", description: "Turned down", totalCents: 500 }, "rejected");

    expect(await names()).toEqual(["Paper, A4"]);
    expect((await names({ status: "all" })).sort()).toEqual(["Mistake", "Paper", "Paper, A4"]);
    expect(await names({ status: "void" })).toEqual(["Mistake"]);
    expect(await names({ status: "superseded" })).toEqual(["Paper"]);
    // Voided ones alone: they are counted and each is marked void, though
    // none adds to the total.
    const voided = await list({ status: "void" });
    expect(voided).toMatchObject({ count: 1, totalCents: 0 });
    expect(voided.items.map((e) => e.status)).toEqual(["void"]);
    const all = await list({ status: "all" });
    expect(all.items.map((e) => e.status).sort()).toEqual(["posted", "superseded", "void"]);
    // The total counts only what still counts.
    expect(all).toMatchObject({ count: 3, totalCents: 1100 });
  });

  it("counts a bill waiting for its amount, and leaves it out of the total", async () => {
    await createTemplate(w.db, w.alex, {
      name: "Electric",
      amountCents: null,
      cadence: "monthly",
      dayOfMonth: 5,
      payerId: w.alex.id,
      startDate: "2026-03-01",
    });
    await postDue(w.db, w.householdId, TODAY);
    await spend("Paper", 1000);
    const got = await list();
    expect(got).toMatchObject({ count: 2, totalCents: 1000 });
    expect(got.items.find((e) => e.description === "Electric")).toMatchObject({ status: "needs_amount", totalCents: null });
    expect(await names({ status: "needs_amount" })).toEqual(["Electric"]);
    // No amount is neither above nor below a bound.
    expect(await names({ minCents: "1" })).toEqual(["Paper"]);
  });

  it("filters by date range, inclusive at both ends", async () => {
    await spend("Early", 1000, { date: "2026-02-28" });
    await spend("First", 1000, { date: "2026-03-01" });
    await spend("Last", 1000, { date: "2026-03-15" });
    await spend("Late", 1000, { date: "2026-03-16" });
    expect(await names({ from: "2026-03-01", to: "2026-03-15" })).toEqual(["Last", "First"]);
    expect(await names({ from: "2026-03-16" })).toEqual(["Late"]);
    expect(await names({ to: "2026-02-28" })).toEqual(["Early"]);
  });

  it("filters by category, payer, account, and no account", async () => {
    const card = await addAccount(w.db, w.alex, { name: "Card" });
    await spend("Flat", 100000, { category: "housing", accountId: card.id });
    await spend("Bread", 400, { category: "groceries", accountId: card.id, payerId: w.sam.id });
    await spend("Market", 900, { category: "groceries" });
    expect((await names({ category: "groceries" })).sort()).toEqual(["Bread", "Market"]);
    expect((await names({ account: card.id })).sort()).toEqual(["Bread", "Flat"]);
    expect(await names({ account: "none" })).toEqual(["Market"]);
    expect(await names({ payer: w.sam.id })).toEqual(["Bread"]);
    expect((await names({ payer: w.alex.id })).sort()).toEqual(["Flat", "Market"]);
    expect(await names({ category: "groceries", account: card.id })).toEqual(["Bread"]);
    expect(await names({ category: "groceries", payer: w.alex.id, account: "none" })).toEqual(["Market"]);
    expect(await list({ category: "groceries" })).toMatchObject({ count: 2, totalCents: 1300 });
  });

  it("filters by the kind of account in a business group", async () => {
    await w.db.update(household).set({ kind: "business" }).where(eq(household.id, w.householdId));
    await addCategory(w.db, w.alex, "Software");
    const work = await addAccount(w.db, w.alex, { name: "Work card", kind: "business" });
    const own = await addAccount(w.db, w.alex, { name: "Own card", kind: "personal" });
    await spend("Tool", 1500, { accountId: work.id, category: "software" });
    await spend("Lunch", 900, { accountId: own.id });
    await spend("Cash", 300);
    expect(await names({ accountKind: "business" })).toEqual(["Tool"]);
    expect(await names({ accountKind: "personal" })).toEqual(["Lunch"]);
    expect(await names({ accountKind: "business", category: "other" })).toEqual([]);
    // A cost with no account is neither kind.
    for (const kind of ["business", "personal"]) expect(await names({ accountKind: kind })).not.toContain("Cash");
    expect(await names({ account: "none" })).toEqual(["Cash"]);
  });

  it("filters by where an expense came from", async () => {
    await createTemplate(w.db, w.alex, {
      name: "Hosting",
      amountCents: 2000,
      cadence: "monthly",
      dayOfMonth: 5,
      payerId: w.alex.id,
      startDate: "2026-03-01",
    });
    await postDue(w.db, w.householdId, TODAY);
    await spend("Paper", 1000);
    expect(await names({ source: "template" })).toEqual(["Hosting"]);
    expect(await names({ source: "manual" })).toEqual(["Paper"]);
  });

  it("filters by amount, inclusive", async () => {
    await spend("Small", 999);
    await spend("Edge", 1000);
    await spend("Big", 5000);
    expect((await names({ minCents: "1000" })).sort()).toEqual(["Big", "Edge"]);
    expect((await names({ maxCents: "1000" })).sort()).toEqual(["Edge", "Small"]);
    expect(await names({ minCents: "1000", maxCents: "1000" })).toEqual(["Edge"]);
  });

  it("searches the description ignoring case, taking %, _ and \\ literally", async () => {
    await spend("Design tool", 1500);
    await spend("Figma plugin", 500);
    await spend("50% deposit", 2000);
    await spend("snake_case", 100);
    await spend("back\\slash", 100);
    await spend("Paper", 1000);
    expect(await names({ q: "FIGMA" })).toEqual(["Figma plugin"]);
    expect(await names({ q: "50%" })).toEqual(["50% deposit"]);
    expect(await names({ q: "%" })).toEqual(["50% deposit"]);
    expect(await names({ q: "_" })).toEqual(["snake_case"]);
    expect(await names({ q: "\\" })).toEqual(["back\\slash"]);
    expect(await names({ q: "tool", from: "2026-03-01", minCents: "1000" })).toEqual(["Design tool"]);
  });

  it("refuses a category, payer or account that is not the group's", async () => {
    await expect(names({ category: "yachts" })).rejects.toThrow("category must be");
    await expect(names({ payer: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow("payer must be");
    await expect(names({ account: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow("account must be");
  });

  it("never shows another group's expenses, nor matches its category, payer or account", async () => {
    await spend("Ours", 1000);
    const other = await seedHousehold(w.db);
    const theirActor = other.alex;
    const theirCard = await addAccount(w.db, theirActor, { name: "Their card" });
    await createExpense(w.db, other.household.id, {
      kind: "manual",
      actor: theirActor,
      date: "2026-03-20",
      description: "Theirs",
      totalCents: 700,
      payerId: theirActor.id,
      accountId: theirCard.id,
      today: TODAY,
    });
    expect(await list()).toMatchObject({ count: 1, totalCents: 1000 });
    expect(await names({ status: "all" })).toEqual(["Ours"]);
    expect(await names({ q: "Theirs" })).toEqual([]);
    await expect(names({ account: theirCard.id })).rejects.toThrow("account must be");
    await expect(names({ payer: theirActor.id })).rejects.toThrow("payer must be");
    // Their own list is theirs alone.
    const theirs = await listExpenses(w.db, other.household.id, filter(), page());
    expect(theirs.items.map((e) => e.description)).toEqual(["Theirs"]);
  });
});

describe("reading filters", () => {
  it("defaults to live expenses and ignores blanks", () => {
    expect(filter({ from: "", q: "  " })).toEqual({ status: "live" });
    expect(page()).toEqual({ limit: DEFAULT_LIMIT });
    expect(DEFAULT_LIMIT).toBe(50);
  });

  it("caps the page size, and refuses search text over 100 characters rather than cutting it", () => {
    expect(page({ limit: "9999" }).limit).toBe(MAX_LIMIT);
    expect(MAX_LIMIT).toBe(200);
    expect(filter({ q: "x".repeat(100) }).q).toHaveLength(100);
    expect(() => filter({ q: "x".repeat(101) })).toThrow("q must be at most 100 characters");
  });

  it("refuses what it cannot read, naming the field", () => {
    expect(() => filter({ from: "March" })).toThrow("from must be a date");
    expect(() => filter({ to: "2026-02-30" })).toThrow("to must be a date");
    expect(() => filter({ from: "2026-03-02", to: "2026-03-01" })).toThrow("from must not be later than to");
    expect(() => filter({ source: "plaid" })).toThrow("source must be one of");
    expect(() => filter({ status: "gone" })).toThrow("status must be");
    expect(() => filter({ status: "proposed" })).toThrow("status must be");
    expect(() => filter({ status: "rejected" })).toThrow("status must be");
    expect(() => filter({ minCents: "12.50" })).toThrow("minCents must be a whole number");
    expect(() => filter({ maxCents: "-1" })).toThrow("maxCents must be a whole number");
    expect(() => filter({ minCents: "500", maxCents: "100" })).toThrow("minCents can't be more than maxCents");
    expect(() => filter({ payer: "alex" })).toThrow("payer must be");
    expect(() => filter({ account: "card" })).toThrow("account must be");
    expect(() => filter({ accountKind: "shared" })).toThrow("accountKind must be");
    expect(() => page({ limit: "0" })).toThrow("limit must be");
    expect(() => page({ cursor: "%%%" })).toThrow("cursor");
  });

  it("names the form's labels on the web page, and reads its amounts as dollars", () => {
    const form = (params: Record<string, string>) => parseListForm((k) => params[k] ?? "");
    expect(form({ min: "12.50", max: "$1,000" }).filter).toMatchObject({ minCents: 1250, maxCents: 100000 });
    // Only the form's own fields: cents and a page size in the address are not.
    expect(form({ minCents: "5", limit: "1" })).toEqual({ filter: { status: "live" }, page: { limit: DEFAULT_LIMIT } });
    expect(() => form({ min: "20", max: "10" })).toThrow("At least can't be more than At most");
    expect(() => form({ min: "lots" })).toThrow("At least must be an amount like 12.50");
    expect(() => form({ max: "-1" })).toThrow("At most must be an amount like 12.50");
    // The largest amount the list can read, and a cent more.
    expect(form({ max: "9999999999.99" }).filter.maxCents).toBe(999_999_999_999);
    expect(() => form({ max: "10000000000" })).toThrow("At most must be an amount like 12.50");
    expect(() => form({ from: "March" })).toThrow("From must be a date");
    expect(() => form({ from: "2026-03-02", to: "2026-03-01" })).toThrow("From must not be later than To");
    expect(() => form({ q: "x".repeat(101) })).toThrow("Search must be at most 100 characters");
    expect(() => form({ status: "proposed" })).toThrow('Show must be one of "Current expenses", "Not split"');
    expect(FORM_NAMES.statuses).not.toContain("needs_amount");
  });

  it("names the form's labels when the group does not have what a filter asks for", async () => {
    const { filter: f, page: p } = parseListForm((k) => ({ category: "yachts", payer: "00000000-0000-4000-8000-000000000000" })[k] ?? "");
    await expect(listExpenses(w.db, w.householdId, f, p, FORM_NAMES)).rejects.toThrow("Category must be one of this group's categories");
    await expect(listExpenses(w.db, w.householdId, { ...f, category: undefined }, p, FORM_NAMES)).rejects.toThrow("Paid by must be a member");
  });

  it("reads every filter it is given", () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect(
      filter({
        from: "2026-01-01",
        to: "2026-01-31",
        category: " Groceries ",
        payer: id,
        account: "NONE",
        accountKind: "business",
        source: "manual",
        status: "void",
        minCents: "100",
        maxCents: "200",
        q: " rent ",
      }),
    ).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
      category: "groceries",
      payer: id,
      account: "none",
      accountKind: "business",
      source: "manual",
      status: "void",
      minCents: 100,
      maxCents: 200,
      q: "rent",
    });
  });
});
