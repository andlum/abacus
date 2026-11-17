import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { account, auditLog, bankConnection, bankTransaction, expense, expenseShare, household, member, type Member } from "@/db/schema";
import { addAccount, setAccountArchived } from "./accounts";
import {
  addFromBank,
  connectBank,
  firstSyncFrom,
  dismissBankTransaction,
  listToSort,
  plaidCents,
  removeBankConnection,
  restoreBankTransaction,
  setShareAll,
  syncAllConnections,
  syncConnection,
  type BankDeps,
} from "./bank";
import { recentActivity } from "./activity";
import { seedCategories } from "./categories";
import { PlaidError, type PlaidSyncPage, type PlaidTransaction } from "./plaid";
import { ACCOUNTS, fakePlaid, txn } from "./testing/fake-plaid";
import { openSecret } from "./secret-box";
import { agree, createWorld, type World } from "./testing/world";

// Connected on 2027-03-01; synced on 2027-03-10 in New York.
const FROM = "2027-03-01";
const TODAY = "2027-03-10";
const NOW = new Date("2027-03-10T15:00:00Z");

let w: World;
let fake: ReturnType<typeof fakePlaid>;
let bank: BankDeps;

beforeEach(async () => {
  w = await createWorld();
  fake = fakePlaid();
  bank = { plaid: fake.plaid, key: randomBytes(32) };
});

const connect = (who: Member = w.alex, token = "alex") =>
  connectBank(w.db, bank, who, { publicToken: token, institutionName: "First Platypus Bank" }, FROM, NOW);

// A login to different cards, as a second person's own would be.
let apart = 0;
async function connectApart(who: Member, token: string) {
  apart++;
  fake.setAccounts(ACCOUNTS.map((a) => ({ ...a, mask: String(9000 + apart * 10 + (a.mask === "1234" ? 1 : 2)) })));
  try {
    return await connect(who, token);
  } finally {
    fake.setAccounts(ACCOUNTS);
  }
}

const rows = () => w.db.select().from(bankTransaction).orderBy(bankTransaction.plaidTransactionId);
const byId = async (plaidId: string) => (await w.db.select().from(bankTransaction).where(eq(bankTransaction.plaidTransactionId, plaidId)))[0]!;
const connectionRow = async (id: string) => (await w.db.select().from(bankConnection).where(eq(bankConnection.id, id)))[0]!;
const actionsFor = async (householdId = w.householdId) =>
  (await w.db.select().from(auditLog).where(eq(auditLog.householdId, householdId)).orderBy(auditLog.id)).map((a) => a.action);

// Jo, in a group of their own.
async function otherGroup(): Promise<Member> {
  const [h] = await w.db.insert(household).values({ name: "Jo's place", timezone: "America/New_York" }).returning();
  await seedCategories(w.db, h!.id, "household");
  const [jo] = await w.db.insert(member).values({ householdId: h!.id, email: "jo@example.com", displayName: "Jo", linkedAt: new Date() }).returning();
  return jo!;
}

describe("connecting the same card twice", () => {
  it("refuses a second login to a card the group already has, and lets that login go", async () => {
    await connect();
    await expect(connect(w.sam, "sam")).rejects.toThrow(/already connected in this group.*twice/);
    expect(fake.removedItems).toEqual(["access-sam"]);
    expect(await w.db.select().from(bankConnection)).toHaveLength(1);
  });

  it("takes the bank from Plaid, not from the browser, and keeps its id in the audit entry", async () => {
    const { connection } = await connect();
    expect(connection.institutionName).toBe("Test Bank");
    const [entry] = await w.db.select().from(auditLog).where(eq(auditLog.action, "bank_connection.connected"));
    expect(entry!.detail).toEqual({ institutionId: "ins_1" });
    // The browser claims another bank for the same card: still a duplicate.
    await expect(
      connectBank(w.db, bank, w.sam, { publicToken: "sam", institutionName: "Some Other Bank" }, FROM, NOW),
    ).rejects.toThrow(/already connected in this group/);
  });

  it("falls back to the browser's name when Plaid names no bank", async () => {
    fake.setInstitution(null);
    const { connection } = await connect();
    expect(connection.institutionName).toBe("First Platypus Bank");
  });

  it("still sees the card after it was renamed or archived, but not by name alone", async () => {
    const { accounts } = await connect();
    await w.db.update(account).set({ name: "My own name" }).where(eq(account.id, accounts[0]!.id));
    await expect(connect(w.sam, "sam")).rejects.toThrow(/already connected/);
    await w.db.update(account).set({ archivedAt: NOW }).where(eq(account.id, accounts[0]!.id));
    await expect(connect(w.sam, "sam")).rejects.toThrow(/already connected/);
  });

  it("logs, without secrets, when the refused login could not be let go at Plaid", async () => {
    await connect();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.failNext("sam", "INTERNAL_SERVER_ERROR");
    await expect(connect(w.sam, "sam")).rejects.toThrow(/already connected/);
    const text = log.mock.calls.flat().join("\n");
    expect(text).toMatch(/could not be removed at Plaid: INTERNAL_SERVER_ERROR/);
    expect(text).not.toContain("access-sam");
    log.mockRestore();
  });

  it("allows another card at the same bank, another bank, another group, and the card again once disconnected", async () => {
    const { connection } = await connect();
    fake.setAccounts([{ account_id: "acc-new", name: "Everyday Card", mask: "9999", type: "credit", subtype: "credit card" }]);
    await connect(w.sam, "sam");
    fake.setAccounts(ACCOUNTS);
    fake.setInstitution("Other Bank");
    await expect(connectBank(w.db, bank, w.sam, { publicToken: "sam2", institutionName: "Other Bank" }, FROM, NOW)).resolves.toBeDefined();
    fake.setInstitution("Test Bank");
    const jo = await otherGroup();
    await expect(connect(jo, "jo")).resolves.toBeDefined();
    await removeBankConnection(w.db, bank, w.alex, connection.id);
    await expect(connect(w.alex, "alex2")).resolves.toBeDefined();
  });
});

describe("plaidCents", () => {
  it("turns dollars into exact cents, keeping the sign", () => {
    expect(plaidCents(19.99)).toBe(1999);
    expect(plaidCents(0.07)).toBe(7);
    expect(plaidCents(1234.56)).toBe(123456);
    expect(plaidCents(-25.5)).toBe(-2550);
    expect(plaidCents(0.1 + 0.2)).toBe(30);
    expect(plaidCents(0)).toBe(0);
    expect(plaidCents(Number.NaN)).toBeNull();
  });
});

describe("connectBank", () => {
  it("stores the connection with its token sealed, and an account for each of the bank's credit cards only", async () => {
    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1" });
    const { connection, accounts, sync } = await connect();

    const stored = await connectionRow(connection.id);
    expect(stored.accessToken).not.toContain("access-alex");
    expect(openSecret(stored.accessToken!, bank.key)).toBe("access-alex");
    expect(stored).toMatchObject({ itemId: "item-alex", ownerId: w.alex.id, syncFrom: FROM, status: "ok", cursor: "c1", institutionName: "Test Bank" });

    expect(accounts.map((a) => [a.name, a.lastFour, a.plaidAccountId, a.bankConnectionId, a.shareAll])).toEqual([
      ["Everyday Card", "1234", "acc-card", connection.id, false],
      ["Travel Card", "4321", "acc-travel", connection.id, false],
    ]);
    expect(sync).toMatchObject({ toSort: 1, outcome: "ok" });
    expect(await actionsFor()).toEqual(["bank_connection.connected", "account.added", "account.added"]);
  });

  it("starts a new connection 30 days back", () => {
    expect(firstSyncFrom("2027-03-10")).toBe("2027-02-08");
    expect(firstSyncFrom("2027-01-15")).toBe("2026-12-16");
  });

  it("refuses a sign-in with no credit card, and lets that login go", async () => {
    fake.setAccounts([{ account_id: "acc-check", name: "Checking", mask: "0000", type: "depository", subtype: "checking" }]);
    await expect(connect()).rejects.toThrow("no credit cards");
    expect(await w.db.select().from(bankConnection)).toEqual([]);
    expect(fake.removedItems).toEqual(["access-alex"]);
  });

  it("makes a name the group already uses distinct, and drops a mask that is not four digits", async () => {
    await addAccount(w.db, w.alex, { name: "everyday card" });
    fake.setAccounts([
      { ...ACCOUNTS[0]!, mask: "12" },
      { ...ACCOUNTS[0]!, account_id: "acc-card-2", mask: null },
    ]);
    const { accounts } = await connect();
    expect(accounts.map((a) => [a.name, a.lastFour])).toEqual([
      ["Everyday Card (2)", null],
      ["Everyday Card (3)", null],
    ]);
  });

  it("keeps the connection when the first sync fails", async () => {
    fake.failNext("alex", "INTERNAL_SERVER_ERROR");
    const { connection, sync } = await connect();
    expect(sync).toBeNull();
    expect((await connectionRow(connection.id)).cursor).toBeNull();
  });
});

describe("syncConnection", () => {
  it("keeps only posted US-dollar transactions from followed accounts since the connection was made", async () => {
    const { connection, accounts } = await connect();
    await addAccount(w.db, w.alex, { name: "Spare" });
    await setAccountArchived(w.db, w.alex, accounts[1]!.id, true);
    fake.on("alex", "", {
      added: [
        txn("t-ok"),
        txn("t-pending", { pending: true }),
        txn("t-old", { date: "2027-02-28" }),
        txn("t-cad", { iso_currency_code: "CAD" }),
        txn("t-unknown", { account_id: "acc-other" }),
        txn("t-archived", { account_id: "acc-travel" }),
        txn("t-checking", { account_id: "acc-check" }),
        txn("t-zero", { amount: 0 }),
      ],
      next_cursor: "c1",
    });
    const summary = await syncConnection(w.db, bank, connection.id, NOW);
    expect(summary).toMatchObject({
      toSort: 1,
      added: 0,
      skipped: { pending: 1, before_sync_from: 1, not_usd: 1, account_not_followed: 3, zero_or_bad_amount: 1, already_stored: 0 },
    });
    expect((await rows()).map((r) => r.plaidTransactionId)).toEqual(["t-ok"]);
    // Waiting rows and cursor moves are not in the group's activity.
    expect(await actionsFor()).not.toContain("bank_transaction.added");
  });

  it("stores exact cents, and money in as a negative amount", async () => {
    const { connection } = await connect();
    fake.on("alex", "", {
      added: [txn("t-a", { amount: 19.99 }), txn("t-b", { amount: 0.07 }), txn("t-c", { amount: 1234.56 }), txn("t-d", { amount: -40 })],
      next_cursor: "c1",
    });
    await syncConnection(w.db, bank, connection.id, NOW);
    expect((await rows()).map((r) => [r.plaidTransactionId, r.amountCents, r.state, r.description])).toEqual([
      ["t-a", 1999, "to_sort", "Corner Shop"],
      ["t-b", 7, "to_sort", "Corner Shop"],
      ["t-c", 123456, "to_sort", "Corner Shop"],
      ["t-d", -4000, "to_sort", "Corner Shop"],
    ]);
  });

  it("brings a transaction in once, however often Plaid sends it", async () => {
    const { connection } = await connect();
    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1" });
    fake.on("alex", "c1", { added: [txn("t1")], next_cursor: "c2" });
    await syncConnection(w.db, bank, connection.id, NOW);
    const again = await syncConnection(w.db, bank, connection.id, NOW);
    expect(again.skipped.already_stored).toBe(1);
    expect(await rows()).toHaveLength(1);
    expect((await connectionRow(connection.id)).cursor).toBe("c2");
  });

  it("lets only one of two syncs racing from the same cursor write", async () => {
    const { connection } = await connect();
    fake.on("alex", "", { added: [txn("t1"), txn("t2")], next_cursor: "c1" });
    const results = await Promise.all([syncConnection(w.db, bank, connection.id, NOW), syncConnection(w.db, bank, connection.id, NOW)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["ok", "superseded"]);
    expect(await rows()).toHaveLength(2);
  });

  it("reads every page before writing, keeping the last cursor", async () => {
    const { connection } = await connect();
    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1", has_more: true });
    fake.on("alex", "c1", { added: [txn("t2")], next_cursor: "c2", has_more: true });
    fake.on("alex", "c2", { added: [txn("t3")], next_cursor: "c3" });
    expect((await syncConnection(w.db, bank, connection.id, NOW)).toSort).toBe(3);
    expect((await connectionRow(connection.id)).cursor).toBe("c3");
  });

  it("stores nothing when a later page fails", async () => {
    const { connection } = await connect();
    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1", has_more: true });
    fake.on("alex", "c1", { added: [txn("t2")], next_cursor: "c2" });
    const real = fake.plaid.transactionsSync;
    fake.plaid.transactionsSync = async (input) => {
      if (input.cursor === "c1") throw new PlaidError("/transactions/sync", 500, "INTERNAL_SERVER_ERROR", "API_ERROR", "req-3");
      return real(input);
    };
    await expect(syncConnection(w.db, bank, connection.id, NOW)).rejects.toThrow(/INTERNAL_SERVER_ERROR/);
    expect(await rows()).toHaveLength(0);
    expect((await connectionRow(connection.id)).cursor).toBeNull();
  });

  it("starts again from the first cursor when Plaid's data changes mid-read, and gives up after three tries", async () => {
    const { connection } = await connect();
    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1", has_more: true });
    fake.on("alex", "c1", { added: [txn("t2")], next_cursor: "c2" });
    fake.syncCalls.length = 0;
    const real = fake.plaid.transactionsSync;
    let failures = 1;
    fake.plaid.transactionsSync = async (input) => {
      if (input.cursor === "c1" && failures-- > 0) throw new PlaidError("/transactions/sync", 400, "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "TRANSACTIONS_ERROR", "r");
      return real(input);
    };
    expect((await syncConnection(w.db, bank, connection.id, NOW)).toSort).toBe(2);
    expect((await connectionRow(connection.id)).cursor).toBe("c2");

    const other = await connectApart(w.sam, "sam");
    fake.failNext("sam", ...Array(3).fill("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"));
    await expect(syncConnection(w.db, bank, other.connection.id, NOW)).rejects.toThrow(/MUTATION_DURING_PAGINATION/);
  });

  it("removes a waiting transaction, ignores ids never stored, and leaves one already added", async () => {
    await agree(w, FROM, { rules: [{ scope: "household", rule: { kind: "even" } }] });
    const { connection } = await connect();
    fake.on("alex", "", { added: [txn("t1"), txn("t2")], next_cursor: "c1" });
    await syncConnection(w.db, bank, connection.id, NOW);
    const made = await addFromBank(w.db, w.alex, (await byId("t2")).id, {}, TODAY);
    fake.on("alex", "c1", { removed: [{ transaction_id: "t1" }, { transaction_id: "t2" }, { transaction_id: "t-pending-never-stored" }], next_cursor: "c2" });
    expect((await syncConnection(w.db, bank, connection.id, NOW)).removed).toBe(1);
    expect((await byId("t1")).state).toBe("removed");
    expect(await byId("t2")).toMatchObject({ state: "added", expenseId: made.id });
    expect((await w.db.select().from(expense).where(eq(expense.id, made.id)))[0]!.status).toBe("posted");
  });

  it("changes date, amount and description only while a transaction waits", async () => {
    const { connection } = await connect();
    fake.on("alex", "", { added: [txn("t1"), txn("t2")], next_cursor: "c1" });
    await syncConnection(w.db, bank, connection.id, NOW);
    await dismissBankTransaction(w.db, w.alex, (await byId("t2")).id);
    fake.on("alex", "c1", {
      modified: [txn("t1", { amount: 25.5, date: "2027-03-06", merchant_name: "Corner Shop Ltd" }), txn("t2", { amount: 99 })],
      next_cursor: "c2",
    });
    expect((await syncConnection(w.db, bank, connection.id, NOW)).modified).toBe(1);
    expect(await byId("t1")).toMatchObject({ amountCents: 2550, date: "2027-03-06", description: "Corner Shop Ltd", state: "to_sort" });
    expect(await byId("t2")).toMatchObject({ amountCents: 2000, state: "dismissed" });
  });

  it("marks a connection that needs signing in again, and clears it once a sync works", async () => {
    const { connection } = await connect();
    fake.failNext("alex", "ITEM_LOGIN_REQUIRED", "ITEM_LOGIN_REQUIRED");
    expect((await syncConnection(w.db, bank, connection.id, NOW)).outcome).toBe("needs_relink");
    expect((await syncConnection(w.db, bank, connection.id, NOW)).outcome).toBe("needs_relink");
    expect((await connectionRow(connection.id)).status).toBe("needs_relink");
    expect((await syncConnection(w.db, bank, connection.id, NOW)).outcome).toBe("ok");
    expect((await connectionRow(connection.id)).status).toBe("ok");
    const actions = await actionsFor();
    expect(actions.filter((a) => a === "bank_connection.needs_relink")).toHaveLength(1);
    expect(actions).toContain("bank_connection.reconnected");
  });

  it("marks needs_relink for other errors Plaid says need the person, and leaves transient ones alone", async () => {
    const { connection } = await connect();
    fake.failNext("alex", "RATE_LIMIT_EXCEEDED");
    await expect(syncConnection(w.db, bank, connection.id, NOW)).rejects.toThrow();
    fake.failNext("alex", "INTERNAL_SERVER_ERROR");
    await expect(syncConnection(w.db, bank, connection.id, NOW)).rejects.toThrow();
    expect((await connectionRow(connection.id)).status).toBe("ok");
    for (const code of ["USER_SETUP_REQUIRED", "PASSWORD_RESET_REQUIRED", "ITEM_LOCKED"]) {
      fake.failNext("alex", code);
      expect((await syncConnection(w.db, bank, connection.id, NOW)).outcome).toBe("needs_relink");
    }
    expect((await connectionRow(connection.id)).status).toBe("needs_relink");
  });

  it("throws any other Plaid error", async () => {
    const { connection } = await connect();
    fake.failNext("alex", "RATE_LIMIT_EXCEEDED");
    await expect(syncConnection(w.db, bank, connection.id, NOW)).rejects.toThrow(/RATE_LIMIT_EXCEEDED/);
  });
});

describe("accounts that share everything", () => {
  it("adds each purchase at once, paid by the owner and split by that date's rules to the cent", async () => {
    await agree(w, FROM, { rules: [{ scope: "household", rule: { kind: "even" } }] });
    const { connection, accounts } = await connect();
    const card = accounts[0]!;
    await setShareAll(w.db, w.alex, card.id, true);
    fake.on("alex", "", { added: [txn("t1", { amount: 19.99 })], next_cursor: "c1" });
    expect(await syncConnection(w.db, bank, connection.id, NOW)).toMatchObject({ added: 1, toSort: 0 });

    const row = await byId("t1");
    expect(row.state).toBe("added");
    const [moved] = await w.db.select().from(auditLog).where(eq(auditLog.action, "bank_transaction.added"));
    expect(moved).toMatchObject({ actorKind: "system", entityId: row.id, detail: { expenseId: row.expenseId, auto: true } });
    const [made] = await w.db.select().from(expense).where(eq(expense.id, row.expenseId!));
    expect(made).toMatchObject({
      source: "bank",
      status: "posted",
      payerId: w.alex.id,
      date: "2027-03-05",
      accountId: card.id,
      category: "other",
      totalCents: 1999,
      description: "Corner Shop",
      createdBy: null,
    });
    const shares = await w.db.select().from(expenseShare).where(eq(expenseShare.expenseId, made!.id));
    expect(shares.reduce((sum, s) => sum + s.shareCents, 0)).toBe(1999);
    expect(shares).toHaveLength(2);
  });

  it("adds it as an expense waiting to be split when the split cannot be worked out", async () => {
    // Split by income, with no incomes recorded.
    await agree(w, FROM, { rules: [{ scope: "household", rule: { kind: "income_proportional" } }] });
    const { connection, accounts } = await connect();
    await setShareAll(w.db, w.alex, accounts[0]!.id, true);
    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1" });
    await syncConnection(w.db, bank, connection.id, NOW);
    const [made] = await w.db.select().from(expense).where(eq(expense.id, (await byId("t1")).expenseId!));
    expect(made!.status).toBe("unassigned");
  });

  it("leaves money in, and anything dated after today, to be sorted", async () => {
    await agree(w, FROM, { rules: [{ scope: "household", rule: { kind: "even" } }] });
    const { connection, accounts } = await connect();
    await setShareAll(w.db, w.alex, accounts[0]!.id, true);
    fake.on("alex", "", { added: [txn("t-refund", { amount: -15 }), txn("t-later", { date: "2027-03-11" })], next_cursor: "c1" });
    expect(await syncConnection(w.db, bank, connection.id, NOW)).toMatchObject({ added: 0, toSort: 2 });
  });

  it("only changes transactions synced from then on, and only for the owner", async () => {
    const { connection, accounts } = await connect();
    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1" });
    await syncConnection(w.db, bank, connection.id, NOW);
    await expect(setShareAll(w.db, w.sam, accounts[0]!.id, true)).rejects.toThrow(/only the person who connected/);
    await setShareAll(w.db, w.alex, accounts[0]!.id, true);
    expect((await byId("t1")).state).toBe("to_sort");
    expect(await actionsFor()).toContain("account.share_all_changed");
    const plain = await addAccount(w.db, w.alex, { name: "Cash" });
    await expect(setShareAll(w.db, w.alex, plain.id, true)).rejects.toThrow(/only the person who connected/);
  });
});

describe("sorting", () => {
  async function waiting(transactions: PlaidTransaction[] = [txn("t1"), txn("t-in", { amount: -30 })]) {
    const { connection } = await connect();
    fake.on("alex", "", { added: transactions, next_cursor: "c1" });
    await syncConnection(w.db, bank, connection.id, NOW);
    return connection;
  }

  it("shows each person only what their own connections brought in", async () => {
    await waiting();
    const jo = await otherGroup();
    expect((await listToSort(w.db, w.alex)).map((t) => [t.plaidTransactionId, t.accountName, t.lastFour])).toEqual([
      ["t-in", "Everyday Card", "1234"],
      ["t1", "Everyday Card", "1234"],
    ]);
    expect(await listToSort(w.db, w.sam)).toEqual([]);
    expect(await listToSort(w.db, jo)).toEqual([]);
  });

  it("adds a purchase as an expense the owner paid, with the category and description given", async () => {
    await agree(w, FROM, { rules: [{ scope: "household", rule: { kind: "even" } }] });
    await waiting();
    const t1 = await byId("t1");
    const made = await addFromBank(w.db, w.alex, t1.id, { category: "groceries", description: "Weekly shop" }, TODAY);
    expect(made).toMatchObject({ source: "bank", payerId: w.alex.id, category: "groceries", description: "Weekly shop", totalCents: 2000, createdBy: w.alex.id, status: "posted" });
    expect(await byId("t1")).toMatchObject({ state: "added", expenseId: made.id, sortedBy: w.alex.id });
    expect(Object.values(made.shares).reduce((a, b) => a + b, 0)).toBe(2000);
    expect(await actionsFor()).toContain("bank_transaction.added");
  });

  it("refuses another member's, another group's, money in, and one already sorted", async () => {
    await waiting();
    const jo = await otherGroup();
    const t1 = await byId("t1");
    await expect(addFromBank(w.db, w.sam, t1.id, {}, TODAY)).rejects.toThrow(/not one of yours/);
    await expect(addFromBank(w.db, jo, t1.id, {}, TODAY)).rejects.toThrow(/not one of yours/);
    await expect(dismissBankTransaction(w.db, w.sam, t1.id)).rejects.toThrow(/not one of yours/);
    await expect(addFromBank(w.db, w.alex, "not-an-id", {}, TODAY)).rejects.toThrow(/not one of yours/);
    await expect(addFromBank(w.db, w.alex, (await byId("t-in")).id, {}, TODAY)).rejects.toThrow(/can only be set aside/);
    await dismissBankTransaction(w.db, w.alex, t1.id);
    await expect(addFromBank(w.db, w.alex, t1.id, {}, TODAY)).rejects.toThrow(/already been sorted/);
    await expect(dismissBankTransaction(w.db, w.alex, t1.id)).rejects.toThrow(/already been sorted/);
  });

  it("makes one expense from a double tap", async () => {
    await waiting();
    const t1 = await byId("t1");
    const results = await Promise.allSettled([addFromBank(w.db, w.alex, t1.id, {}, TODAY), addFromBank(w.db, w.alex, t1.id, {}, TODAY)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await w.db.select().from(expense).where(eq(expense.source, "bank"))).toHaveLength(1);
  });

  it("sets money in aside, and puts it back, once each for a double tap", async () => {
    await waiting();
    const id = (await byId("t-in")).id;
    const dismissed = await Promise.allSettled([dismissBankTransaction(w.db, w.alex, id), dismissBankTransaction(w.db, w.alex, id)]);
    expect(dismissed.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await byId("t-in")).toMatchObject({ state: "dismissed", sortedBy: w.alex.id });
    await expect(restoreBankTransaction(w.db, w.sam, id)).rejects.toThrow(/not one of yours/);
    await restoreBankTransaction(w.db, w.alex, id);
    await expect(restoreBankTransaction(w.db, w.alex, id)).rejects.toThrow(/not set aside/);
    expect(await byId("t-in")).toMatchObject({ state: "to_sort", sortedBy: null });
    const actions = await actionsFor();
    expect(actions.filter((a) => a === "bank_transaction.dismissed")).toHaveLength(1);
    expect(actions).toContain("bank_transaction.restored");
  });
});

describe("removeBankConnection", () => {
  it("tells Plaid, blanks the token, keeps the accounts and sets aside what was waiting", async () => {
    const { connection, accounts } = await connect();
    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1" });
    await syncConnection(w.db, bank, connection.id, NOW);
    await expect(removeBankConnection(w.db, bank, w.sam, connection.id)).rejects.toThrow(/only the person who connected/);

    await removeBankConnection(w.db, bank, w.alex, connection.id);
    expect(fake.removedItems).toEqual(["access-alex"]);
    expect(await connectionRow(connection.id)).toMatchObject({ accessToken: null });
    expect((await connectionRow(connection.id)).removedAt).not.toBeNull();
    const kept = await w.db.select().from(account).where(and(eq(account.householdId, w.householdId), eq(account.bankConnectionId, connection.id)));
    expect(kept.map((a) => [a.id, a.archivedAt])).toEqual(accounts.map((a) => [a.id, null]));
    expect((await byId("t1")).state).toBe("dismissed");
    expect(await actionsFor()).toContain("bank_connection.removed");

    await expect(removeBankConnection(w.db, bank, w.alex, connection.id)).rejects.toThrow(/already disconnected/);
    await expect(syncConnection(w.db, bank, connection.id, NOW)).rejects.toThrow(/no longer connected/);
    // Nothing from a disconnected bank comes back to be sorted.
    await expect(restoreBankTransaction(w.db, w.alex, (await byId("t1")).id)).rejects.toThrow(/no longer connected/);
  });

  it("removes locally, without calling Plaid, when the stored token cannot be opened", async () => {
    const { connection } = await connect();
    const rotated: BankDeps = { plaid: fake.plaid, key: randomBytes(32) };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await removeBankConnection(w.db, rotated, w.alex, connection.id);
    expect(log.mock.calls.flat().join("\n")).toContain(`connection ${connection.id} removed here only`);
    log.mockRestore();
    expect(fake.removedItems).toEqual([]);
    expect((await connectionRow(connection.id)).removedAt).not.toBeNull();
    const [entry] = (await w.db.select().from(auditLog).where(eq(auditLog.action, "bank_connection.removed")));
    expect(JSON.stringify(entry!.detail)).toMatch(/could not be opened/);
  });

  it("finishes when Plaid has already forgotten the login, and stops on any other error", async () => {
    const { connection } = await connect();
    fake.failNext("alex", "INTERNAL_SERVER_ERROR");
    await expect(removeBankConnection(w.db, bank, w.alex, connection.id)).rejects.toThrow(/INTERNAL_SERVER_ERROR/);
    expect((await connectionRow(connection.id)).removedAt).toBeNull();
    fake.failNext("alex", "ITEM_NOT_FOUND");
    await removeBankConnection(w.db, bank, w.alex, connection.id);
    expect((await connectionRow(connection.id)).removedAt).not.toBeNull();
  });
});

describe("syncAllConnections", () => {
  it("syncs every live connection, and one failure does not stop the rest", async () => {
    const alex = await connect();
    await connectApart(w.sam, "sam");
    const gone = await connectApart(w.alex, "old");
    await removeBankConnection(w.db, bank, w.alex, gone.connection.id);
    fake.failNext("sam", "INTERNAL_SERVER_ERROR");
    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1" });
    expect(await syncAllConnections(w.db, bank, NOW)).toEqual({ synced: 1, needsRelink: 0, superseded: 0, failed: 1 });
    expect((await connectionRow(alex.connection.id)).cursor).toBe("c1");
  });
});

describe("group scoping in the schema", () => {
  it("refuses a transaction on another group's account", async () => {
    const { connection } = await connect();
    const jo = await otherGroup();
    const theirs = await addAccount(w.db, jo, { name: "Jo's card" });
    await expect(
      w.db.insert(bankTransaction).values({
        householdId: w.householdId,
        connectionId: connection.id,
        accountId: theirs.id,
        plaidTransactionId: "t-cross",
        date: "2027-03-05",
        amountCents: 100,
        description: "Corner Shop",
      }),
    ).rejects.toThrow();
  });
});

describe("a transaction the bank withdraws", () => {
  it("is withdrawn even when set aside, so it cannot be restored and counted beside the corrected charge", async () => {
    const { connection } = await connect();
    fake.on("alex", "", { added: [txn("t1", { amount: 50 })], next_cursor: "c1" });
    await syncConnection(w.db, bank, connection.id, NOW);
    await dismissBankTransaction(w.db, w.alex, (await byId("t1")).id);
    fake.on("alex", "c1", { removed: [{ transaction_id: "t1" }], added: [txn("t2", { amount: 55 })], next_cursor: "c2" });
    expect((await syncConnection(w.db, bank, connection.id, NOW)).removed).toBe(1);
    expect((await byId("t1")).state).toBe("removed");
    await expect(restoreBankTransaction(w.db, w.alex, (await byId("t1")).id)).rejects.toThrow(/not set aside/);
  });
});

describe("an account in a business group", () => {
  it("cannot share everything or add a purchase until it is marked personal or business", async () => {
    const [h] = await w.db.insert(household).values({ name: "Alex Studio", kind: "business", timezone: "America/New_York" }).returning();
    await seedCategories(w.db, h!.id, "business");
    const [boss] = await w.db.insert(member).values({ householdId: h!.id, email: "alex@example.com", displayName: "Alex", linkedAt: new Date() }).returning();
    const { connection, accounts } = await connectBank(w.db, bank, boss!, { publicToken: "biz", institutionName: "First Platypus Bank" }, FROM, NOW);
    const card = accounts[0]!;
    expect(card.kind).toBeNull();

    await expect(setShareAll(w.db, boss!, card.id, true)).rejects.toThrow(/personal or business/);

    fake.on("biz", "", { added: [txn("b1")], next_cursor: "c1" });
    await syncConnection(w.db, bank, connection.id, NOW);
    const id = (await byId("b1")).id;
    await expect(addFromBank(w.db, boss!, id, {}, TODAY)).rejects.toThrow(/personal or business/);

    await w.db.update(account).set({ kind: "business" }).where(eq(account.id, card.id));
    await addFromBank(w.db, boss!, id, {}, TODAY);
    expect((await byId("b1")).state).toBe("added");
  });
});

describe("a change from the bank", () => {
  it("is held to the same currency and start date as a new transaction", async () => {
    const { connection } = await connect();
    fake.on("alex", "", { added: [txn("t1"), txn("t2")], next_cursor: "c1" });
    await syncConnection(w.db, bank, connection.id, NOW);
    fake.on("alex", "c1", {
      modified: [txn("t1", { amount: 30, iso_currency_code: "CAD" }), txn("t2", { amount: 30, date: "2027-02-20" })],
      next_cursor: "c2",
    });
    const summary = await syncConnection(w.db, bank, connection.id, NOW);
    expect(summary.modified).toBe(0);
    expect(summary.skipped).toMatchObject({ not_usd: 1, before_sync_from: 1 });
    for (const id of ["t1", "t2"]) expect(await byId(id)).toMatchObject({ amountCents: 2000, date: "2027-03-05" });
  });
});

describe("a purchase added on its own", () => {
  it("is stamped with the sync's clock", async () => {
    const { connection, accounts } = await connect();
    await agree(w, FROM, { rules: [{ scope: "household", rule: { kind: "even" } }] });
    await setShareAll(w.db, w.alex, accounts[0]!.id, true);
    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1" });
    await syncConnection(w.db, bank, connection.id, NOW);
    expect((await byId("t1")).state).toBe("added");
    expect((await byId("t1")).sortedAt).toEqual(NOW);
  });
});

describe("the group's activity feed", () => {
  it("leaves out a member setting aside or restoring their own card transactions", async () => {
    const { connection } = await connect();
    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1" });
    await syncConnection(w.db, bank, connection.id, NOW);
    await dismissBankTransaction(w.db, w.alex, (await byId("t1")).id);
    await restoreBankTransaction(w.db, w.alex, (await byId("t1")).id);
    const texts = (await recentActivity(w.db, w.householdId, new Map(), 50)).map((a) => a.text);
    expect(texts.filter((t) => /card transaction/.test(t))).toEqual([]);
    expect(texts).toContain("Connected a bank");
  });
});
