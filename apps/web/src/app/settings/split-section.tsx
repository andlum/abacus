import { DEFAULT_CATEGORY, type SplitRule } from "@/db/schema";
import { shortDate } from "@abacus/core/dates";
import { countsOn } from "@/lib/members";
import { entityActivity } from "@/lib/entity-activity";
import { describeRule } from "@/lib/rule-text";
import { listRuleHistory, type ListedRule, type RuleState } from "@/lib/rules";
import type { requireHousehold } from "@/lib/session";
import { listTemplates } from "@/lib/templates";
import { ActionForm } from "../action-form";
import { ActivityPanel } from "../activity-panel";
import { addRuleAction, editRuleAction, removeRuleAction } from "../actions";
import { RuleFields } from "../rule-fields";
import { CategoryOptions, categoryLabel, FinePrint } from "../ui";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

const STATE: Record<RuleState, string> = {
  current: "current",
  upcoming: "upcoming",
  earlier: "earlier",
  replaced: "replaced",
  removed: "removed",
};

// The rules that divide costs: those in force today or starting later, with
// the ways to change them, a form to add one, and the rules they replaced or
// that were removed. A rule counts as soon as it is saved, from its date;
// an expense already split keeps its shares.
//
// `cover` points the new rule at a category or recurring cost, for links
// from elsewhere: "category:groceries" or "template:<lineage id>".
export async function SplitSection({ me, db, home, members, categories, today, cover = "" }: Ctx & { cover?: string }) {
  const solo = members.length === 1;
  const rules = await listRuleHistory(db, me.householdId, today);
  const templates = await listTemplates(db, me.householdId, today);
  const costName = new Map(templates.map((l) => [l.lineageId, l.head.name]));
  const costCategory = new Map(templates.map((l) => [l.lineageId, l.head.category]));
  const costs = templates.filter((l) => !l.ended);
  const people = members.filter((m) => countsOn(m, today)).map((m) => ({ id: m.id, displayName: m.displayName }));
  const [coverKind, coverId = ""] = cover.split(":");

  const target = (r: SplitRule) =>
    r.scope === "household"
      ? "Everything else"
      : r.scope === "category"
        ? `Category: ${categoryLabel(categories, r.category!)}`
        : `Recurring cost "${costName.get(r.templateLineageId ?? "") ?? "removed"}"`;

  // In force today, then the ones starting later, soonest first.
  const live = [
    ...rules.filter((r) => r.state === "current"),
    ...rules.filter((r) => r.state === "upcoming").sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)),
  ];
  const past = rules.filter((r) => r.state !== "current" && r.state !== "upcoming");
  // Each rule's history: its adding, changes and removals.
  const history = new Map(await Promise.all(live.map(async (r) => [r.id, await entityActivity(db, me.householdId, me, { type: "split_rule", id: r.id })] as const)));

  // What removing a row does, in words. An upcoming row goes alone. A row in
  // force goes with every earlier one for its target, so the next rule in
  // line splits it, until any upcoming row for it starts.
  const inForce = (scope: SplitRule["scope"], category?: string | null) =>
    rules.find((r) => r.state === "current" && r.scope === scope && (scope !== "category" || r.category === category));
  const subject = (r: SplitRule) =>
    r.scope === "household"
      ? "Costs without a more specific rule"
      : r.scope === "category"
        ? categoryLabel(categories, r.category!)
        : (costName.get(r.templateLineageId ?? "") ?? "This recurring cost");
  const fallback = (r: SplitRule) => {
    const category = r.scope === "template" ? costCategory.get(r.templateLineageId ?? "") : null;
    if (category && inForce("category", category)) return `by the rule for ${categoryLabel(categories, category)}`;
    if (r.scope !== "household" && inForce("household")) return "by the group rule";
    return "evenly";
  };
  const removeText = (r: ListedRule) => {
    if (r.state === "upcoming") return `Remove this rule? It will not start on ${shortDate(r.effectiveFrom, today)}. The rule in force today stays.`;
    const next = live.find((u) => u.state === "upcoming" && sameTarget(u, r));
    return `Remove this rule? ${subject(r)} will be split ${fallback(r)} from today${next ? ` until ${next.effectiveFrom}, when the upcoming rule starts` : ""}. Expenses already split keep their shares.`;
  };

  return (
    <section aria-labelledby="split" className="mb-10">
      <h2 id="split">How you share costs</h2>
      <p className="note">
        {solo
          ? "This group is just you, so every cost is wholly yours and no rule is needed."
          : "The most specific rule wins: one for a recurring cost, then one for its category, then the rule for everything else."}
      </p>
      <FinePrint>
        {solo
          ? "A rule you add applies as soon as you save it."
          : "Where there is none, the cost is split evenly. Anyone in the group can add, change or remove a rule; it counts as soon as it is saved, for expenses from its date. Expenses already split keep their shares."}
      </FinePrint>

      <h3>In force today</h3>
      {live.length === 0 ? (
        <p>{solo ? "No rules. Every cost is wholly yours." : "No rules yet. Everything is split evenly by default."}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Covers</th>
              <th>Split</th>
              <th>From</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {live.map((r) => (
              <tr key={r.id}>
                <td>
                  {target(r)}
                  {r.state === "upcoming" && <span className="tag ml-2">upcoming</span>}
                  <ActivityPanel entries={history.get(r.id) ?? []} timezone={home.timezone} title="History" />
                </td>
                <td>{describeRule(r.rule, members)}</td>
                <td className="whitespace-nowrap">{shortDate(r.effectiveFrom, today)}</td>
                <td>
                  <details>
                    <summary>Edit</summary>
                    <EditForm rule={r} people={people} byIncome={home.kind === "household"} />
                  </details>
                  <ActionForm
                    action={removeRuleAction}
                    done="Rule removed"
                    className="inline"
                    confirm={removeText(r)}
                  >
                    <input type="hidden" name="ruleId" value={r.id} />
                    <button className="danger">Remove</button>
                  </ActionForm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Add a rule</h3>
      <ActionForm action={addRuleAction} done="Rule saved" className="row">
        <label>
          Covers
          <select
            name="target"
            defaultValue={coverKind === "template" && costs.some((c) => c.lineageId === coverId) ? cover : coverKind === "category" ? "category" : "household"}
          >
            <option value="household">Everything without a more specific rule</option>
            <option value="category">A category</option>
            {costs.map((c) => (
              <option key={c.lineageId} value={`template:${c.lineageId}`}>
                Recurring cost: {c.head.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Which category
          <select name="category" defaultValue={coverKind === "category" && categories.some((c) => c.slug === coverId) ? coverId : DEFAULT_CATEGORY}>
            <CategoryOptions categories={categories} value={coverId} />
          </select>
        </label>
        <RuleFields members={people} prefix="rule_" byIncome={home.kind === "household"} />
        <label>
          Counts from
          <input type="date" name="effectiveFrom" defaultValue={today} required />
        </label>
        <button>Save rule</button>
        <p className="note basis-full">
          If what it covers already has a rule, this changes it: a later date changes it from then on, and that date or
          an earlier one replaces it.
        </p>
      </ActionForm>

      {past.length > 0 && (
        <>
          <h3>Earlier rules</h3>
          <table>
            <thead>
              <tr>
                <th>Covers</th>
                <th>Split</th>
                <th>From</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {past.map((r) => (
                <tr key={r.id} className="gone">
                  <td>{target(r)}</td>
                  <td>{describeRule(r.rule, members)}</td>
                  <td className="whitespace-nowrap">{shortDate(r.effectiveFrom, today)}</td>
                  <td>
                    <span className="tag">{STATE[r.state]}</span>
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

const sameTarget = (a: SplitRule, b: SplitRule) =>
  a.scope === b.scope && a.category === b.category && a.templateLineageId === b.templateLineageId;

// Changes one rule. It starts from the rule as it is, and its date.
function EditForm({ rule, people, byIncome }: { rule: ListedRule; people: { id: string; displayName: string }[]; byIncome: boolean }) {
  return (
    <ActionForm action={editRuleAction} done="Rule saved" className="row">
      <input type="hidden" name="ruleId" value={rule.id} />
      <RuleFields members={people} prefix="rule_" initial={rule.rule} byIncome={byIncome} />
      <label>
        Counts from
        <input type="date" name="effectiveFrom" defaultValue={rule.effectiveFrom} required />
      </label>
      <button>Save change</button>
      <p className="note basis-full">
        A date after {rule.effectiveFrom} changes it from then on. That date or an earlier one replaces it, and any rule
        for the same thing dated after it, from the date you set.
      </p>
    </ActionForm>
  );
}
