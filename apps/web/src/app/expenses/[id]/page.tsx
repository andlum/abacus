import Link from "next/link";
import { shortDate } from "@abacus/core/dates";
import { notFound } from "next/navigation";
import { UserError } from "@abacus/core/errors";
import { entityActivity } from "@/lib/entity-activity";
import { tieFor } from "@/lib/bank-match";
import { expenseHistory } from "@/lib/expense-history";
import { centsToDecimal, formatCents } from "@abacus/core/money";
import { requireHousehold } from "@/lib/session";
import { ActionForm } from "../../action-form";
import { notThisPurchaseAction, saveExpense, voidExpenseAction } from "../../actions";
import { returnTo } from "@/lib/return-to";
import { OptionalRule } from "../../rule-fields";
import { AccountSelect, accountText, CategorySelect, Money, PayerSelect, Shell } from "../../ui";
import { ActivityPanel, dayIn } from "../../activity-panel";
import { SplitPreview } from "../new/split-preview";
import { countsOn } from "@/lib/members";

export const dynamic = "force-dynamic";

const STATUS_TEXT: Record<string, string> = {
  posted: "current",
  unassigned: "current, not split",
  needs_amount: "waiting for its amount",
  superseded: "replaced",
  void: "voided",
  proposed: "proposed by an agent, never confirmed",
  rejected: "proposed by an agent, turned down",
};

export default async function EditExpense({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { id } = await params;
  // The list this was opened from, to go back to once saved.
  const from = returnTo([(await searchParams).from].flat()[0]);
  const ctx = await requireHousehold();
  const { me, db, members, categories, accounts, today } = ctx;
  const history = await expenseHistory(db, me.householdId, id).catch((err) => {
    if (err instanceof UserError) notFound();
    throw err;
  });
  const e = history.find((v) => v.id === id)!;
  const activity = await entityActivity(db, me.householdId, me, { type: "expense", id });
  const live = e.status === "posted" || e.status === "unassigned";
  const nameOf = new Map(members.map((m) => [m.id, m.displayName]));
  const when = dayIn(ctx.home.timezone);
  // Who was in the group on the day of the cost: only they can have paid or share it.
  const counted = members.filter((m) => countsOn(m, e.date));
  const people = counted.map((m) => ({ id: m.id, displayName: m.displayName }));
  const enteredBy = (v: (typeof history)[number]) =>
    v.source === "template" && !v.createdBy
      ? "Clementine, on its due date"
      : v.source === "import"
        ? `${nameOf.get(v.createdBy ?? "") ?? "Someone"}, by import`
        : v.source === "agent"
          ? `${nameOf.get(v.createdBy ?? "") ?? "Someone"}'s agent`
          : (nameOf.get(v.createdBy ?? "") ?? "Someone");

  const historyTable = (
    <>
      <h2>History</h2>
      <table>
        <thead>
          <tr>
            <th>Entered</th>
            <th>By</th>
            <th>Date</th>
            <th>Description</th>
            <th className="num">Amount</th>
            <th>Segments</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {history.map((v) => (
            <tr key={v.id} className={v.id === id ? "font-medium" : undefined} aria-current={v.id === id ? "true" : undefined}>
              <td>{when.format(v.createdAt)}</td>
              <td>{enteredBy(v)}</td>
              <td className="whitespace-nowrap">{shortDate(v.date, today)}</td>
              <td className="wrap">{v.description}</td>
              <td className="num">{v.totalCents === null ? "—" : <Money cents={v.totalCents} />}</td>
              <td>
                {Object.keys(v.shares).length === 0
                  ? "—"
                  : members.map((m) => `${m.displayName} ${formatCents(v.shares[m.id] ?? 0)}`).join(" · ")}
              </td>
              <td>
                <span className={`tag ${v.status === "posted" ? "ok" : v.status === "unassigned" || v.status === "needs_amount" ? "warn" : ""}`}>
                  {STATUS_TEXT[v.status] ?? v.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ActivityPanel entries={activity} timezone={ctx.home.timezone} />
    </>
  );

  // Only the person who connected the bank sees what the bank called it.
  const tie = await tieFor(db, me, id);
  const tieLine = tie && (
    <div className="[overflow-wrap:anywhere]">
      <p>
        Matched to your bank purchase on {shortDate(tie.date, today)}, &ldquo;{tie.description}&rdquo;.
      </p>
      <ActionForm action={notThisPurchaseAction} done="Back in To sort" className="row">
        <input type="hidden" name="transactionId" value={tie.transactionId} />
        <button className="quiet">Not this purchase</button>
      </ActionForm>
    </div>
  );

  const paidFrom = accounts.find((a) => a.id === e.accountId);
  // overflow-wrap: a long account name breaks onto the next line rather than
  // widening the page past a phone's screen.
  const paidFromLine = paidFrom && (
    <p className="[overflow-wrap:anywhere]">
      Paid from {accountText(paidFrom)}
      {paidFrom.archivedAt ? " (archived)" : ""}.
    </p>
  );

  if (!live) {
    const current = history.find((v) => v.status === "posted" || v.status === "unassigned");
    return (
      <Shell {...ctx} title={e.description}>
        {e.status === "needs_amount" ? (
          <p>
            This bill is waiting for its amount. <Link href="/#to-do">Enter it in the to-do list on Home.</Link>
          </p>
        ) : e.status === "proposed" || e.status === "rejected" ? (
          <p>An agent proposed this expense, back when agents could propose them. It was never confirmed and never counted.</p>
        ) : (
          <p>
            This expense was {STATUS_TEXT[e.status] ?? e.status} and no longer counts.{" "}
            {current && <Link href={`/expenses/${current.id}`}>See the current version.</Link>}
          </p>
        )}
        {paidFromLine}
        {tieLine}
        {historyTable}
      </Shell>
    );
  }

  return (
    <Shell {...ctx} title={`Edit: ${e.description}`}>
      {paidFromLine}
      {tieLine}
      <p className="note">
        Saving keeps the old expense on record as replaced and enters a new one. The new one is split by the rules of
        its date, unless you pick a split below.
      </p>
      <ActionForm action={saveExpense} done="Expense saved" className="panel">
        <input type="hidden" name="expenseId" value={e.id} />
        {from && <input type="hidden" name="from" value={from} />}
        <div className="row">
          <label>
            Date
            <input type="date" name="date" defaultValue={e.date} max={today} required />
          </label>
          <label className="max-sm:basis-full">
            Description
            <input name="description" defaultValue={e.description} required />
          </label>
          <CategorySelect categories={categories} value={e.category} />
          <label>
            Amount
            <input name="amount" inputMode="decimal" size={8} defaultValue={centsToDecimal(e.totalCents!)} required />
          </label>
          <PayerSelect members={counted} value={e.payerId} />
          <AccountSelect accounts={accounts} value={e.accountId} />
        </div>
        <OptionalRule summary="Split this one differently" members={people} prefix="rule_" byIncome={ctx.home.kind === "household"} />
        <SplitPreview people={people} submit="Save" stored={e.shares} />
      </ActionForm>
      <ActionForm action={voidExpenseAction} done="Expense voided" confirm={`Void "${e.description}"?`}>
        <input type="hidden" name="expenseId" value={e.id} />
        <input type="hidden" name="then" value="list" />
        <p className="note">Voiding keeps it on record, struck through, and takes it out of the balance.</p>
        <button className="danger">Void this expense</button>
      </ActionForm>
      {historyTable}
    </Shell>
  );
}
