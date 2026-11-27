// One expense as a table row (wide screens) or a card (phones). The Ledger
// shows expenses this way, among its payments.
import Link from "next/link";
import { shortDate } from "@abacus/core/dates";
import type { Account, Category, Member } from "@/db/schema";
import type { ExpenseWithShares } from "@/lib/expenses";
import { explain, REASON_TEXT } from "@/lib/rule-text";
import { ActionForm } from "./action-form";
import { enterAmountAction, voidExpenseAction } from "./actions";
import { cn } from "@/lib/utils";
import { CategoryNote, Money } from "./ui";

// The tag, the "enter amount" form, the "not split" note, the maths and the
// actions for one expense. Shared by the table row and the phone card. Most
// expenses follow an agreed rule, so only the exceptions get a tag.
function Detail({ e, members, back }: { e: ExpenseWithShares; members: Member[]; back?: string }) {
  return (
    <>
      {e.status === "posted" && e.ruleSource === "entry" && <span className="tag">picked split</span>}
      {e.status === "posted" && e.ruleSource === "default" && members.length > 1 && (
        <span className="tag warn">even-split default</span>
      )}
      {e.status === "needs_amount" && (
        <ActionForm action={enterAmountAction} done="Amount saved" className="row">
          <input type="hidden" name="expenseId" value={e.id} />
          <label>
            Amount of this bill
            <input name="amount" inputMode="decimal" size={8} required />
          </label>
          <button>Enter amount</button>
        </ActionForm>
      )}
      {e.status === "unassigned" && (
        <p>
          <span className="tag warn">not split</span> Not in the balance:{" "}
          {REASON_TEXT[e.unassignedReason ?? ""] ?? "its segments could not be worked out"}.{" "}
          <Link href="/#to-do">Fix it</Link>
        </p>
      )}
      {e.status === "posted" && e.computation && (
        <details>
          <summary>Show the maths</summary>
          <ul>
            {explain(e.computation, e.shares, members).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="row">
            <Link href={editHref(e, back)}>Edit</Link>
            <ActionForm action={voidExpenseAction} done="Expense voided" className="inline" confirm={`Void "${e.description}"?`}>
              <input type="hidden" name="expenseId" value={e.id} />
              <button className="danger">Void</button>
            </ActionForm>
          </div>
        </details>
      )}
    </>
  );
}

// The list an expense is shown in, as a path: its page goes back there
// once the expense is saved.
export type ItemProps = { e: ExpenseWithShares; members: Member[]; categories: Category[]; accounts: Account[]; back?: string; today: string; isNew?: boolean };

const editHref = (e: ExpenseWithShares, back?: string) => `/expenses/${e.id}${back ? `?${new URLSearchParams({ from: back })}` : ""}`;

// A replaced or voided expense, shown only when asked for: struck through
// and tagged, so it is never read as one that counts.
const GONE_TAG: Partial<Record<ExpenseWithShares["status"], string>> = { superseded: "replaced", void: "voided" };

function GoneTag({ e }: { e: ExpenseWithShares }) {
  const tag = GONE_TAG[e.status];
  return tag ? <span className="tag">{tag}</span> : null;
}

// The name of the account an expense was paid from, if it says.
const accountName = (e: ExpenseWithShares, accounts: Account[]) => accounts.find((a) => a.id === e.accountId)?.name;

export function ExpenseRow({ e, members, categories, accounts, back, today, isNew }: ItemProps) {
  const payer = members.find((m) => m.id === e.payerId)?.displayName;
  const paidFrom = accountName(e, accounts);
  return (
    <tr className={GONE_TAG[e.status] ? "gone" : undefined}>
      <td className="whitespace-nowrap">{shortDate(e.date, today)}</td>
      <td className="[overflow-wrap:anywhere]">
        <Link href={editHref(e, back)}>{e.description}</Link> <CategoryNote category={e.category} categories={categories} />{" "}
        <GoneTag e={e} /> {isNew && <span className="tag ok">new</span>} <Detail e={e} members={members} back={back} />
      </td>
      <td className="num">
        <Money cents={e.totalCents} />
      </td>
      <td>
        {payer}
        {/* overflow-wrap: a long account name breaks inside the cell. */}
        {paidFrom && <div className="note [overflow-wrap:anywhere]">{paidFrom}</div>}
      </td>
      {members.map((m) => (
        <td className="num" key={m.id}>
          {e.status === "posted" ? <Money cents={e.shares[m.id]} /> : "—"}
        </td>
      ))}
    </tr>
  );
}

// On a phone the table's columns would scroll out of view, so each expense
// is a card with the shares underneath.
export function ExpenseCard({ e, members, categories, accounts, back, today, isNew }: ItemProps) {
  const payer = members.find((m) => m.id === e.payerId)?.displayName;
  const paidFrom = accountName(e, accounts);
  return (
    <li className={cn("rounded-xl border border-border/70 bg-card p-4 text-sm shadow-soft", GONE_TAG[e.status] && "opacity-70")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <Link href={editHref(e, back)} className={cn("font-medium", GONE_TAG[e.status] && "line-through")}>
            {e.description}
          </Link>{" "}
          <CategoryNote category={e.category} categories={categories} /> <GoneTag e={e} /> {isNew && <span className="tag ok">new</span>}
          {/* overflow-wrap: a long account name wraps instead of widening the card past a phone's screen. */}
          <div className="note [overflow-wrap:anywhere]">
            {shortDate(e.date, today)} · paid by {payer}
            {paidFrom && <> · {paidFrom}</>}
          </div>
        </div>
        <span className="num text-base font-semibold">
          <Money cents={e.totalCents} />
        </span>
      </div>
      <div className="mt-2 [&_details]:my-1 [&_details]:border-0 [&_details]:bg-transparent [&_details]:p-0 [&_summary]:text-xs [&_summary]:font-normal [&_summary]:text-muted-foreground">
        <Detail e={e} members={members} back={back} />
      </div>
      {e.status === "posted" && <Shares shares={e.shares} members={members} />}
    </li>
  );
}

export function Shares({ shares, members }: { shares: Record<string, number | null | undefined>; members: Member[] }) {
  return (
    <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t pt-3">
      {members.map((m) => (
        <div key={m.id}>
          <dt className="note">{m.displayName}&apos;s segment</dt>
          <dd className="font-semibold tabular-nums">
            <Money cents={shares[m.id]} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
