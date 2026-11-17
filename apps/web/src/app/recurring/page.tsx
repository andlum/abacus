import Link from "next/link";
import { shortDate } from "@abacus/core/dates";
import { requireHousehold } from "@/lib/session";
import { describeRule } from "@/lib/rule-text";
import { listRules } from "@/lib/rules";
import { describeSchedule, listTemplates } from "@/lib/templates";
import { CategoryNote, Money, Shell } from "../ui";

export const dynamic = "force-dynamic";

export default async function RecurringPage() {
  const ctx = await requireHousehold();
  const { me, db, members, categories, today } = ctx;
  const listings = await listTemplates(db, me.householdId, today);
  const nameOf = new Map(members.map((m) => [m.id, m.displayName]));
  // A cost's own rule. Newest first, so the first one found is the one that
  // applies last.
  const agreed = new Map<string, { text: string; from: string }>();
  for (const r of await listRules(db, me.householdId)) {
    if (r.scope === "template" && r.templateLineageId && !agreed.has(r.templateLineageId)) {
      agreed.set(r.templateLineageId, { text: describeRule(r.rule, members), from: r.effectiveFrom });
    }
  }

  return (
    <Shell {...ctx} title="Recurring costs">
      <p className="note">
        A cost with an amount is entered by itself on its due date. A cost whose amount varies asks for the amount on
        its due date.
      </p>
      {listings.length === 0 ? (
        <p>No recurring costs yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Cost</th>
              <th className="num">Amount</th>
              <th>Due</th>
              <th>Paid by</th>
              <th>Split</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {listings.map((l) => {
              const t = l.current ?? l.head;
              return (
                <tr key={l.lineageId} className={l.ended ? "gone" : undefined}>
                  <td>
                    <Link href={`/recurring/${l.lineageId}`}>{t.name}</Link>{" "}
                    <CategoryNote category={t.category} categories={categories} />
                  </td>
                  <td className="num">{t.amountCents === null ? "varies" : <Money cents={t.amountCents} />}</td>
                  <td>
                    {describeSchedule(t)}
                  </td>
                  <td>{nameOf.get(t.payerId)}</td>
                  <td>
                    {agreed.has(l.lineageId) ? (
                      <>
                        {agreed.get(l.lineageId)!.text}
                        {agreed.get(l.lineageId)!.from > today && (
                          <span className="note"> from {shortDate(agreed.get(l.lineageId)!.from, today)}</span>
                        )}
                      </>
                    ) : (
                      <span className="note">the group&apos;s rules</span>
                    )}
                  </td>
                  <td>
                    {l.ended && `ended ${shortDate(l.head.endDate!, today)}`}
                    {!l.ended && !l.current && `starts ${shortDate(l.head.startDate, today)}`}
                    {!l.ended && l.current && l.upcoming && `changes on ${shortDate(l.upcoming.effectiveFrom, today)}`}
                    {!l.ended && l.head.endDate && ` ends ${shortDate(l.head.endDate, today)}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p>
        <Link href="/expenses/new?kind=recurring" className="button primary">
          Add a recurring cost
        </Link>
      </p>
    </Shell>
  );
}
