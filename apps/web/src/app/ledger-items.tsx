// One row of the Ledger as a table row (wide screens) or a card (phones):
// an expense as the expense list shows it, or a payment or repayment said in
// plain words.
import Link from "next/link";
import { shortDate } from "@abacus/core/dates";
import type { Account, Category, Member } from "@/db/schema";
import type { LedgerItem } from "@/lib/ledger";
import { cn } from "@/lib/utils";
import { ExpenseCard, ExpenseRow } from "./expense-items";
import { accountText, Money } from "./ui";

type Props = { item: LedgerItem; members: Member[]; categories: Category[]; accounts: Account[]; back?: string; today: string };

type Movement = { date: string; amountCents: number; note: string; status: string };

// What a payment or repayment says, who paid it, its link and its tag.
function said(item: Exclude<LedgerItem, { kind: "expense" }>, members: Member[], accounts: Account[]) {
  const name = (id: string) => members.find((m) => m.id === id)?.displayName ?? "Someone";
  if (item.kind === "payment") {
    const p = item.payment;
    return {
      row: p as Movement,
      what: `${name(p.fromMemberId)} paid ${name(p.toMemberId)}`,
      payer: name(p.fromMemberId),
      from: null,
      href: `/payments/${p.id}`,
      tag: p.status === "void" ? (item.replaced ? "replaced" : "voided") : null,
    };
  }
  const r = item.repayment;
  const acct = accounts.find((a) => a.id === r.accountId);
  return {
    row: r as Movement,
    what: `The business repaid ${name(r.memberId)}`,
    payer: "The business",
    from: acct ? accountText(acct) : null,
    href: null,
    tag: r.status === "void" ? "voided" : null,
  };
}

export function LedgerRow({ item, members, categories, accounts, back, today }: Props) {
  if (item.kind === "expense") return <ExpenseRow e={item.expense} members={members} categories={categories} accounts={accounts} back={back} today={today} />;
  const s = said(item, members, accounts);
  return (
    <tr className={s.tag ? "gone" : undefined}>
      <td className="whitespace-nowrap">{shortDate(s.row.date, today)}</td>
      <td className="[overflow-wrap:anywhere]">
        {s.href ? <Link href={s.href}>{s.what}</Link> : s.what}
        {s.row.note && <span className="note"> · {s.row.note}</span>} {s.tag && <span className="tag">{s.tag}</span>}
      </td>
      <td className="num">
        <Money cents={s.row.amountCents} />
      </td>
      <td>
        {s.payer}
        {s.from && <div className="note [overflow-wrap:anywhere]">{s.from}</div>}
      </td>
      {members.map((m) => (
        <td className="num" key={m.id}>
          —
        </td>
      ))}
    </tr>
  );
}

export function LedgerCard({ item, members, categories, accounts, back, today }: Props) {
  if (item.kind === "expense") return <ExpenseCard e={item.expense} members={members} categories={categories} accounts={accounts} back={back} today={today} />;
  const s = said(item, members, accounts);
  return (
    <li className={cn("rounded-xl border border-border/70 bg-card p-4 text-sm shadow-soft", s.tag && "opacity-70")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 [overflow-wrap:anywhere]">
          {s.href ? (
            <Link href={s.href} className={cn("font-medium", s.tag && "line-through")}>
              {s.what}
            </Link>
          ) : (
            <span className={cn("font-medium", s.tag && "line-through")}>{s.what}</span>
          )}{" "}
          {s.tag && <span className="tag">{s.tag}</span>}
          <div className="note [overflow-wrap:anywhere]">
            {shortDate(s.row.date, today)}
            {s.row.note && <> · {s.row.note}</>}
            {s.from && <> · {s.from}</>}
          </div>
        </div>
        <span className="num text-base font-semibold">
          <Money cents={s.row.amountCents} />
        </span>
      </div>
    </li>
  );
}
