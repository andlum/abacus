import { beforeEach, describe, expect, it } from "vitest";
import { expense, household, importBatch, member } from "@/db/schema";
import { getBalance, recordSettlement, listSettlements } from "./balance";
import { parseCsv, toCsv } from "@abacus/core/csv";
import { createExpense, getExpense, listMonth, voidExpense } from "./expenses";
import { agree, createWorld, type World } from "./testing/world";
import { DEFAULT_CATEGORIES, seedCategories } from "./categories";
import { recentAudit } from "./audit";
import { addAccount, listAccounts, setAccountArchived } from "./accounts";
import { applyImport, exportCsv, previewImport } from "./transfer";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

const today = "2026-11-05";
const HEADER = "id,date,description,category,amount,payer,status,share: alex@example.com,share: sam@example.com,rule_source";

const spend = (over: object = {}) =>
  createExpense(w.db, w.householdId, {
    kind: "manual",
    actor: w.alex,
    date: "2026-10-10",
    description: "Groceries",
    category: "groceries",
    totalCents: 10000,
    payerId: w.alex.id,
    today,
    ...over,
  });

const percent = (alexBp: number) => ({ kind: "percent" as const, bp: { [w.alex.id]: alexBp, [w.sam.id]: 10000 - alexBp } });
const file = (...lines: string[]) => [HEADER, ...lines].join("\r\n") + "\r\n";
// An export names the account each expense was paid from. A file from before
// accounts, like `file`, has no such columns and still imports.
const EXPORTED = "id,date,description,category,amount,payer,status,account,account_kind,share: alex@example.com,share: sam@example.com,rule_source";
const exported = (...lines: string[]) => [EXPORTED, ...lines].join("\r\n") + "\r\n";

describe("CSV", () => {
  it("round-trips commas, quotes and line breaks", () => {
    const rows = [["a", "b,c", 'say "hi"'], ["line\nbreak", "", "z"]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it("reads files saved with either line ending, and skips blank lines", () => {
    expect(parseCsv("a,b\n1,2\n\n3,4")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
    expect(parseCsv('a\r\n"unclosed')).toBeNull();
  });
});

describe("exportCsv", () => {
  it("writes one line per expense with decimal amounts, each share, and where the rule came from", async () => {
    const e = await spend({ totalCents: 123456, description: "Sofa, blue" });
    expect(await exportCsv(w.db, w.householdId, "2026-10-01", "2026-10-31")).toBe(
      exported(`${e.id},2026-10-10,"Sofa, blue",groceries,1234.56,alex@example.com,posted,,,617.28,617.28,default`),
    );
  });

  it("covers the date range only, and leaves out voided expenses", async () => {
    await spend({ date: "2026-09-30" });
    const gone = await spend();
    await voidExpense(w.db, w.alex, gone.id);
    expect(await exportCsv(w.db, w.householdId, "2026-10-01", "2026-10-31")).toBe(exported());
  });

  it("holds no incomes and no ratios", async () => {
    await agree(w, "2026-10-01", {
      incomes: { alex: 9000000, sam: 6000000 },
      rules: [{ scope: "household", rule: { kind: "income_proportional" } }],
    });
    await spend();
    const csv = await exportCsv(w.db, w.householdId, "2026-10-01", "2026-10-31");
    expect(csv).toContain("60.00,40.00,household");
    expect(csv).not.toMatch(/9000000|6000000|90000|6000,|ratio/);
  });
});

describe("importing", () => {
  it("re-splits an exported expense by the rules in force on the day of the import", async () => {
    const old = await spend();
    const csv = await exportCsv(w.db, w.householdId, "2026-10-01", "2026-10-31");
    await agree(w, "2026-11-01", { rules: [{ scope: "household", rule: percent(7000) }] });

    const { rows } = await applyImport(w.db, w.sam, csv, today);
    expect(rows).toHaveLength(1);
    expect((await getExpense(w.db, w.householdId, old.id)).status).toBe("superseded");
    const [live, ...rest] = (await listMonth(w.db, w.householdId, "2026-10")).filter((e) => e.status !== "superseded");
    expect(rest).toEqual([]);
    expect(live).toMatchObject({
      status: "posted",
      source: "import",
      date: "2026-10-10",
      supersedesId: old.id,
      shares: { [w.alex.id]: 7000, [w.sam.id]: 3000 },
      ruleSource: "household",
      createdBy: w.sam.id,
    });
    expect(live!.computation!.rulesAsOf).toBe(today);
  });

  it("exports a description that looks like a formula as text, and imports it back unchanged", async () => {
    const description = '=HYPERLINK("http://example.com","pay")';
    await spend({ description });
    const csv = await exportCsv(w.db, w.householdId, "2026-10-01", "2026-10-31");
    expect(parseCsv(csv)![1]![2]).toBe("'" + description);

    await applyImport(w.db, w.sam, csv, today);
    const live = (await listMonth(w.db, w.householdId, "2026-10")).filter((e) => e.status !== "superseded");
    expect(live.map((e) => e.description)).toEqual([description]);
  });

  it("ignores the share columns in the file", async () => {
    const csv = file(",2026-10-10,Groceries,groceries,100.00,alex@example.com,posted,99.00,1.00,default");
    const { rows } = await applyImport(w.db, w.alex, csv, today);
    expect(rows[0]!.shares).toEqual({ [w.alex.id]: 5000, [w.sam.id]: 5000 });
  });

  it("adds a row with no id as a new expense", async () => {
    await applyImport(w.db, w.alex, file(",2026-10-12,Streaming,subscriptions,23.50,sam@example.com,,,,"), today);
    const [added] = await listMonth(w.db, w.householdId, "2026-10");
    expect(added).toMatchObject({ description: "Streaming", category: "subscriptions", totalCents: 2350, payerId: w.sam.id, supersedesId: null });
  });

  it("previews each row's old and new shares and the change to the balance, writing nothing", async () => {
    const old = await spend();
    const csv = await exportCsv(w.db, w.householdId, "2026-10-01", "2026-10-31");
    await agree(w, "2026-11-01", { rules: [{ scope: "household", rule: percent(7000) }] });
    const before = await w.db.select().from(expense);

    const preview = await previewImport(w.db, w.sam, csv, today);
    if (!preview.ok) throw new Error("expected a preview");
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]).toMatchObject({
      id: old.id,
      old: { status: "posted", shares: { [w.alex.id]: 5000, [w.sam.id]: 5000 } },
      status: "posted",
      shares: { [w.alex.id]: 7000, [w.sam.id]: 3000 },
    });
    // Alex paid 100.00. Sam owed 50.00; now owes 30.00.
    expect(preview.balanceChange).toEqual({ [w.alex.id]: -2000, [w.sam.id]: 2000 });
    expect(await w.db.select().from(expense)).toEqual(before);
    expect(await w.db.select().from(importBatch)).toEqual([]);
  });

  it("does exactly what the preview showed, leftover cents included", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `,2026-10-${10 + i},Item ${i},,${i}.01,alex@example.com,,,,`);
    const csv = file(...lines);
    const preview = await previewImport(w.db, w.alex, csv, today);
    const applied = await applyImport(w.db, w.alex, csv, today);
    if (!preview.ok) throw new Error("expected a preview");
    expect(applied.rows.map((r) => r.shares)).toEqual(preview.rows.map((r) => r.shares));
    expect(applied.balanceChange).toEqual(preview.balanceChange);
  });

  it("writes nothing when any row is wrong, and says which lines", async () => {
    const old = await spend();
    const csv = file(
      `${old.id},2026-10-10,Groceries,groceries,120.00,alex@example.com,posted,,,`,
      ",2026-13-01,Bad date,,10.00,alex@example.com,,,,",
      ",2026-10-11,Bad amount,,12.345,alex@example.com,,,,",
      ",2026-10-11,Bad payer,,10.00,pat@example.com,,,,",
      ",2026-11-06,Tomorrow,,10.00,alex@example.com,,,,",
      "3f0e0c1e-6f0a-4c56-9d35-0d6f4f6f7a10,2026-10-11,Unknown id,,10.00,alex@example.com,,,,",
    );
    const preview = await previewImport(w.db, w.alex, csv, today);
    expect(preview).toEqual({
      ok: false,
      errors: [
        { line: 3, message: "the date must look like 2026-10-31" },
        { line: 4, message: "the amount must be a number more than zero, like 1234.56" },
        { line: 5, message: "the payer must be one of: alex@example.com, sam@example.com" },
        { line: 6, message: "the date is later than today" },
        { line: 7, message: "no expense has that id" },
      ],
    });
    await expect(applyImport(w.db, w.alex, csv, today)).rejects.toThrow(/nothing was imported: line 3/);
    expect((await getExpense(w.db, w.householdId, old.id)).status).toBe("posted");
    expect(await w.db.select().from(importBatch)).toEqual([]);
  });

  it("refuses the same export twice: its ids are no longer live", async () => {
    await spend();
    const csv = await exportCsv(w.db, w.householdId, "2026-10-01", "2026-10-31");
    await applyImport(w.db, w.alex, csv, today);
    await expect(applyImport(w.db, w.alex, csv, today)).rejects.toThrow(/superseded/);
    expect((await listMonth(w.db, w.householdId, "2026-10")).map((e) => e.status).sort()).toEqual(["posted", "superseded"]);
  });

  it("refuses a category that is not in the list, and reads a blank one as other", async () => {
    expect(
      await previewImport(w.db, w.alex, file(",2026-10-10,Takeaway,eating out,20.00,alex@example.com,,,,"), today),
    ).toEqual({ ok: false, errors: [{ line: 2, message: "the category must be blank or one of: " + DEFAULT_CATEGORIES.household.map((c) => c.slug).sort().join(", ") }] });
    const preview = await previewImport(w.db, w.alex, file(",2026-10-10,Takeaway,,20.00,alex@example.com,,,,"), today);
    expect(preview.ok && preview.rows[0]!.category).toBe("other");
  });

  it("refuses a file without the columns it needs", async () => {
    expect(await previewImport(w.db, w.alex, "date,description\r\n2026-10-10,Groceries\r\n", today)).toEqual({
      ok: false,
      errors: [{ line: 1, message: "the file has no id, category, amount, payer column" }],
    });
  });

  it("records who imported what, and leaves settlements alone", async () => {
    await spend();
    await recordSettlement(
      w.db,
      w.sam,
      { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents: 5000, date: today },
      today,
    );
    const csv = await exportCsv(w.db, w.householdId, "2026-10-01", "2026-10-31");
    const { batchId } = await applyImport(w.db, w.sam, csv, today);
    expect(await w.db.select().from(importBatch)).toMatchObject([{ id: batchId, rowCount: 1, createdBy: w.sam.id }]);
    expect(await listSettlements(w.db, w.householdId)).toHaveLength(1);
    expect((await getBalance(w.db, w.householdId)).net).toEqual({ [w.alex.id]: 0, [w.sam.id]: 0 });
  });

  it("cannot replace another household's expense", async () => {
    const mine = await spend();
    const csv = await exportCsv(w.db, w.householdId, "2026-10-01", "2026-10-31");
    const [elsewhere] = await w.db.insert(household).values({ name: "Other household" }).returning();
    const [pat] = await w.db
      .insert(member)
      .values({ householdId: elsewhere!.id, email: "pat@example.com", displayName: "Pat" })
      .returning();
    const theirs = csv.replace("alex@example.com,posted", "pat@example.com,posted");
    await expect(applyImport(w.db, pat!, theirs, today)).rejects.toThrow(/no expense has that id/);
    expect((await getExpense(w.db, w.householdId, mine.id)).status).toBe("posted");
  });
});

describe("the account column", () => {
  it("round-trips: an export names each expense's account, and importing it puts the expense back on that account", async () => {
    const card = await addAccount(w.db, w.alex, { name: "Joint card", lastFour: "4242" });
    const e = await spend({ accountId: card.id });
    const none = await spend({ description: "Market" });
    const csv = await exportCsv(w.db, w.householdId, "2026-10-01", "2026-10-31");
    expect(csv).toContain(`${e.id},2026-10-10,Groceries,groceries,100.00,alex@example.com,posted,Joint card,,50.00,50.00,default`);
    expect(csv).not.toContain("4242");
    const { rows } = await applyImport(w.db, w.alex, csv, today);
    expect(rows).toHaveLength(2);
    const month = await listMonth(w.db, w.householdId, "2026-10");
    expect(month.find((x) => x.supersedesId === e.id)!.accountId).toBe(card.id);
    expect(month.find((x) => x.supersedesId === none.id)!.accountId).toBeNull();
    expect(await listAccounts(w.db, w.householdId, { archived: true })).toHaveLength(1);
  });

  it("keeps a replaced expense's account when the file has no account column, and clears it when the cell is blank", async () => {
    const card = await addAccount(w.db, w.alex, { name: "Card" });
    const e = await spend({ accountId: card.id });
    await applyImport(w.db, w.alex, file(`${e.id},2026-10-10,Groceries,groceries,120.00,alex@example.com,,,,`), today);
    const [kept] = (await listMonth(w.db, w.householdId, "2026-10")).filter((x) => x.supersedesId === e.id);
    expect(kept!.accountId).toBe(card.id);
    await applyImport(w.db, w.alex, exported(`${kept!.id},2026-10-10,Groceries,groceries,120.00,alex@example.com,,,,,,`), today);
    const [cleared] = (await listMonth(w.db, w.householdId, "2026-10")).filter((x) => x.supersedesId === kept!.id);
    expect(cleared!.accountId).toBeNull();
  });

  it("matches a name without case, prefers an account in use, allows an archived one, and adds one it does not know", async () => {
    const old = await addAccount(w.db, w.alex, { name: "Card" });
    await setAccountArchived(w.db, w.alex, old.id, true);
    const archivedOnly = await addAccount(w.db, w.alex, { name: "Old savings" });
    await setAccountArchived(w.db, w.alex, archivedOnly.id, true);
    const live = await addAccount(w.db, w.alex, { name: "card" });
    await applyImport(
      w.db,
      w.alex,
      exported(
        ",2026-10-10,Groceries,groceries,10.00,alex@example.com,,CARD,,,,",
        ",2026-10-11,Groceries,groceries,10.00,alex@example.com,,old savings,,,,",
        ",2026-10-12,Groceries,groceries,10.00,alex@example.com,,  Cash   box ,business,,,",
        ",2026-10-13,Groceries,groceries,10.00,alex@example.com,,cash box,,,,",
      ),
      today,
    );
    const cash = (await listAccounts(w.db, w.householdId)).find((a) => a.name === "Cash box")!;
    // A household's accounts have no kind, whatever the file says.
    expect(cash.kind).toBeNull();
    const byDate = Object.fromEntries((await listMonth(w.db, w.householdId, "2026-10")).map((x) => [x.date, x.accountId]));
    expect(byDate).toEqual({ "2026-10-10": live.id, "2026-10-11": archivedOnly.id, "2026-10-12": cash.id, "2026-10-13": cash.id });
    const added = (await recentAudit(w.db, w.householdId, 20)).filter((a) => a.action === "account.added" && a.entityId === cash.id);
    expect(added).toHaveLength(1);
  });

  it("in a business group, needs a kind for an account it adds", async () => {
    const [biz] = await w.db.insert(household).values({ name: "Alex Studio", kind: "business" }).returning();
    await seedCategories(w.db, biz!.id, "business");
    const [alex] = await w.db
      .insert(member)
      .values({ householdId: biz!.id, email: "alex@example.com", displayName: "Alex", linkedAt: new Date() })
      .returning();
    const BIZ = "id,date,description,category,amount,payer,account,account_kind";
    const biz_file = (...lines: string[]) => [BIZ, ...lines].join("\r\n") + "\r\n";
    await expect(applyImport(w.db, alex!, biz_file(",2026-10-10,Software,,10.00,alex@example.com,Visa,"), today)).rejects.toThrow(
      "line 2: this group has no account by that name; say in account_kind whether it is personal or business",
    );
    await applyImport(w.db, alex!, biz_file(",2026-10-10,Software,,10.00,alex@example.com,Visa,Personal"), today);
    expect(await listAccounts(w.db, biz!.id)).toMatchObject([{ name: "Visa", kind: "personal" }]);
    // The household's accounts are not looked at, nor added to.
    expect(await listAccounts(w.db, w.householdId, { archived: true })).toEqual([]);
  });

  it("refuses an account name that breaks the rules, with its line", async () => {
    const preview = await previewImport(w.db, w.alex, exported(`,2026-10-10,Groceries,,10.00,alex@example.com,,${"x".repeat(61)},,,,`), today);
    expect(preview).toMatchObject({ ok: false, errors: [{ line: 2, message: expect.stringContaining("too long") }] });
    // Nothing is added by a preview.
    await previewImport(w.db, w.alex, exported(",2026-10-10,Groceries,,10.00,alex@example.com,,New card,,,,"), today);
    expect(await listAccounts(w.db, w.householdId)).toEqual([]);
  });

  it("matches names the way the database does, where that differs from JavaScript", async () => {
    // JavaScript lowercases a final capital sigma to ς; Postgres's lower() gives σ.
    expect("ΚΑΡΤΑΣ".toLowerCase()).not.toBe("καρτασ");
    const card = await addAccount(w.db, w.alex, { name: "καρτασ" });
    await applyImport(w.db, w.alex, exported(",2026-10-10,Groceries,,10.00,alex@example.com,,ΚΑΡΤΑΣ,,,,"), today);
    const [row] = await listMonth(w.db, w.householdId, "2026-10");
    expect(row!.accountId).toBe(card.id);
    expect(await listAccounts(w.db, w.householdId, { archived: true })).toHaveLength(1);
  });

  it("folds runs of spaces in a file's account name, no-break ones included", async () => {
    const card = await addAccount(w.db, w.alex, { name: "Joint card" });
    await applyImport(w.db, w.alex, exported(",2026-10-10,Groceries,,10.00,alex@example.com,,Joint  card,,,,"), today);
    const [row] = await listMonth(w.db, w.householdId, "2026-10");
    expect(row!.accountId).toBe(card.id);
  });

  it("keeps an expense on its archived account when a live one has the same name", async () => {
    const old = await addAccount(w.db, w.alex, { name: "Card" });
    const e = await spend({ accountId: old.id });
    await setAccountArchived(w.db, w.alex, old.id, true);
    const live = await addAccount(w.db, w.alex, { name: "card" });
    const csv = await exportCsv(w.db, w.householdId, "2026-10-01", "2026-10-31");
    const preview = await previewImport(w.db, w.alex, csv + `,2026-10-11,Market,,10.00,alex@example.com,,CARD,,,,\r\n`, today);
    expect(preview).toMatchObject({ ok: true, newAccounts: [] });
    await applyImport(w.db, w.alex, csv + `,2026-10-11,Market,,10.00,alex@example.com,,CARD,,,,\r\n`, today);
    const month = await listMonth(w.db, w.householdId, "2026-10");
    expect(month.find((x) => x.supersedesId === e.id)!.accountId).toBe(old.id);
    // A new row takes the account in use.
    expect(month.find((x) => x.description === "Market")!.accountId).toBe(live.id);
  });

  it("names in the preview the accounts an import would add", async () => {
    await addAccount(w.db, w.alex, { name: "Card" });
    const preview = await previewImport(
      w.db,
      w.alex,
      exported(
        ",2026-10-10,Groceries,,10.00,alex@example.com,,card,,,,",
        ",2026-10-11,Groceries,,10.00,alex@example.com,,Cash box,,,,",
        ",2026-10-12,Groceries,,10.00,alex@example.com,,CASH BOX,,,,",
        ",2026-10-13,Groceries,,10.00,alex@example.com,,Savings,,,,",
      ),
      today,
    );
    expect(preview).toMatchObject({ ok: true, newAccounts: ["Cash box", "Savings"] });
  });

  it("adds at most 20 accounts in one import", async () => {
    const line = (i: number) => `,2026-10-10,Groceries,,10.00,alex@example.com,,Card ${i},,,,`;
    const twenty = Array.from({ length: 20 }, (_, i) => line(i + 1));
    expect(await previewImport(w.db, w.alex, exported(...twenty), today)).toMatchObject({ ok: true });
    const preview = await previewImport(w.db, w.alex, exported(...twenty, line(1), line(21)), today);
    expect(preview).toEqual({
      ok: false,
      errors: [{ line: 23, message: "an import can add at most 20 accounts; add the others under Settings first" }],
    });
  });

  it("exports an account name that looks like a formula as text, and imports it back to the same account", async () => {
    const card = await addAccount(w.db, w.alex, { name: "=SUM(1)" });
    const e = await spend({ accountId: card.id });
    const csv = await exportCsv(w.db, w.householdId, "2026-10-01", "2026-10-31");
    expect(csv).toContain(",posted,'=SUM(1),,");
    await applyImport(w.db, w.alex, csv, today);
    const month = await listMonth(w.db, w.householdId, "2026-10");
    expect(month.find((x) => x.supersedesId === e.id)!.accountId).toBe(card.id);
    expect(await listAccounts(w.db, w.householdId, { archived: true })).toHaveLength(1);
  });
});
