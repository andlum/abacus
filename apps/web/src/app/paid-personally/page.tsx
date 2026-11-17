import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { shortDate } from "@abacus/core/dates";
import { centsToDecimal } from "@abacus/core/money";
import { accountLabel } from "@/lib/accounts";
import { countsOn } from "@/lib/members";
import { getOwedBack, listReimbursements, type OwedBackEntry } from "@/lib/owed-back";
import { requireHousehold } from "@/lib/session";
import { cn } from "@/lib/utils";
import { ActionForm } from "../action-form";
import { repay, voidReimbursementAction } from "../actions";
import { Money, Shell } from "../ui";

export const metadata = { title: "Paid personally · Clementine" };
export const dynamic = "force-dynamic";

// What a business owes the people who paid its costs with their own cards,
// a form to record a repayment, and the repayments so far. Business groups
// only: a household has nothing to owe back.
export default async function PaidPersonallyPage() {
  const ctx = await requireHousehold();
  const { me, db, members, accounts, today } = ctx;
  const owedBack = await getOwedBack(db, me.householdId);
  if (!owedBack) notFound();
  const repayments = await listReimbursements(db, me.householdId);

  const nameOf = new Map(members.map((m) => [m.id, m.displayName]));
  const counted = members.filter((m) => countsOn(m, today));
  const active = owedBack.members.filter((m) => m.personalPaidCents > 0 || m.repaidCents > 0);
  const businessAccounts = accounts.filter((a) => a.kind === "business" && !a.archivedAt);
  const accountName = new Map(accounts.map((a) => [a.id, accountLabel(a)]));
  const repaid = counted.find((m) => m.id === me.id) ?? counted[0];
  const owedToRepaid = owedBack.members.find((m) => m.memberId === repaid?.id)?.owedCents ?? 0;
  const says = (m: OwedBackEntry) => {
    const name = nameOf.get(m.memberId) ?? "Someone";
    if (m.owedCents > 0) return <>The business owes {name} <Money cents={m.owedCents} /></>;
    if (m.owedCents < 0) return <>{name} owes the business <Money cents={-m.owedCents} /></>;
    return <>{name} and the business are square</>;
  };

  return (
    <Shell {...ctx} title="Paid personally">
      <section aria-label="Owed back">
        {active.length === 0 ? (
          <p>Nothing paid from a personal account yet.</p>
        ) : (
          active.map((m) => (
            <div key={m.memberId}>
              <p className="font-serif text-2xl">{says(m)}</p>
              {m.owedCents < 0 && <p className="note">Void or correct a repayment below if this is a mistake.</p>}
              <p className="note">
                Paid on personal accounts <Money cents={m.personalPaidCents} />, repaid <Money cents={m.repaidCents} />.{" "}
                {/* The list's total counts the same expenses: those with an amount. */}
                <Link href={`/?accountKind=personal&payer=${m.memberId}`}>See the expenses</Link>
              </p>
            </div>
          ))
        )}
        {owedBack.untaggedCount > 0 && (
          // In dollars, which the linked list totals the same way; its count
          // also takes in bills still waiting for an amount.
          <p className="note">
            <Link href="/?account=none">Costs with no account</Link>, <Money cents={owedBack.untaggedCents} /> in all,
            are not counted.
          </p>
        )}
      </section>

      {repaid && (
        <ActionForm action={repay} done="Repayment recorded" className="panel mt-6">
          <h2 className="mt-0">Record a repayment</h2>
          <div className="row">
            {counted.length === 1 ? (
              <input type="hidden" name="memberId" value={repaid.id} />
            ) : (
              <label>
                Repaid
                <select name="memberId" defaultValue={repaid.id}>
                  {counted.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Amount
              <input
                name="amount"
                inputMode="decimal"
                size={8}
                defaultValue={owedToRepaid > 0 ? centsToDecimal(owedToRepaid) : ""}
                required
              />
            </label>
            <label>
              Date
              <input type="date" name="date" defaultValue={today} max={today} required />
            </label>
            {businessAccounts.length > 0 && (
              <label>
                Paid from
                <select name="accountId" defaultValue="">
                  <option value="">Not recorded</option>
                  {businessAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {accountLabel(a)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="max-sm:basis-full">
              Note
              <input name="note" maxLength={200} />
            </label>
          </div>
          <button>Record repayment</button>
        </ActionForm>
      )}

      <h2>Repayments</h2>
      {repayments.length === 0 ? (
        <p className="note">No repayments recorded.</p>
      ) : (
        <Repayments
          today={today}
          rows={repayments.map((r) => ({
            id: r.id,
            date: r.date,
            amountCents: r.amountCents,
            void: r.status === "void",
            what: (
              <>
                The business repaid {nameOf.get(r.memberId)}
                {r.accountId && ` from ${accountName.get(r.accountId) ?? "an account"}`} {r.note && `(${r.note})`}
              </>
            ),
            undo: (
              <ActionForm action={voidReimbursementAction} done="Repayment voided" className="inline" confirm="Void this repayment?">
                <input type="hidden" name="reimbursementId" value={r.id} />
                <button className="danger">Void</button>
              </ActionForm>
            ),
          }))}
        />
      )}
    </Shell>
  );
}

type Row = { id: string; date: string; amountCents: number; void: boolean; what: ReactNode; undo: ReactNode };

// Oldest first: cards on a phone, so Void is in reach without scrolling
// sideways; a table from `sm` up.
function Repayments({ rows, today }: { rows: Row[]; today: string }) {
  return (
    <>
      <ul className="my-3 list-none space-y-3 pl-0 sm:hidden">
        {rows.map((r) => (
          <li key={r.id} className={cn("rounded-xl border border-border/70 bg-card p-4 text-sm", r.void && "opacity-70")}>
            <div className="flex items-start justify-between gap-3">
              <div className={cn("min-w-0 [overflow-wrap:anywhere]", r.void && "line-through")}>{r.what}</div>
              <span className={cn("num font-semibold", r.void && "line-through")}>
                <Money cents={r.amountCents} />
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="note">{shortDate(r.date, today)}</span>
              {r.void ? <span className="note">voided</span> : r.undo}
            </div>
          </li>
        ))}
      </ul>
      <table className="max-sm:hidden">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.void ? "gone" : undefined}>
              <td className="whitespace-nowrap">{shortDate(r.date, today)}</td>
              <td className="wrap">{r.what}</td>
              <td className="num">
                <Money cents={r.amountCents} />
              </td>
              <td>{r.void ? "voided" : r.undo}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
