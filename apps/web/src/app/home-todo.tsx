import Link from "next/link";
import { shortDate } from "@abacus/core/dates";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Attention } from "@/lib/attention";
import { countsOn } from "@/lib/members";
import { REASON_TEXT } from "@/lib/rule-text";
import type { requireHousehold } from "@/lib/session";
import { ActionForm } from "./action-form";
import { enterAmountAction, fixUnassignedAction, voidExpenseAction } from "./actions";
import { SplitPreview } from "./expenses/new/split-preview";
import { OptionalRule } from "./rule-fields";
import { CategoryNote, Money } from "./ui";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

// Opens the rule form in Settings (People) already pointed at this.
function ruleFor(cover: string) {
  return `/settings/people?${new URLSearchParams({ cover })}#split`;
}

// Everything that needs someone to act, each with the form that settles it.
export function ToDo({ ctx, attention }: { ctx: Ctx; attention: Attention }) {
  const { members, categories, today } = ctx;
  const { needsAmount, unassigned } = attention;
  // A group of one has no split to choose, so nothing is "on the default".
  const onDefault = members.length > 1 ? attention.onDefault : [];

  return (
    <Card id="to-do" aria-label="To do" role="region" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          To do {attention.count > 0 && <Badge>{attention.count}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {attention.count === 0 && <p className="note my-0">Nothing to do.</p>}

        {needsAmount.length > 0 && (
          <section aria-label="Bills waiting for an amount">
            <h3 className="mt-0">Bills waiting for an amount</h3>
            <ul className="list-none divide-y divide-border/70 pl-0 space-y-0">
              {needsAmount.map((e) => (
                <li key={e.id} className="py-3">
                  <strong>{e.description}</strong>, due {shortDate(e.date, today)}
                  <ActionForm action={enterAmountAction} done="Amount saved" className="row">
                    <input type="hidden" name="expenseId" value={e.id} />
                    <label>
                      Amount of this bill
                      <input name="amount" inputMode="decimal" size={8} required />
                    </label>
                    <button>Enter amount</button>
                  </ActionForm>
                </li>
              ))}
            </ul>
          </section>
        )}

        {unassigned.length > 0 && (
          <section aria-label="Expenses that could not be split">
            <h3 className={needsAmount.length > 0 ? undefined : "mt-0"}>Expenses that could not be split</h3>
            <p className="note">
              These are not in the balance. Splitting one now uses the rules and incomes in force today, or a split you pick.
            </p>
            <ul className="list-none divide-y divide-border/70 pl-0 space-y-0">
              {unassigned.map((e) => {
                const people = members.filter((m) => countsOn(m, e.date)).map((m) => ({ id: m.id, displayName: m.displayName }));
                return (
                  <li key={e.id} className="py-3 [overflow-wrap:anywhere]">
                    {shortDate(e.date, today)} · <strong>{e.description}</strong> · <Money cents={e.totalCents} />:{" "}
                    {REASON_TEXT[e.unassignedReason ?? ""] ?? "its segments could not be worked out"}.
                    <ActionForm action={fixUnassignedAction} done="Split saved">
                      <input type="hidden" name="expenseId" value={e.id} />
                      {/* Read by the preview: the split is worked out as of today. */}
                      <input type="hidden" name="amount" value={(e.totalCents! / 100).toFixed(2)} />
                      <input type="hidden" name="date" value={today} />
                      <input type="hidden" name="payerId" value={e.payerId} />
                      <input type="hidden" name="category" value={e.category} />
                      <OptionalRule summary="Pick a split for this one" members={people} prefix="rule_" byIncome={ctx.home.kind === "household"} />
                      <SplitPreview people={people} submit="Split it now" />
                    </ActionForm>
                    <Link href={ruleFor(e.templateLineageId ? `template:${e.templateLineageId}` : `category:${e.category}`)}>
                      Add a lasting rule
                    </Link>{" "}
                    <span className="note">so the next one splits by itself.</span>{" "}
                    <ActionForm action={voidExpenseAction} done="Expense voided" className="inline" confirm={`Void "${e.description}"?`}>
                      <input type="hidden" name="expenseId" value={e.id} />
                      <button className="danger">Void</button>
                    </ActionForm>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {onDefault.length > 0 && (
          // For information: nothing is wrong, so it stays folded away.
          <details>
            <summary>
              {onDefault.length} recurring {onDefault.length === 1 ? "cost splits" : "costs split"} evenly because no rule
              covers {onDefault.length === 1 ? "it" : "them"}
            </summary>
            <p className="note">
              If that is not what you meant, <Link href="/settings/people#split">add a rule</Link>.
            </p>
            <ul>
              {onDefault.map((t) => (
                <li key={t.lineageId}>
                  {t.name} <CategoryNote category={t.category} categories={categories} /> ·{" "}
                  <Link href={ruleFor(`template:${t.lineageId}`)}>Set a split for {t.name}</Link>
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
