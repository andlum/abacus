// Every movement of money in a group in one list, newest first: expenses,
// payments between members, and a business's repayments. One query over the
// three tables, each arm kept to the group, ordered by (date, created_at,
// id) so a page never shuffles between requests.
import { and, eq, gte, ilike, inArray, lte, sql, type SQL } from "drizzle-orm";
import { expense, reimbursement, settlement, type Reimbursement, type Settlement } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { isMonth, lastDayOfMonth, parseMonth } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { BAD_CURSOR, DEFAULT_LIMIT, exists, expenseConditions, FORM_NAMES, likeText, parseListForm, type ExpenseFilter, type ExpensePage, type FilterNames } from "./expense-list.ts";
import { withShares, type ExpenseWithShares } from "./expenses.ts";
import { isUuid } from "./ids.ts";

export type LedgerKind = "expense" | "payment" | "repayment";
const KINDS: readonly LedgerKind[] = ["expense", "payment", "repayment"];

export type LedgerFilter = ExpenseFilter & { month?: string };

export type LedgerItem =
  | { kind: "expense"; id: string; expense: ExpenseWithShares }
  // `replaced`: voided because an edit replaced it, not voided outright.
  | { kind: "payment"; id: string; payment: Settlement; replaced: boolean }
  | { kind: "repayment"; id: string; repayment: Reimbursement };

export type Ledger = {
  items: LedgerItem[];
  nextCursor: string | null;
  // How many rows match, beyond this page, and how many of each kind.
  count: number;
  counts: Record<LedgerKind, number>;
  // The sum of the matching expenses that count, as the expense list gives it.
  expenseTotalCents: number;
};

// The Ledger page's form: the Expenses list's filters and a month. A month
// narrows From and To; given with them, the list keeps the days in both.
export function parseLedgerForm(given: (key: string) => string): { filter: LedgerFilter; page: ExpensePage } {
  const { filter, page } = parseListForm(given);
  const month = given("month").trim();
  if (!month) return { filter, page };
  if (!isMonth(month)) throw new UserError("Month must be a month like 2026-03");
  const { year, month: m } = parseMonth(month);
  const first = `${month}-01`;
  const last = `${month}-${String(lastDayOfMonth(year, m)).padStart(2, "0")}`;
  return {
    filter: { ...filter, month, from: filter.from && filter.from > first ? filter.from : first, to: filter.to && filter.to < last ? filter.to : last },
    page,
  };
}

// The filters that only an expense has leave payments and repayments out.
const expenseOnly = (f: ExpenseFilter) => !!(f.category || f.account || f.accountKind || f.source || f.status === "unassigned" || f.status === "needs_amount");

type Table = typeof settlement | typeof reimbursement;
function common(t: Table, householdId: string, f: ExpenseFilter): SQL[] {
  const where = [eq(t.householdId, householdId)];
  if (f.from) where.push(gte(t.date, f.from));
  if (f.to) where.push(lte(t.date, f.to));
  if (f.minCents !== undefined) where.push(gte(t.amountCents, f.minCents));
  if (f.maxCents !== undefined) where.push(lte(t.amountCents, f.maxCents));
  if (f.q) where.push(ilike(t.note, likeText(f.q)));
  return where;
}

const wasReplaced = sql`exists (select 1 from settlement r where r.supersedes_id = ${settlement.id})`;

function paymentConditions(householdId: string, f: ExpenseFilter): SQL | null {
  if (expenseOnly(f)) return null;
  const where = common(settlement, householdId, f);
  if (f.payer) where.push(eq(settlement.fromMemberId, f.payer));
  if (f.status === "live" || f.status === "posted") where.push(eq(settlement.status, "recorded"));
  else if (f.status === "void") where.push(eq(settlement.status, "void"), sql`not ${wasReplaced}`);
  else if (f.status === "superseded") where.push(eq(settlement.status, "void"), wasReplaced);
  return and(...where)!;
}

// A business pays a repayment, so "Paid by" a member leaves it out; one is
// never replaced.
function repaymentConditions(householdId: string, f: ExpenseFilter): SQL | null {
  if (expenseOnly(f) || f.payer || f.status === "superseded") return null;
  const where = common(reimbursement, householdId, f);
  if (f.status === "live" || f.status === "posted") where.push(eq(reimbursement.status, "recorded"));
  else if (f.status === "void") where.push(eq(reimbursement.status, "void"));
  return and(...where)!;
}

const TABLE_NAME: Record<LedgerKind, string> = { expense: "expense", payment: "settlement", repayment: "reimbursement" };

// A cursor names the last row of a page, and which table holds it.
const encodeCursor = (kind: LedgerKind, id: string) => Buffer.from(`${kind}:${id}`).toString("base64url");
function decodeCursor(cursor: string): { kind: LedgerKind; id: string } {
  const [kind, id] = (/^[A-Za-z0-9_-]{1,100}$/.test(cursor) ? Buffer.from(cursor, "base64url").toString() : "").split(":");
  if (!KINDS.includes(kind as LedgerKind) || !id || !isUuid(id)) throw new UserError(BAD_CURSOR);
  return { kind: kind as LedgerKind, id };
}

export async function listLedger(
  db: Db,
  householdId: string,
  filter: LedgerFilter,
  page: ExpensePage = { limit: DEFAULT_LIMIT },
  names: FilterNames = FORM_NAMES,
): Promise<Ledger> {
  const arms: { kind: LedgerKind; table: typeof expense | Table; where: SQL }[] = [{ kind: "expense", table: expense, where: await expenseConditions(db, householdId, filter, names) }];
  const pay = paymentConditions(householdId, filter);
  if (pay) arms.push({ kind: "payment", table: settlement, where: pay });
  const repay = repaymentConditions(householdId, filter);
  if (repay) arms.push({ kind: "repayment", table: reimbursement, where: repay });

  const counts: Record<LedgerKind, number> = { expense: 0, payment: 0, repayment: 0 };
  for (const arm of arms) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(arm.table).where(arm.where);
    counts[arm.kind] = row!.n;
  }
  const [sums] = await db
    .select({ cents: sql<string>`coalesce(sum(${expense.totalCents}) filter (where ${expense.status} in ('posted', 'unassigned', 'needs_amount')), 0)` })
    .from(expense)
    .where(arms[0]!.where);

  let after: SQL | undefined;
  if (page.cursor) {
    const { kind, id } = decodeCursor(page.cursor);
    const t = { expense, payment: settlement, repayment: reimbursement }[kind];
    await exists(db.select({ id: t.id }).from(t).where(and(eq(t.householdId, householdId), eq(t.id, id))).limit(1), BAD_CURSOR);
    after = sql`(select c.date, c.created_at, c.id from ${sql.raw(TABLE_NAME[kind])} c where c.id = ${id})`;
  }

  // One more than asked shows whether another page follows.
  const union = sql.join(
    arms.map(
      ({ kind, table, where }) =>
        sql`select ${sql.raw(`'${kind}'`)}::text as kind, ${table.id} as id, ${table.date} as date, ${table.createdAt} as created_at from ${sql.raw(TABLE_NAME[kind])} where ${where}${after ? sql` and (${table.date}, ${table.createdAt}, ${table.id}) < ${after}` : sql``}`,
    ),
    sql` union all `,
  );
  const result = (await db.execute(sql`${union} order by date desc, created_at desc, id desc limit ${page.limit + 1}`)) as unknown as {
    rows: { kind: LedgerKind; id: string }[];
  };
  const more = result.rows.length > page.limit;
  const picked = result.rows.slice(0, page.limit);
  const ids = (kind: LedgerKind) => picked.filter((r) => r.kind === kind).map((r) => r.id);

  const [ex, pm, rp] = [ids("expense"), ids("payment"), ids("repayment")];
  const expenses = ex.length ? await withShares(db, await db.select().from(expense).where(and(eq(expense.householdId, householdId), inArray(expense.id, ex)))) : [];
  const payments = pm.length ? await db.select().from(settlement).where(and(eq(settlement.householdId, householdId), inArray(settlement.id, pm))) : [];
  const replacedIds = pm.length
    ? new Set(
        (await db.select({ id: settlement.supersedesId }).from(settlement).where(and(eq(settlement.householdId, householdId), inArray(settlement.supersedesId, pm)))).map((r) => r.id),
      )
    : new Set<string | null>();
  const repayments = rp.length
    ? await db.select().from(reimbursement).where(and(eq(reimbursement.householdId, householdId), inArray(reimbursement.id, rp)))
    : [];

  const byId = new Map<string, LedgerItem>([
    ...expenses.map((e) => [e.id, { kind: "expense", id: e.id, expense: e }] as const),
    ...payments.map((p) => [p.id, { kind: "payment", id: p.id, payment: p, replaced: replacedIds.has(p.id) }] as const),
    ...repayments.map((r) => [r.id, { kind: "repayment", id: r.id, repayment: r }] as const),
  ]);
  const items = picked.map((r) => byId.get(r.id)!);
  const last = picked[picked.length - 1];
  return {
    items,
    nextCursor: more && last ? encodeCursor(last.kind, last.id) : null,
    count: counts.expense + counts.payment + counts.repayment,
    counts,
    expenseTotalCents: Number(sums!.cents),
  };
}
