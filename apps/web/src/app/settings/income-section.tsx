import { currentRatio, listIncomes, mayWriteIncome, type IncomeState, type VisibleIncome } from "@/lib/incomes";
import { shortDate } from "@abacus/core/dates";
import { centsToDecimal, formatBp } from "@abacus/core/money";
import type { requireHousehold } from "@/lib/session";
import { entityActivity, type EntityEntry } from "@/lib/entity-activity";
import { ActionForm } from "../action-form";
import { ActivityPanel } from "../activity-panel";
import { removeIncomeAction, saveIncome, setShareModeAction } from "../actions";
import { Money, FinePrint } from "../ui";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;
type Person = Ctx["members"][number];

const STATE: Record<IncomeState, string> = {
  current: "current",
  upcoming: "upcoming",
  earlier: "earlier",
  replaced: "replaced",
  removed: "removed",
};

// Today's income ratio, each person's income with the ways to change it,
// and the incomes it replaced or that were removed. An income counts as soon
// as it is saved; an expense already split keeps its shares.
export async function IncomeSection({ me, db, home, members, today }: Ctx) {
  // Rows that never took effect (withdrawn or turned down) are not part of
  // anyone's income history.
  const every = await listIncomes(db, me, today);
  const incomes = every.filter((i) => i.state !== null);
  const ratio = await currentRatio(db, me.householdId, today);
  const nameOf = new Map(members.map((m) => [m.id, m.displayName]));
  const current = new Map(incomes.filter((i) => i.state === "current").map((i) => [i.ownerId, i]));
  // Dated after today, shown under the one in force, soonest first.
  const upcoming = incomes
    .filter((i) => i.state === "upcoming")
    .sort((a, b) => a.effectiveFrom!.localeCompare(b.effectiveFrom!));
  const past = incomes.filter((i) => i.state !== "current" && i.state !== "upcoming");
  // Each person's income history, from the row in force, else the next one
  // to start, else the latest one replaced or removed.
  const history = new Map<string, EntityEntry[]>();
  for (const m of members) {
    const anchor = current.get(m.id) ?? upcoming.find((u) => u.ownerId === m.id) ?? past.find((p) => p.ownerId === m.id);
    if (anchor) history.set(m.id, await entityActivity(db, me.householdId, me, { type: "income", id: anchor.id }));
  }
  // A group of one: nobody else sees an income, and it changes no split.
  const solo = members.length === 1;
  // Any income of mine still hidden from the others, from before hiding went
  // away, including ones since replaced. Showing one shows them all. Only I
  // am told about it.
  const myHidden = solo ? undefined : every.find((i) => i.ownerId === me.id && i.shareMode === "ratio_only");
  const others = members
    .filter((m) => m.id !== me.id)
    .map((m) => m.displayName)
    .join(" and ");

  return (
    <section aria-labelledby="income" className="mb-10">
      <h2 id="income">Income</h2>
      <h3>Ratio today</h3>
      {solo ? null : ratio.ok ? (
        <p className="text-lg font-medium">{members.map((m) => `${m.displayName} ${formatBp(ratio.bp[m.id] ?? 0)}`).join(" · ")}</p>
      ) : (
        <p>
          {ratio.reason === "income_missing"
            ? "Not available: someone has no income recorded for today. Splits by income cannot be worked out until then."
            : "Not available: every income is zero."}
        </p>
      )}
      {solo ? (
        <p className="note">This group is just you, so the ratio is all yours and an income changes no split.</p>
      ) : (
        <>
          <p className="note">An income counts from its date as soon as you save it.</p>
          <FinePrint>
            Expenses already split keep their shares; only expenses split after the change use it. Everyone in the group
            sees the ratio. The ratio and your own income are enough to work out every other income. You can enter an
            income for someone who has not joined yet; once they join, only they can change it.
          </FinePrint>
        </>
      )}
      {myHidden && (
        <p className="note">
          You hid an income amount from {others}. Amounts can no longer be hidden: an income you record from now on is
          visible, and the ones you hid stay hidden until you press Show the amount.
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th>Whose</th>
            <th className="num">Per year</th>
            <th>From</th>
            {!solo && <th>Others see</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const i = current.get(m.id);
            const later = upcoming.filter((u) => u.ownerId === m.id);
            const mine = m.id === me.id;
            return (
              <tr key={m.id}>
                <td>
                  {m.displayName}
                  {i && i.createdBy !== i.ownerId && <span className="note"> (entered by {nameOf.get(i.createdBy)})</span>}
                  {history.has(m.id) && <ActivityPanel entries={history.get(m.id)!} timezone={home.timezone} title="History" />}
                </td>
                <td className="num">
                  {!i ? <span className="note">none recorded</span> : i.annualCents === null ? "hidden" : <Money cents={i.annualCents} />}
                  {later.map((u) => (
                    <div key={u.id} className="note whitespace-nowrap">
                      {u.annualCents === null ? "hidden" : <Money cents={u.annualCents} />} from {u.effectiveFrom && shortDate(u.effectiveFrom, today)}
                    </div>
                  ))}
                </td>
                <td className="whitespace-nowrap">{i?.effectiveFrom ? shortDate(i.effectiveFrom, today) : ""}</td>
                {!solo && (
                  <td>
                    {i && (i.shareMode === "amount" ? "the amount" : "only the ratio")}
                    {mine && myHidden && (
                      <ActionForm action={setShareModeAction} done="Amount shown" className="inline">
                        <input type="hidden" name="incomeId" value={myHidden.id} />
                        <input type="hidden" name="shareMode" value="amount" />{" "}
                        <button className="quiet">Show the amount</button>
                      </ActionForm>
                    )}
                  </td>
                )}
                <td>
                  {mayWriteIncome(me, m) && (
                    <>
                      <details>
                        <summary>{i ? "Edit" : "Add"}</summary>
                        <IncomeForm owner={m} mine={mine} current={i} today={today} />
                      </details>
                      {(i || later.length > 0) && (
                        <ActionForm
                          action={removeIncomeAction}
                          done="Income removed"
                          className="inline"
                          confirm={`Remove ${mine ? "your" : `${m.displayName}'s`} income? Splits by income will have none for ${mine ? "you" : "them"} until one is added again. Expenses already split keep their shares.`}
                        >
                          <input type="hidden" name="ownerId" value={m.id} />
                          <button className="danger">Remove</button>
                        </ActionForm>
                      )}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {past.length > 0 && (
        <>
          <h3>Earlier incomes</h3>
          <table>
            <thead>
              <tr>
                <th>Whose</th>
                <th className="num">Per year</th>
                <th>From</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {past.map((i) => (
                <tr key={i.id} className="gone">
                  <td>
                    {nameOf.get(i.ownerId)}
                    {i.createdBy !== i.ownerId && <span className="note"> (entered by {nameOf.get(i.createdBy)})</span>}
                  </td>
                  <td className="num">{i.annualCents === null ? "hidden" : <Money cents={i.annualCents} />}</td>
                  <td className="whitespace-nowrap">{i.effectiveFrom ? shortDate(i.effectiveFrom, today) : ""}</td>
                  <td>
                    <span className="tag">{STATE[i.state!]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

// Adds or changes one person's income. Everyone in the group sees the amount.
function IncomeForm({
  owner,
  mine,
  current,
  today,
}: {
  owner: Person;
  mine: boolean;
  current: VisibleIncome | undefined;
  today: string;
}) {
  const whose = mine ? "Your" : `${owner.displayName}'s`;
  return (
    <ActionForm action={saveIncome} done="Income saved" className="row">
      <input type="hidden" name="ownerId" value={owner.id} />
      <label>
        {whose} income per year
        <input
          name="amount"
          inputMode="decimal"
          size={12}
          required
          defaultValue={current?.annualCents != null ? centsToDecimal(current.annualCents) : ""}
        />
      </label>
      <label>
        Counts from
        <input type="date" name="effectiveFrom" defaultValue={current && current.effectiveFrom! > today ? current.effectiveFrom! : today} required />
      </label>
      <button>{current ? "Save change" : "Save income"}</button>
      {mine && current?.shareMode === "ratio_only" && (
        <p className="note basis-full">This amount is hidden from the others. Saving a change here shows them the amount you save.</p>
      )}
      {current && (
        <p className="note basis-full">
          A date after {current.effectiveFrom} changes it from then on. That date or an earlier one replaces it, and
          any income dated after it, from the date you set.
        </p>
      )}
    </ActionForm>
  );
}
