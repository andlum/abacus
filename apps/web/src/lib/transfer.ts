// Export and import of the household's expenses as CSV. Import is how past
// expenses get re-split by today's rules: the app never does that by itself.
import { createHash } from "node:crypto";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { account, expense, household, importBatch, type Account, type Expense, type Member, type RuleSource } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { cleanAccountName, insertAccount, listAccounts, parseAccountKind } from "./accounts.ts";
import { writeAudit } from "./audit.ts";
import { getBalance } from "./balance.ts";
import { listCategories, parseCategory } from "./categories.ts";
import { parseCsv, plainText, toCsv } from "@abacus/core/csv";
import { isIsoDate } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { isUuid } from "./ids.ts";
import { createExpense, withShares, type ExpenseWithShares } from "./expenses.ts";
import { householdMembers } from "./members.ts";
import { centsToDecimal, parseCents } from "@abacus/core/money";

const FIXED = ["id", "date", "description", "category", "amount", "payer", "status"] as const;
// Which account paid, by name, and in a business group whether it is
// personal or business. A file from before accounts has neither column.
const ACCOUNT = ["account", "account_kind"] as const;
const SHARE = "share: ";
// The most accounts one file may add; more is more likely a wrong column.
export const MAX_IMPORT_ACCOUNTS = 20;

// Expenses with an amount, in a date range (inclusive). Bills still waiting
// for their amount are left out: there is nothing to split yet.
export async function exportCsv(db: Db, householdId: string, from: string, to: string): Promise<string> {
  if (!isIsoDate(from) || !isIsoDate(to)) throw new UserError("the date range is not valid");
  // By email, so the columns come out in the same order every time.
  const members = (await householdMembers(db, householdId)).sort((a, b) => a.email.localeCompare(b.email));
  const rows = await withShares(
    db,
    await db
      .select()
      .from(expense)
      .where(
        and(
          eq(expense.householdId, householdId),
          inArray(expense.status, ["posted", "unassigned"]),
          gte(expense.date, from),
          lte(expense.date, to),
        ),
      )
      .orderBy(asc(expense.date), asc(expense.createdAt), asc(expense.id)),
  );
  const emailOf = new Map(members.map((m) => [m.id, m.email]));
  const accounts = new Map((await listAccounts(db, householdId, { archived: true })).map((a) => [a.id, a]));
  return toCsv([
    [...FIXED, ...ACCOUNT, ...members.map((m) => SHARE + m.email), "rule_source"],
    ...rows.map((e) => [
      e.id,
      e.date,
      e.description,
      e.category,
      centsToDecimal(e.totalCents!),
      emailOf.get(e.payerId) ?? "",
      e.status,
      (e.accountId && accounts.get(e.accountId)?.name) ?? "",
      (e.accountId && accounts.get(e.accountId)?.kind) ?? "",
      ...members.map((m) => (e.status === "posted" ? centsToDecimal(e.shares[m.id] ?? 0) : "")),
      e.ruleSource ?? "",
    ]),
  ]);
}

export type ImportError = { line: number; message: string };

type ParsedRow = {
  line: number;
  id: string | null;
  date: string;
  description: string;
  category: string;
  totalCents: number;
  payerId: string;
  // The account's name as cleaned, or null for none. Undefined when the file
  // has no account column, so a replaced expense keeps its account.
  account?: string | null;
  // For an account the group does not have yet: added with this kind.
  accountKind?: string | null;
};

// Which account a row goes on, settled when the file is read: one the group
// has, or one to add, named by its key (the name as the database lowercases it).
type AccountChoice = { id: string } | { add: string };

export type ImportRow = ParsedRow & {
  // The expense this row replaces, when it has an id.
  old: { status: Expense["status"]; totalCents: number; payerId: string; shares: Record<string, number> } | null;
  status: "posted" | "unassigned";
  shares: Record<string, number>;
  ruleSource: RuleSource | null;
  unassignedReason: string | null;
};

export type ImportPreview =
  | { ok: false; errors: ImportError[] }
  | {
      ok: true;
      fileHash: string;
      rows: ImportRow[];
      // What importing does to each member's position. Sums to zero.
      balanceChange: Record<string, number>;
      // The accounts the import would add, as the file first names them.
      newAccounts: string[];
    };


async function parse(
  db: Db,
  householdId: string,
  text: string,
  today: string,
): Promise<
  | { ok: true; rows: (ParsedRow & { replaces: Expense | null; choice?: AccountChoice })[]; newAccounts: Map<string, string> }
  | { ok: false; errors: ImportError[] }
> {
  const table = parseCsv(text);
  if (!table) return { ok: false, errors: [{ line: 1, message: "the file has a quote that is never closed" }] };
  const [header, ...lines] = table;
  if (!header) return { ok: false, errors: [{ line: 1, message: "the file is empty" }] };
  const names = header.map((h) => h.trim().toLowerCase());
  const at = (name: string) => names.indexOf(name);
  const missing = FIXED.filter((name) => name !== "status" && at(name) < 0);
  if (missing.length > 0) {
    return { ok: false, errors: [{ line: 1, message: `the file has no ${missing.join(", ")} column` }] };
  }
  if (lines.length === 0) return { ok: false, errors: [{ line: 1, message: "the file has no expenses in it" }] };

  const members = await householdMembers(db, householdId);
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m.id]));
  const categories = new Set((await listCategories(db, householdId, { removed: true })).map((c) => c.slug));
  const ids = lines.map((l) => (l[at("id")] ?? "").trim()).filter((id) => isUuid(id));
  const live = ids.length
    ? await db
        .select()
        .from(expense)
        .where(and(eq(expense.householdId, householdId), inArray(expense.id, ids)))
    : [];
  const byId = new Map(live.map((e) => [e.id, e]));
  const hasAccount = at("account") >= 0;
  // Each account name the file gives, cleaned; a bad one is reported below.
  const accountNames = hasAccount
    ? lines.flatMap((l) => {
        try {
          const text = plainText((l[at("account")] ?? "").trim());
          return text ? [cleanAccountName(text)] : [];
        } catch {
          return [];
        }
      })
    : [];
  const [group] = await db.select({ kind: household.kind }).from(household).where(eq(household.id, householdId));
  const { byKey: known, byId: accountById, keys: keyOf } = await groupAccounts(db, householdId, accountNames);
  // An account the file names twice is added once, with the kind first given,
  // under the name first given.
  const adding = new Map<string, { name: string; kind: string | null }>();

  const errors: ImportError[] = [];
  const rows: (ParsedRow & { replaces: Expense | null; choice?: AccountChoice })[] = [];
  const seen = new Set<string>();
  lines.forEach((cells, index) => {
    const line = index + 2;
    const get = (name: string) => (cells[at(name)] ?? "").trim();
    const fail = (message: string) => errors.push({ line, message });
    const before = errors.length;

    const id = get("id").toLowerCase();
    let replaces: Expense | null = null;
    if (id) {
      const found = byId.get(id);
      if (!found) fail("no expense has that id");
      else if (!["posted", "unassigned", "needs_amount"].includes(found.status)) {
        fail(`that expense is ${found.status}, so it cannot be replaced`);
      } else if (seen.has(id)) fail("that id is in the file twice");
      else replaces = found;
      seen.add(id);
    }
    const date = get("date");
    if (!isIsoDate(date)) fail("the date must look like 2026-10-31");
    else if (date > today) fail("the date is later than today");
    const description = plainText(get("description"));
    if (!description) fail("the description is empty");
    const category = parseCategory(categories, get("category"));
    if (!category) fail(`the category must be blank or one of: ${[...categories].sort().join(", ")}`);
    const totalCents = parseCents(get("amount"));
    if (totalCents === null || totalCents <= 0) fail("the amount must be a number more than zero, like 1234.56");
    const payerId = byEmail.get(get("payer").toLowerCase());
    if (!payerId) fail(`the payer must be one of: ${members.map((m) => m.email).sort().join(", ")}`);
    let account: string | null | undefined;
    let accountKind: string | null = null;
    let choice: AccountChoice | undefined;
    if (hasAccount) {
      account = null;
      const text = plainText(get("account"));
      if (text) {
        try {
          account = cleanAccountName(text);
        } catch (e) {
          if (!(e instanceof UserError)) throw e;
          fail(e.message);
        }
      }
      const key = account ? keyOf.get(account)! : undefined;
      // A replaced expense whose account the file still names keeps it, even
      // archived with a live one of the same name since. Otherwise an account
      // in use wins, then an archived one, then one is added.
      const kept = replaces?.accountId ? accountById.get(replaces.accountId) : undefined;
      if (!key) choice = undefined;
      else if (kept && kept.key === key) choice = { id: kept.id };
      else if (known.has(key)) choice = { id: known.get(key)!.id };
      else {
        const pending = adding.get(key);
        if (pending) accountKind = pending.kind;
        else if (adding.size >= MAX_IMPORT_ACCOUNTS) {
          fail(`an import can add at most ${MAX_IMPORT_ACCOUNTS} accounts; add the others under Settings first`);
        } else if (group?.kind === "business") {
          accountKind = parseAccountKind(get("account_kind"));
          if (!accountKind) fail("this group has no account by that name; say in account_kind whether it is personal or business");
        }
        if (errors.length === before && !pending) adding.set(key, { name: account!, kind: accountKind });
        choice = { add: key };
      }
    }

    if (errors.length === before) {
      rows.push({
        line,
        id: id || null,
        date,
        description,
        category: category!,
        totalCents: totalCents!,
        payerId: payerId!,
        ...(account !== undefined ? { account, accountKind } : {}),
        replaces,
        choice,
      });
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rows, newAccounts: new Map([...adding].map(([key, a]) => [key, a.name])) };
}

// The group's accounts, archived ones included (a file may name an account
// archived since), keyed by name as the database lowercases it: the same
// lower() as the unique index on live names, which can differ from
// JavaScript's (a final capital sigma). One in use wins over an archived one
// of the same name. `names` are the file's names, each mapped to its key.
async function groupAccounts(db: Db, householdId: string, names: string[]) {
  const all = await db
    .select({ id: account.id, archivedAt: account.archivedAt, key: sql<string>`lower(${account.name})` })
    .from(account)
    .where(eq(account.householdId, householdId))
    .orderBy(asc(sql`lower(${account.name})`), asc(account.createdAt));
  const byKey = new Map([...all.filter((a) => a.archivedAt), ...all.filter((a) => !a.archivedAt)].map((a) => [a.key, a]));
  const distinct = [...new Set(names)];
  const keys = new Map<string, string>();
  if (distinct.length > 0) {
    const [row] = await db
      .select({ keys: sql<string[]>`array[${sql.join(distinct.map((n) => sql`lower(${n}::text)`), sql`, `)}]::text[]` })
      .from(household)
      .where(eq(household.id, householdId));
    distinct.forEach((n, i) => keys.set(n, row!.keys[i]!));
  }
  return { byKey, byId: new Map(all.map((a) => [a.id, a])), keys };
}

class Rollback extends Error {}

// Does the whole import inside one transaction and reports what it did.
// The preview runs this and rolls it back, so what it shows is exactly what
// applying the same file on the same day does, leftover cents included.
async function run(db: Db, actor: Member, text: string, today: string, commit: boolean): Promise<ImportPreview & { batchId?: string }> {
  const householdId = actor.householdId;
  const fileHash = createHash("sha256").update(text).digest("hex");
  let result: (ImportPreview & { batchId?: string }) | undefined;
  try {
    await db.transaction(async (tx) => {
      const parsed = await parse(tx, householdId, text, today);
      if (!parsed.ok) {
        result = parsed;
        return;
      }
      const before = (await getBalance(tx, householdId)).net;
      const olds = new Map(
        (await withShares(tx, parsed.rows.flatMap((r) => (r.replaces ? [r.replaces] : [])))).map((e) => [e.id, e]),
      );
      const [batch] = await tx
        .insert(importBatch)
        .values({ householdId, fileHash, rowCount: parsed.rows.length, createdBy: actor.id })
        .returning();
      const rows: ImportRow[] = [];
      const added = new Map<string, Account>();
      // The id of the account a row names, adding it the first time a file
      // names one the group does not have. An account that still cannot be
      // added, say one named by someone else a moment ago, fails its line.
      const accountIdOf = async (row: ParsedRow, choice: AccountChoice | undefined): Promise<string | null | undefined> => {
        if (row.account === undefined || row.account === null || !choice) return row.account;
        if ("id" in choice) return choice.id;
        let found = added.get(choice.add);
        if (!found) {
          try {
            found = await insertAccount(tx, actor, { name: row.account, kind: row.accountKind }, "import");
          } catch (e) {
            if (!(e instanceof UserError)) throw e;
            result = { ok: false, errors: [{ line: row.line, message: e.message }] };
            throw new Rollback();
          }
          added.set(choice.add, found);
        }
        return found.id;
      };
      for (const { replaces, choice, ...row } of parsed.rows) {
        const created: ExpenseWithShares = await createExpense(tx, householdId, {
          kind: "import",
          actor,
          date: row.date,
          description: row.description,
          category: row.category,
          totalCents: row.totalCents,
          payerId: row.payerId,
          accountId: await accountIdOf(row, choice),
          today,
          importBatchId: batch!.id,
          seed: `import:${fileHash}:${row.line}`,
          replaces: replaces ?? undefined,
        });
        const old = replaces ? olds.get(replaces.id)! : null;
        rows.push({
          ...row,
          old: old && { status: old.status, totalCents: old.totalCents!, payerId: old.payerId, shares: old.shares },
          status: created.status as "posted" | "unassigned",
          shares: created.shares,
          ruleSource: created.ruleSource,
          unassignedReason: created.unassignedReason,
        });
      }
      await writeAudit(tx, {
        householdId,
        actor: { kind: "member", memberId: actor.id },
        action: "import.applied",
        entity: { type: "import_batch", id: batch!.id },
        detail: { rowCount: rows.length, replaced: rows.filter((r) => r.old).length },
      });
      const after = (await getBalance(tx, householdId)).net;
      const balanceChange = Object.fromEntries(Object.keys(after).map((id) => [id, after[id]! - (before[id] ?? 0)]));
      result = { ok: true, fileHash, rows, balanceChange, newAccounts: [...parsed.newAccounts.values()], batchId: batch!.id };
      if (!commit) throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return result!;
}

// What importing this file today would do. Writes nothing.
export async function previewImport(db: Db, actor: Member, text: string, today: string): Promise<ImportPreview> {
  const { batchId: _, ...preview } = await run(db, actor, text, today, false);
  return preview;
}

// All or nothing: one bad row and nothing is written.
export async function applyImport(db: Db, actor: Member, text: string, today: string) {
  const result = await run(db, actor, text, today, true);
  if (!result.ok) {
    throw new UserError(`nothing was imported: line ${result.errors[0]!.line}: ${result.errors[0]!.message}`);
  }
  return { batchId: result.batchId!, rows: result.rows, balanceChange: result.balanceChange };
}
