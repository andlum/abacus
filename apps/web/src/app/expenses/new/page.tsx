import { MONTHS } from "@abacus/core/dates";
import { requireHousehold } from "@/lib/session";
import { ActionForm } from "../../action-form";
import { addExpense } from "../../actions";
import { DetailFields } from "../../detail-fields";
import { OptionalRule } from "../../rule-fields";
import { AccountSelect, CategorySelect, PayerSelect, Shell } from "../../ui";
import { KindSwitch } from "./kind-switch";
import { SplitPreview } from "./split-preview";
import { countsOn } from "@/lib/members";

export const dynamic = "force-dynamic";

export default async function NewExpensePage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind } = await searchParams;
  const ctx = await requireHousehold();
  const { me, members, categories, accounts, today } = ctx;
  // Only people who are in the group today can pay or be given a share.
  const counted = members.filter((m) => countsOn(m, today));
  const people = counted.map((m) => ({ id: m.id, displayName: m.displayName }));
  return (
    <Shell {...ctx} title="Add an expense">
      <ActionForm action={addExpense} done="Added" className="panel">
        <div className="row">
          <label className="max-sm:basis-full">
            Description
            <input name="description" required />
          </label>
          <CategorySelect categories={categories} />
          <label>
            Amount
            <input name="amount" inputMode="decimal" size={8} />
          </label>
          <PayerSelect members={counted} value={me.id} />
          <AccountSelect accounts={accounts} />
        </div>
        <KindSwitch
          initial={kind === "recurring" ? "recurring" : "once"}
          once={
            <>
              <label>
                Date
                <input type="date" name="date" defaultValue={today} max={today} required />
              </label>
              {ctx.home.kind === "business" && <DetailFields />}
              {people.length > 1 && <OptionalRule summary="Split this one differently" members={people} prefix="rule_" byIncome={ctx.home.kind === "household"} />}
            </>
          }
          recurring={
            <>
              <p className="note">
                It is entered by itself on each due date. Leave the amount empty if it changes each time, and you will
                be asked for it when it is due. To include months already past, set an earlier start date.
              </p>
              <div className="row">
                <label>
                  Repeats
                  <select name="cadence" defaultValue="monthly">
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Every 3 months</option>
                    <option value="half_yearly">Every 6 months</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </label>
                <label>
                  Due day of the month
                  <input name="dayOfMonth" inputMode="numeric" size={3} defaultValue="1" required />
                </label>
                <label className="month-field">
                  A month it falls in
                  <select name="monthOfYear" defaultValue="1">
                    {MONTHS.map((m, i) => (
                      <option key={m} value={i + 1}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Starts
                  <input type="date" name="startDate" defaultValue={today} required />
                </label>
              </div>
              {people.length > 1 && (
                <OptionalRule summary="Choose a split for this cost" members={people} prefix="trule_" byIncome={ctx.home.kind === "household"}>
                  <p className="note">
                    Saved as this cost&apos;s rule from its start date, or from today if it started earlier. You can change
                    it in Settings, under How you split.
                  </p>
                </OptionalRule>
              )}
            </>
          }
        />
        <SplitPreview people={people} submit="Add expense" />
      </ActionForm>
    </Shell>
  );
}
