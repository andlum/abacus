import { notFound } from "next/navigation";
import { centsToDecimal } from "@abacus/core/money";
import { describeRule, SOURCE_TEXT } from "@/lib/rule-text";
import { ruleFor } from "@/lib/rules";
import { entityActivity } from "@/lib/entity-activity";
import { requireHousehold } from "@/lib/session";
import { addMonths, monthOf, shortDate } from "@abacus/core/dates";
import { describeSchedule, dueBeforeStart, listTemplates } from "@/lib/templates";
import { ActionForm } from "../../action-form";
import { ActivityPanel } from "../../activity-panel";
import { changeRecurring, endRecurring, enterEarlierRecurring } from "../../actions";
import { AccountSelect, CategoryOptions, Money, PayerSelect, Shell } from "../../ui";
import { countsOn } from "@/lib/members";

export const dynamic = "force-dynamic";

export default async function RecurringDetail({ params }: { params: Promise<{ lineageId: string }> }) {
  const { lineageId } = await params;
  const ctx = await requireHousehold();
  const { me, db, members, categories, accounts, today } = ctx;
  const listing = (await listTemplates(db, me.householdId, today)).find((l) => l.lineageId === lineageId);
  if (!listing) notFound();
  const t = listing.head;
  const found = await ruleFor(db, me.householdId, { templateLineageId: lineageId, category: t.category, date: today });
  const nameOf = new Map(members.map((m) => [m.id, m.displayName]));
  const activity = await entityActivity(db, me.householdId, me, { type: "expense_template", id: lineageId });
  // The latest month this can be entered for: before the cost started, on
  // its schedule, and not later than today. A yearly cost looks back a year.
  let lastEarlier = monthOf(t.startDate < today ? t.startDate : today);
  for (let i = 0; i < 12; i++) {
    const due = dueBeforeStart(listing.versions, lastEarlier);
    if (typeof due === "object" && due !== null && due.date <= today) break;
    lastEarlier = addMonths(lastEarlier, -1);
  }

  return (
    <Shell {...ctx} title={t.name}>
      <p>
        Due {describeSchedule(t)}.
        <br />
        Split today: {describeRule(found.rule, members)} <span className="note">({SOURCE_TEXT[found.source]})</span>
      </p>

      {listing.ended ? (
        <p>This cost ended on {t.endDate}.</p>
      ) : (
        <>
          <h2>Change it</h2>
          <p className="note">A change applies from the date you give, today at the earliest. Expenses already entered stay as they are.
            To change how often it repeats, end it and add it again.
          </p>
          <ActionForm action={changeRecurring} done="Change saved" className="panel">
            <input type="hidden" name="lineageId" value={lineageId} />
            <div className="row">
              <label>
                Name
                <input name="name" defaultValue={t.name} required />
              </label>
              <label>
                Category
                <select name="category" defaultValue={t.category}>
                  <CategoryOptions categories={categories} value={t.category} />
                </select>
              </label>
              <label>
                Amount (blank if it varies)
                <input
                  name="amount"
                  inputMode="decimal"
                  size={8}
                  defaultValue={t.amountCents === null ? "" : centsToDecimal(t.amountCents)}
                />
              </label>
              <label>
                Due day of the month
                <input name="dayOfMonth" inputMode="numeric" size={3} defaultValue={t.dayOfMonth} required />
              </label>
              <PayerSelect members={members.filter((m) => countsOn(m, today) || m.id === t.payerId)} value={t.payerId} />
              <AccountSelect accounts={accounts} value={t.accountId} />
              <label>
                From
                <input type="date" name="effectiveFrom" defaultValue={today} min={today} required />
              </label>
            </div>
            <button className="primary">Save change</button>
          </ActionForm>

          <h2>End it</h2>
          <ActionForm action={endRecurring} done="Recurring cost ended" className="panel row" confirm={`End "${t.name}"?`}>
            <input type="hidden" name="lineageId" value={lineageId} />
            <label>
              Last day it applies
              <input type="date" name="endDate" defaultValue={today} min={today} required />
            </label>
            <button className="danger">End this cost</button>
          </ActionForm>
        </>
      )}

      <h2>Enter an earlier month</h2>
      <p className="note">
        This cost enters itself from {t.startDate} on. For a month before that, pick it here: it is entered on that
        month&apos;s due day and split by the rules of that day.
        {t.amountCents === null ? " You are then asked for the amount." : ""}
      </p>
      <ActionForm action={enterEarlierRecurring} done="Entered" className="panel row">
        <input type="hidden" name="lineageId" value={lineageId} />
        <label>
          Month
          <input type="month" name="month" defaultValue={lastEarlier} max={lastEarlier} placeholder="YYYY-MM" required />
        </label>
        <button>Enter that month</button>
      </ActionForm>

      <h2>History</h2>
      <table>
        <thead>
          <tr>
            <th>From</th>
            <th>Name</th>
            <th className="num">Amount</th>
            <th>Due</th>
            <th>Paid by</th>
            <th>Ends</th>
          </tr>
        </thead>
        <tbody>
          {listing.versions.map((v) => (
            <tr key={v.id}>
              <td className="whitespace-nowrap">{shortDate(v.effectiveFrom, today)}</td>
              <td className="wrap">{v.name}</td>
              <td className="num">{v.amountCents === null ? "varies" : <Money cents={v.amountCents} />}</td>
              <td>{describeSchedule(v)}</td>
              <td>{nameOf.get(v.payerId)}</td>
              <td>{v.endDate ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ActivityPanel entries={activity} timezone={ctx.home.timezone} />
    </Shell>
  );
}
