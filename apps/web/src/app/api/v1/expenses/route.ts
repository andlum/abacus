import type { Rule } from "@abacus/core/split";
import { cents, created, date, expenseDetail, expenseJson, jsonBody, memberId, route, str } from "@/lib/api";
import { listExpenses, parseExpenseFilter, parseExpensePage } from "@/lib/expense-list";
import { createExpense, postDue } from "@/lib/expenses";

export const dynamic = "force-dynamic";

// Every expense of the group, newest first, a page at a time, narrowed by
// the filters in the query string. `count` and `totalCents` cover every
// match, not only this page.
export const GET = route(async ({ db, home, today }, req) => {
  await postDue(db, home.id, today);
  const query = new URL(req.url).searchParams;
  const get = (key: string) => query.get(key);
  const list = await listExpenses(db, home.id, parseExpenseFilter(get), parseExpensePage(get));
  return {
    expenses: list.items.map(expenseJson),
    nextCursor: list.nextCursor,
    count: list.count,
    totalCents: list.totalCents,
  };
});

// A one-time expense. Split by the group's rules, or by `rule` for this one
// expense only.
export const POST = route(async ({ me, db, home, members, today }, req) => {
  const b = await jsonBody(req);
  const row = await createExpense(db, home.id, {
    kind: "manual",
    actor: me,
    date: date(b, "date", today),
    description: str(b, "description"),
    category: str(b, "category", true),
    totalCents: cents(b, "totalCents"),
    payerId: memberId(b, "payerId", members, me.id),
    // Checked by createExpense: one of this group's accounts, not archived.
    accountId: str(b, "accountId", true) ?? null,
    // Checked by createExpense against this household's members.
    rule: (b.rule ?? undefined) as Rule | undefined,
    // Vendor, note, and how much of it was for the business.
    ...expenseDetail(b),
    today,
  });
  return created(expenseJson(row));
});
