// Every expense of a group in one list, newest first, a page at a time and
// narrowed by filters. The web page reads the filters from its address and
// the API from its query string; both go through `parseExpenseFilter` and
// `parseExpensePage`, so they mean the same thing in each.
import { and, desc, eq, gte, ilike, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { ACCOUNT_KINDS, EXPENSE_SOURCES, account, category, expense, member, type AccountKind, type Expense } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { isIsoDate } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { isUuid } from "./ids.ts";
import { parseCents } from "@abacus/core/money";
import { withShares, type ExpenseWithShares } from "./expenses.ts";

// The statuses that count: not replaced, not voided. Proposals and the ones
// turned down are not expenses yet; they belong to review, never this list.
const LIVE = ["posted", "unassigned", "needs_amount"] as const;
const SHOWN = [...LIVE, "superseded", "void"] as const;
// For the account filter: costs with no account.
export const NO_ACCOUNT = "none";
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const MAX_SEARCH = 100;
// The most a whole number in a filter may be: twelve digits. As an amount,
// $9,999,999,999.99.
export const MAX_WHOLE = 999_999_999_999;

export type ExpenseFilter = {
  // Dates are inclusive.
  from?: string;
  to?: string;
  category?: string;
  // A member id.
  payer?: string;
  // An account id, or NO_ACCOUNT.
  account?: string;
  // The kind of the account it was paid from; only a business group's
  // accounts have one.
  accountKind?: AccountKind;
  source?: Expense["source"];
  // "live" is every expense that counts; "all" adds replaced and voided ones.
  status: (typeof SHOWN)[number] | "live" | "all";
  minCents?: number;
  maxCents?: number;
  // Words to find in the description.
  q?: string;
};

export type ExpensePage = {
  limit: number;
  // Where the previous page ended, as `nextCursor` gave it.
  cursor?: string;
};

export type ExpenseList = {
  items: ExpenseWithShares[];
  // Pass as `cursor` for the page after this one; null on the last page.
  nextCursor: string | null;
  // How many expenses match, beyond this page.
  count: number;
  // The sum of every match that counts (not replaced, not voided, and with
  // an amount), beyond this page.
  totalCents: number;
};


function whole(text: string, what: string, min: number): number {
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > MAX_WHOLE) throw new UserError(`${what} must be a whole number of at least ${min}`);
  return Number(text);
}

// How a refusal names what was wrong. The API names its query parameters;
// the web page names the labels on its form, and its choices as it shows them.
export type FilterNames = {
  fields?: Partial<Record<keyof ExpenseFilter, string>>;
  // The statuses that may be asked for, as a sentence's ending.
  statuses?: string;
};

const API_NAMES: FilterNames = {};

// The web page's "Show" choices: the value in the address, the words in the form.
export const STATUS_CHOICES = [
  ["", "Current expenses"],
  ["unassigned", "Not split"],
  ["needs_amount", "Waiting for an amount"],
  ["superseded", "Replaced"],
  ["void", "Voided"],
  ["all", "Everything, with replaced and voided"],
] as const;

export const FORM_NAMES: FilterNames = {
  fields: {
    from: "From",
    to: "To",
    category: "Category",
    payer: "Paid by",
    account: "Paid from",
    accountKind: "Whose money",
    source: "Entered",
    status: "Show",
    minCents: "At least",
    maxCents: "At most",
    q: "Search",
  },
  statuses: `one of ${STATUS_CHOICES.map(([, label]) => `"${label}"`).join(", ")}`,
};

// Reads filters from text, as an address or a query string carries them.
// Blank values are no filter. Anything that cannot be read is a UserError,
// never a filter quietly dropped: a list that ignored "from" would look right
// and be wrong.
export function parseExpenseFilter(get: (key: string) => string | null | undefined, names: FilterNames = API_NAMES): ExpenseFilter {
  const text = (key: string) => (get(key) ?? "").trim();
  const name = (key: keyof ExpenseFilter) => names.fields?.[key] ?? key;
  const filter: ExpenseFilter = { status: "live" };

  for (const key of ["from", "to"] as const) {
    const v = text(key);
    if (!v) continue;
    if (!isIsoDate(v)) throw new UserError(`${name(key)} must be a date like 2026-01-31`);
    filter[key] = v;
  }
  if (filter.from && filter.to && filter.from > filter.to) throw new UserError(`${name("from")} must not be later than ${name("to")}`);

  if (text("category")) filter.category = text("category").toLowerCase();

  const payer = text("payer").toLowerCase();
  if (payer) {
    if (!isUuid(payer)) throw new UserError(`${name("payer")} must be a member of this group`);
    filter.payer = payer;
  }

  const acct = text("account").toLowerCase();
  if (acct) {
    if (acct !== NO_ACCOUNT && !isUuid(acct)) throw new UserError(`${name("account")} must be one of this group's accounts, or ${NO_ACCOUNT}`);
    filter.account = acct;
  }

  const kind = text("accountKind");
  if (kind) {
    if (!(ACCOUNT_KINDS as readonly string[]).includes(kind)) throw new UserError(`${name("accountKind")} must be one of ${ACCOUNT_KINDS.join(", ")}`);
    filter.accountKind = kind as AccountKind;
  }

  const source = text("source");
  if (source) {
    if (!(EXPENSE_SOURCES as readonly string[]).includes(source)) {
      throw new UserError(`${name("source")} must be one of ${EXPENSE_SOURCES.join(", ")}`);
    }
    filter.source = source as Expense["source"];
  }

  const status = text("status");
  if (status) {
    if (status !== "live" && status !== "all" && !(SHOWN as readonly string[]).includes(status)) {
      throw new UserError(`${name("status")} must be ${names.statuses ?? `live, all, or one of ${SHOWN.join(", ")}`}`);
    }
    filter.status = status as ExpenseFilter["status"];
  }

  if (text("minCents")) filter.minCents = whole(text("minCents"), name("minCents"), 0);
  if (text("maxCents")) filter.maxCents = whole(text("maxCents"), name("maxCents"), 0);
  if (filter.minCents !== undefined && filter.maxCents !== undefined && filter.minCents > filter.maxCents) {
    throw new UserError(`${name("minCents")} can't be more than ${name("maxCents")}`);
  }

  // Refused, not cut: a search for something else than was typed would look
  // like an answer.
  if (text("q").length > MAX_SEARCH) throw new UserError(`${name("q")} must be at most ${MAX_SEARCH} characters`);
  if (text("q")) filter.q = text("q");
  return filter;
}

// The web page's form, read from its address. Amounts are typed as dollars
// ("12.50") in `min` and `max`; there is no page size, and refusals name the
// form's labels.
export function parseListForm(given: (key: string) => string): { filter: ExpenseFilter; page: ExpensePage } {
  const amount = (key: "min" | "max", field: "minCents" | "maxCents") => {
    const text = given(key).trim();
    if (!text) return "";
    const cents = parseCents(text);
    if (cents === null || cents > MAX_WHOLE) throw new UserError(`${FORM_NAMES.fields![field]} must be an amount like 12.50`);
    return String(cents);
  };
  const cents: Record<string, string> = { minCents: amount("min", "minCents"), maxCents: amount("max", "maxCents") };
  const get = (key: string) => (key in cents ? cents[key] : key === "limit" ? "" : given(key));
  return { filter: parseExpenseFilter(get, FORM_NAMES), page: parseExpensePage(get) };
}

// A cursor is the id of the last expense on a page. The next page starts
// after that row's (date, created_at, id) as the database stores them, so
// timestamps are compared to the microsecond. Encoded so clients treat it
// as opaque.
const encodeCursor = (id: string) => Buffer.from(id).toString("base64url");
export const BAD_CURSOR = "cursor is not one this list gave; start again from the first page";

function decodeCursor(cursor: string): string {
  const id = /^[A-Za-z0-9_-]{1,64}$/.test(cursor) ? Buffer.from(cursor, "base64url").toString() : "";
  if (!isUuid(id)) throw new UserError(BAD_CURSOR);
  return id;
}

export function parseExpensePage(get: (key: string) => string | null | undefined): ExpensePage {
  const text = (key: string) => (get(key) ?? "").trim();
  const page: ExpensePage = { limit: DEFAULT_LIMIT };
  if (text("limit")) page.limit = Math.min(whole(text("limit"), "limit", 1), MAX_LIMIT);
  if (text("cursor")) {
    decodeCursor(text("cursor"));
    page.cursor = text("cursor");
  }
  return page;
}

// `%`, `_` and `\` mean something to LIKE; someone searching for "50%"
// means the characters.
export const likeText = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

export async function exists(query: Promise<unknown[]>, refusal: string): Promise<void> {
  if ((await query).length === 0) throw new UserError(refusal);
}

// The filter as a condition on the expense table, always within the group.
// A category, payer or account that is not the group's is a UserError, so a
// mistyped filter is not an empty list.
export async function expenseConditions(db: Db, householdId: string, filter: ExpenseFilter, names: FilterNames = API_NAMES): Promise<SQL> {
  const name = (key: keyof ExpenseFilter) => names.fields?.[key] ?? key;
  const where: (SQL | undefined)[] = [eq(expense.householdId, householdId)];
  if (filter.from) where.push(gte(expense.date, filter.from));
  if (filter.to) where.push(lte(expense.date, filter.to));
  if (filter.category) {
    await exists(
      db.select({ slug: category.slug }).from(category).where(and(eq(category.householdId, householdId), eq(category.slug, filter.category))).limit(1),
      `${name("category")} must be one of this group's categories`,
    );
    where.push(eq(expense.category, filter.category));
  }
  if (filter.payer) {
    await exists(
      db.select({ id: member.id }).from(member).where(and(eq(member.householdId, householdId), eq(member.id, filter.payer))).limit(1),
      `${name("payer")} must be a member of this group`,
    );
    where.push(eq(expense.payerId, filter.payer));
  }
  if (filter.account === NO_ACCOUNT) where.push(isNull(expense.accountId));
  else if (filter.account) {
    await exists(
      db.select({ id: account.id }).from(account).where(and(eq(account.householdId, householdId), eq(account.id, filter.account))).limit(1),
      `${name("account")} must be one of this group's accounts, or ${NO_ACCOUNT}`,
    );
    where.push(eq(expense.accountId, filter.account));
  }
  if (filter.accountKind) {
    where.push(
      inArray(
        expense.accountId,
        db.select({ id: account.id }).from(account).where(and(eq(account.householdId, householdId), eq(account.kind, filter.accountKind))),
      ),
    );
  }
  if (filter.source) where.push(eq(expense.source, filter.source));
  if (filter.status === "live") where.push(inArray(expense.status, [...LIVE]));
  else if (filter.status === "all") where.push(inArray(expense.status, [...SHOWN]));
  else where.push(eq(expense.status, filter.status));
  if (filter.minCents !== undefined) where.push(gte(expense.totalCents, filter.minCents));
  if (filter.maxCents !== undefined) where.push(lte(expense.totalCents, filter.maxCents));
  if (filter.q) where.push(ilike(expense.description, likeText(filter.q)));
  return and(...where)!;
}

// Newest first: by date, then when it was entered, then id, so a page never
// shuffles between requests.
export async function listExpenses(
  db: Db,
  householdId: string,
  filter: ExpenseFilter,
  page: ExpensePage = { limit: DEFAULT_LIMIT },
  names: FilterNames = API_NAMES,
): Promise<ExpenseList> {
  const matching = await expenseConditions(db, householdId, filter, names);

  const [sums] = await db
    .select({
      count: sql<number>`count(*)::int`,
      totalCents: sql<string>`coalesce(sum(${expense.totalCents}) filter (where ${expense.status} in ('posted', 'unassigned', 'needs_amount')), 0)`,
    })
    .from(expense)
    .where(matching);

  let after: SQL | undefined;
  if (page.cursor) {
    const id = decodeCursor(page.cursor);
    await exists(
      db.select({ id: expense.id }).from(expense).where(and(eq(expense.householdId, householdId), eq(expense.id, id))).limit(1),
      BAD_CURSOR,
    );
    // The row's own stored values, so nothing is lost to JavaScript's
    // millisecond dates.
    after = sql`(${expense.date}, ${expense.createdAt}, ${expense.id}) < (select c.date, c.created_at, c.id from expense c where c.id = ${id})`;
  }

  // One more than asked shows whether another page follows.
  const rows = await db
    .select()
    .from(expense)
    .where(and(matching, after))
    .orderBy(desc(expense.date), desc(expense.createdAt), desc(expense.id))
    .limit(page.limit + 1);
  const more = rows.length > page.limit;
  const items = await withShares(db, rows.slice(0, page.limit));
  return {
    items,
    nextCursor: more ? encodeCursor(items[items.length - 1]!.id) : null,
    count: sums!.count,
    totalCents: Number(sums!.totalCents),
  };
}
