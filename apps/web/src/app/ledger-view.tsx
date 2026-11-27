import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { EXPENSE_SOURCES } from "@/db/schema";
import { KIND_LABELS } from "@/lib/accounts";
import { MAX_SEARCH, NO_ACCOUNT, STATUS_CHOICES } from "@/lib/expense-list";
import { listMonth } from "@/lib/expenses";
import { listLedger, parseLedgerForm, type Ledger } from "@/lib/ledger";
import type { requireHousehold } from "@/lib/session";
import { addDays, addMonths } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { Shares } from "./expense-items";
import { LedgerCard, LedgerRow } from "./ledger-items";
import { accountText, LinkButton, Money, shortName } from "./ui";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

const SOURCE_TEXT: Record<string, string> = { template: "Recurring", manual: "By hand", import: "Import", agent: "By an agent", bank: "From a bank" };
// The filters the form sends, in the address. `min` and `max` are typed as
// amounts ("12.50") and become cents for the list.
export const KEYS = ["month", "q", "from", "to", "category", "payer", "account", "accountKind", "source", "status", "min", "max"] as const;
// `added` is not a filter: the ids a card review just added, marked as new.
export type LedgerParams = Partial<Record<(typeof KEYS)[number] | "cursor" | "added", string | string[]>>;

// With no filter given, the list shows this many days, today included.
const DEFAULT_DAYS = 30;

// "2027-05" as "May 2027", or "May 27" for the short form.
function monthName(month: string, form: "long" | "short") {
  return new Intl.DateTimeFormat("en-US", { month: form, year: form === "long" ? "numeric" : "2-digit", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

// Every movement of money in the group, newest first, a page at a time:
// expenses, payments between members and, in a business, repayments. The
// filters live in the address, so a reload or the back button keeps them.
// With none given, it shows the last 30 days.
export async function LedgerView({ ctx, raw }: { ctx: Ctx; raw: LedgerParams }) {
  const { me, db, home, members, categories, accounts, today } = ctx;
  const given = (key: keyof LedgerParams) => String([raw[key]].flat()[0] ?? "").trim();

  const marked = new Set(given("added").split(",").filter(Boolean));
  const on = KEYS.filter((k) => given(k)).length;
  const filtered = on > 0;
  const since = filtered ? null : addDays(today, -(DEFAULT_DAYS - 1));

  // A filter that cannot be read is said, with nothing listed: showing every
  // expense under a filter that was ignored would mislead.
  let list: Ledger = { items: [], nextCursor: null, count: 0, counts: { expense: 0, payment: 0, repayment: 0 }, expenseTotalCents: 0 };
  let problem: string | null = null;
  let month: string | undefined;
  try {
    const { filter, page } = parseLedgerForm((key) => given(key as keyof LedgerParams));
    month = filter.month;
    list = await listLedger(db, me.householdId, since ? { ...filter, from: since } : filter, page);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    problem = e.message;
  }
  // The split expenses of the month, in total and per person, whatever the
  // other filters are.
  const posted = month ? (await listMonth(db, me.householdId, month)).filter((e) => e.status === "posted") : [];
  const sum = (pick: (e: (typeof posted)[number]) => number) => posted.reduce((a, e) => a + pick(e), 0);
  const monthLink = (m: string) => `/?${new URLSearchParams({ month: m })}`;

  const pageLink = (cursor?: string) => {
    const query = new URLSearchParams(KEYS.flatMap((k) => (given(k) ? [[k, given(k)]] : [])));
    if (cursor) query.set("cursor", cursor);
    const text = query.toString();
    return text ? `/?${text}` : "/";
  };
  const offered = accounts.filter((a) => !a.archivedAt || a.id === given("account"));
  // Where an expense's page sends someone back to once it is saved: here.
  const back = pageLink(given("cursor") || undefined);
  // Everything before the default window, for when the last 30 days are not enough.
  const earlier = since && `/?${new URLSearchParams({ to: addDays(since, -1) })}`;

  return (
    <section aria-labelledby="ledger" className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="ledger" className="my-0">
          {month ? `Ledger: ${monthName(month, "long")}` : "Ledger"}
        </h2>
        {!month && (
          <LinkButton href={monthLink(today.slice(0, 7))} variant="outline" size="sm">
            This month
          </LinkButton>
        )}
      </div>

      {/* Folded until opened; open while a filter is on or refused. */}
      <details className="filters" open={filtered || !!problem}>
        <summary>
          Filters{on > 0 && <span className="note"> · {on} on</span>}
        </summary>
        <form method="get" action="/" aria-label="Filters">
          <div className="row">
            <label>
              Month
              <input type="month" name="month" defaultValue={given("month")} placeholder="2026-03" />
            </label>
            <label className="max-sm:basis-full">
              Search
              <input type="search" name="q" defaultValue={given("q")} placeholder="Description or note" maxLength={MAX_SEARCH} />
            </label>
            <label>
              From
              <input type="date" name="from" defaultValue={given("from")} />
            </label>
            <label>
              To
              <input type="date" name="to" defaultValue={given("to")} />
            </label>
            <label>
              Category
              <select name="category" defaultValue={given("category")}>
                <option value="">Any</option>
                {categories.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.label}
                    {c.removedAt ? " (removed)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {members.length > 1 && (
              <label>
                Paid by
                <select name="payer" defaultValue={given("payer")}>
                  <option value="">Anyone</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {accounts.length > 0 && (
              // min-w-0: a long account name shortens in the box rather than
              // widening the form past a phone's screen.
              <label className="min-w-0">
                Paid from
                <select name="account" defaultValue={given("account")}>
                  <option value="">Any</option>
                  {offered.map((a) => (
                    <option key={a.id} value={a.id}>
                      {accountText({ ...a, name: shortName(a.name) })}
                      {a.archivedAt ? " (archived)" : ""}
                    </option>
                  ))}
                  <option value={NO_ACCOUNT}>Not recorded</option>
                </select>
              </label>
            )}
            {home.kind === "business" && accounts.length > 0 && (
              <label>
                Whose money
                <select name="accountKind" defaultValue={given("accountKind")}>
                  <option value="">Either</option>
                  {Object.entries(KIND_LABELS).map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Entered
              <select name="source" defaultValue={given("source")}>
                <option value="">Any way</option>
                {EXPENSE_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_TEXT[s]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Show
              <select name="status" defaultValue={given("status")}>
                {STATUS_CHOICES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              At least
              <input name="min" inputMode="decimal" size={7} defaultValue={given("min")} />
            </label>
            <label>
              At most
              <input name="max" inputMode="decimal" size={7} defaultValue={given("max")} />
            </label>
          </div>
          <div className="row">
            <button>Apply filters</button>
            {filtered && <Link href="/">Clear</Link>}
          </div>
        </form>
      </details>

      {month && !problem && (
        <section aria-label="Month summary" className="panel">
          <div className="flex items-start justify-between gap-3 font-semibold">
            <span>Total of split expenses in {monthName(month, "long")}</span>
            <span className="num text-base">
              <Money cents={sum((e) => e.totalCents ?? 0)} />
            </span>
          </div>
          <Shares shares={Object.fromEntries(members.map((m) => [m.id, sum((e) => e.shares[m.id] ?? 0)]))} members={members} />
          <p className="row mt-3">
            <LinkButton href={monthLink(addMonths(month, -1))} variant="outline" size="sm">
              <ChevronLeft data-icon="inline-start" />
              {monthName(addMonths(month, -1), "short")}
            </LinkButton>
            <LinkButton href={monthLink(addMonths(month, 1))} variant="outline" size="sm">
              {monthName(addMonths(month, 1), "short")}
              <ChevronRight data-icon="inline-end" />
            </LinkButton>
            <Link href="/">Last 30 days</Link>
          </p>
        </section>
      )}

      {problem ? (
        <p role="alert">
          <span className="tag warn">filter not applied</span> {problem}.
        </p>
      ) : list.count === 0 ? (
        <p>{filtered ? "Nothing matches these filters." : "Nothing in the last 30 days."}</p>
      ) : list.items.length === 0 ? (
        // The rows after this page's cursor have been voided or replaced since.
        <p>Nothing older.</p>
      ) : (
        <>
          <p className="note" aria-live="polite">
            {since && "Last 30 days: "}
            {plural(list.counts.expense, "expense", "expenses")} · <Money cents={list.expenseTotalCents} />
            {list.counts.payment > 0 && <> · {plural(list.counts.payment, "payment", "payments")}</>}
            {list.counts.repayment > 0 && <> · {plural(list.counts.repayment, "repayment", "repayments")}</>}
          </p>
          <ul data-slot="list" className="my-3 space-y-3 sm:hidden">
            {list.items.map((item) => (
              <LedgerCard key={item.id} item={item} members={members} categories={categories} accounts={accounts} back={back} today={today} marked={marked} />
            ))}
          </ul>
          <table className="max-sm:hidden">
            <thead>
              <tr>
                <th>Date</th>
                <th>What</th>
                <th className="num">Total</th>
                <th>Paid by</th>
                {members.map((m) => (
                  <th className="num" key={m.id}>
                    {m.displayName}&apos;s segment
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.items.map((item) => (
                <LedgerRow key={item.id} item={item} members={members} categories={categories} accounts={accounts} back={back} today={today} marked={marked} />
              ))}
            </tbody>
          </table>
        </>
      )}

      {(given("cursor") || list.nextCursor || (earlier && !list.nextCursor)) && (
        <p className="row">
          {given("cursor") && <Link href={pageLink()}>Newest</Link>}
          {list.nextCursor && <Link href={pageLink(list.nextCursor)}>Older</Link>}
          {earlier && !list.nextCursor && <Link href={earlier}>Before the last 30 days</Link>}
        </p>
      )}
    </section>
  );
}
