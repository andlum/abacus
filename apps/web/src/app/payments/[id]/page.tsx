import Link from "next/link";
import { shortDate } from "@abacus/core/dates";
import { notFound } from "next/navigation";
import type { Settlement } from "@/db/schema";
import { getSettlement } from "@/lib/balance";
import { entityActivity } from "@/lib/entity-activity";
import { countsOn } from "@/lib/members";
import { requireHousehold } from "@/lib/session";
import { centsToDecimal, formatCents } from "@abacus/core/money";
import { ActionForm } from "../../action-form";
import { ActivityPanel } from "../../activity-panel";
import { editSettlementAction, voidSettlementAction } from "../../actions";
import { Shell } from "../../ui";

export const dynamic = "force-dynamic";

// One payment between members: edit it, void it, and see the one it replaced.
export default async function Payment({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireHousehold();
  const { me, db, members, today } = ctx;
  const shown = await getSettlement(db, me.householdId, id);
  if (!shown) notFound();
  const { row, replaced, replacedBy } = shown;
  // A short page: the history is open from the start.
  const activity = <ActivityPanel entries={await entityActivity(db, me.householdId, me, { type: "settlement", id })} timezone={ctx.home.timezone} open />;
  const nameOf = new Map(members.map((m) => [m.id, m.displayName]));
  const said = (s: Settlement) => `${nameOf.get(s.fromMemberId) ?? "Someone"} paid ${nameOf.get(s.toMemberId) ?? "someone"} ${formatCents(s.amountCents)}`;
  // Only people in the group today can be part of a payment, and the two in it.
  const counted = members.filter((m) => countsOn(m, today) || m.id === row.fromMemberId || m.id === row.toMemberId);

  const history = replaced && (
    <p className="note">
      This payment replaced an earlier one: <Link href={`/payments/${replaced.id}`}>{said(replaced)}</Link> on {shortDate(replaced.date, today)}
      {replaced.note && ` (${replaced.note})`}.
    </p>
  );

  if (row.status !== "recorded") {
    return (
      <Shell {...ctx} title="Payment">
        <p className="headline font-serif text-2xl">
          {said(row)} on {shortDate(row.date, today)}
        </p>
        {row.note && <p>{row.note}</p>}
        <p>
          {replacedBy ? (
            <>
              This payment was replaced by an edit and no longer counts. <Link href={`/payments/${replacedBy.id}`}>See the current version.</Link>
            </>
          ) : (
            "This payment was voided and no longer counts."
          )}
        </p>
        {history}
        {activity}
        <p>
          <Link href="/">Back to Home</Link>
        </p>
      </Shell>
    );
  }

  return (
    <Shell {...ctx} title="Payment">
      <p className="headline font-serif text-2xl">
        {said(row)} on {shortDate(row.date, today)}
      </p>
      {history}
      <p className="note">Saving keeps the old payment on record as replaced and enters a new one.</p>
      <ActionForm action={editSettlementAction} done="Payment saved" className="panel">
        <input type="hidden" name="settlementId" value={row.id} />
        <div className="row">
          <label>
            From
            <select name="fromMemberId" defaultValue={row.fromMemberId}>
              {counted.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            To
            <select name="toMemberId" defaultValue={row.toMemberId}>
              {counted.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Amount
            <input name="amount" inputMode="decimal" size={8} defaultValue={centsToDecimal(row.amountCents)} required />
          </label>
          <label>
            Date
            <input type="date" name="date" defaultValue={row.date} max={today} required />
          </label>
          <label className="max-sm:basis-full">
            Note
            <input name="note" defaultValue={row.note} />
          </label>
        </div>
        <div className="row">
          <button className="primary">Save</button>
        </div>
      </ActionForm>
      <ActionForm action={voidSettlementAction} done="Payment voided" confirm="Void this payment?">
        <input type="hidden" name="settlementId" value={row.id} />
        <p className="note">Voiding keeps it on record and takes it out of the balance.</p>
        <button className="danger">Void this payment</button>
      </ActionForm>
      {activity}
      <p>
        <Link href="/">Back to Home</Link>
      </p>
    </Shell>
  );
}
