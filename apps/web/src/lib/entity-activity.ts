// The history of one thing: an expense, a payment, an income, a split rule
// or a recurring cost. An edit of any of these keeps the old row and adds a
// new one that points back at it, and each audit entry names the row that
// was current then, so the history is every entry for every row in the
// chain. What an edit changed is read from the two rows it joined, never
// from the audit entry, which holds ids only.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  account,
  auditLog,
  category,
  expense,
  expenseTemplate,
  income,
  settlement,
  splitRule,
  type AuditEntry,
  type Expense,
  type ExpenseTemplate,
  type Income,
  type Member,
  type Settlement,
  type SplitRule,
} from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { formatCents } from "@abacus/core/money";
import { accountLabel } from "./accounts.ts";
import { describe } from "./activity.ts";
import { isUuid } from "./ids.ts";
import { incomeAmountVisible } from "./incomes.ts";
import { householdMembers } from "./members.ts";
import { describeRule } from "./rule-text.ts";
import { describeSchedule } from "./templates.ts";

// Which thing. For a recurring cost, `id` is its lineage id (the one in
// its page's address); for the rest, the id of any of its rows.
export type EntityRef = { type: "expense" | "settlement" | "income" | "split_rule" | "expense_template"; id: string };

export type EntityEntry = {
  id: number;
  at: Date;
  // A member's name, or "Clementine" for what the app did itself.
  who: string;
  // "Alex edited this payment".
  text: string;
  // What the edit changed: "Amount $50.00 → $40.00". Empty for anything
  // that is not an edit.
  changes: string[];
};

// Tables whose rows point back at the row they replaced.
const CHAINED = { expense: "expense", settlement: "settlement", income: "income", split_rule: "split_rule" } as const;

// Every row joined to `id` by `supersedes_id`, either way, in one group.
// Walked as a graph rather than a line: a rule or income whose upcoming
// change was removed can be changed again from the same row, so two rows
// may point back at one.
async function chainIds(db: Db, table: keyof typeof CHAINED, householdId: string, id: string): Promise<string[]> {
  const t = sql.raw(CHAINED[table]);
  const result = (await db.execute(sql`
    with recursive chain(id, supersedes_id) as (
      select id, supersedes_id from ${t} where id = ${id} and household_id = ${householdId}
      union
      select r.id, r.supersedes_id from ${t} r join chain c on r.supersedes_id = c.id or r.id = c.supersedes_id
      where r.household_id = ${householdId}
    )
    select id from chain`)) as unknown as { rows: { id: string }[] };
  return result.rows.map((r) => r.id);
}

type Rows = Map<string, Expense | Settlement | Income | SplitRule | ExpenseTemplate>;

async function loadRows(db: Db, householdId: string, ref: EntityRef): Promise<Rows> {
  const byId = (rows: { id: string }[]) => new Map(rows.map((r) => [r.id, r])) as Rows;
  if (ref.type === "expense_template") {
    return byId(
      await db
        .select()
        .from(expenseTemplate)
        .where(and(eq(expenseTemplate.householdId, householdId), eq(expenseTemplate.lineageId, ref.id))),
    );
  }
  const ids = await chainIds(db, ref.type, householdId, ref.id);
  if (ids.length === 0) return new Map();
  const table = { expense, settlement, income, split_rule: splitRule }[ref.type];
  return byId(await db.select().from(table).where(and(eq(table.householdId, householdId), inArray(table.id, ids))));
}

// The actions that make a new row from an old one: their entries get the
// changes between the two.
const EDITS = new Set(["expense.posted", "expense.unassigned", "settlement.edited", "income.changed", "split_rule.changed", "expense_template.changed"]);

// The whole history of one thing, oldest first. `viewer` decides what an
// income's history shows, by the rule `listIncomes` uses: amounts only to
// the owner, or to everyone while the owner shares the amount.
export async function entityActivity(db: Db, householdId: string, viewer: Member, ref: EntityRef): Promise<EntityEntry[]> {
  if (!isUuid(ref.id)) return [];
  const rows = await loadRows(db, householdId, ref);
  if (rows.size === 0) return [];
  const entries = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.householdId, householdId), eq(auditLog.entityType, ref.type), inArray(auditLog.entityId, [...rows.keys()])))
    .orderBy(asc(auditLog.id));

  const members = await householdMembers(db, householdId);
  const names = new Map(members.map((m) => [m.id, m.displayName]));
  const name = (id: string | null) => (id ? (names.get(id) ?? "someone") : "");
  const labels = new Map(
    (await db.select({ slug: category.slug, label: category.label }).from(category).where(eq(category.householdId, householdId))).map((c) => [
      c.slug,
      c.label,
    ]),
  );
  const accounts = new Map(
    (await db.select().from(account).where(eq(account.householdId, householdId))).map((a) => [a.id, accountLabel(a)]),
  );
  const paidFrom = (id: string | null) => (id ? (accounts.get(id) ?? "an account") : "(none)");
  const split = (rule: Parameters<typeof describeRule>[0]) => describeRule(rule, members).replace(/^split /, "");
  const money = (cents: number | null, none = "—") => (cents === null ? none : formatCents(cents));

  // One line per field that differs: "Label before → after".
  const diff = (pairs: [string, string, string][]) => pairs.filter(([, a, b]) => a !== b).map(([label, a, b]) => `${label} ${a} → ${b}`);

  const changes = (e: AuditEntry): string[] => {
    const row = e.entityId ? rows.get(e.entityId) : undefined;
    const old = row?.supersedesId ? rows.get(row.supersedesId) : undefined;
    if (!row || !old || !EDITS.has(e.action)) return [];
    switch (ref.type) {
      case "expense": {
        const [a, b] = [old as Expense, row as Expense];
        const out = diff([
          ["Date", a.date, b.date],
          ["Description", a.description, b.description],
          ["Amount", money(a.totalCents), money(b.totalCents)],
          ["Paid by", name(a.payerId), name(b.payerId)],
          ["Category", labels.get(a.category) ?? a.category, labels.get(b.category) ?? b.category],
          ["Paid from", paidFrom(a.accountId), paidFrom(b.accountId)],
        ]);
        if (a.computation && b.computation) out.push(...diff([["Split", split(a.computation.rule), split(b.computation.rule)]]));
        return out;
      }
      case "settlement": {
        const [a, b] = [old as Settlement, row as Settlement];
        return diff([
          ["Amount", money(a.amountCents), money(b.amountCents)],
          ["Date", a.date, b.date],
          ["Paid by", name(a.fromMemberId), name(b.fromMemberId)],
          ["Paid to", name(a.toMemberId), name(b.toMemberId)],
          ["Note", a.note || "(none)", b.note || "(none)"],
        ]);
      }
      case "income": {
        const [a, b] = [old as Income, row as Income];
        const shown = incomeAmountVisible(a, viewer) && incomeAmountVisible(b, viewer);
        return diff([
          ...(shown ? [["Per year", money(a.annualCents), money(b.annualCents)] as [string, string, string]] : []),
          ["Counts from", a.effectiveFrom ?? "—", b.effectiveFrom ?? "—"],
        ]);
      }
      case "split_rule": {
        const [a, b] = [old as SplitRule, row as SplitRule];
        return diff([
          ["Split", split(a.rule), split(b.rule)],
          ["Counts from", a.effectiveFrom, b.effectiveFrom],
        ]);
      }
      case "expense_template": {
        const [a, b] = [old as ExpenseTemplate, row as ExpenseTemplate];
        return diff([
          ["Name", a.name, b.name],
          ["Amount", money(a.amountCents, "varies"), money(b.amountCents, "varies")],
          ["Due", describeSchedule(a), describeSchedule(b)],
          ["Paid by", name(a.payerId), name(b.payerId)],
          ["Category", labels.get(a.category) ?? a.category, labels.get(b.category) ?? b.category],
          ["Paid from", paidFrom(a.accountId), paidFrom(b.accountId)],
          ["Ends", a.endDate ?? "(no end)", b.endDate ?? "(no end)"],
        ]);
      }
    }
  };

  return entries.map((e) => {
    const plain = describe(e, { names, expenses: new Map(), templates: new Map(), settlements: new Map() });
    const row = e.entityId ? rows.get(e.entityId) : undefined;
    const what = phrase(e, row && "effectiveFrom" in row ? row.effectiveFrom : null, names);
    return {
      id: e.id,
      at: e.at,
      who: plain.who,
      text: what ? `${plain.who} ${what}` : `${plain.who} ${plain.text.charAt(0).toLowerCase()}${plain.text.slice(1)}`,
      changes: changes(e),
    };
  });
}

// What was done, said of "this" thing. Null for an action with no words of
// its own here, which then borrows Home's.
function phrase(e: AuditEntry, from: string | null, names: Map<string, string>): string | null {
  const edited = typeof e.detail.supersedesId === "string";
  switch (e.action) {
    case "expense.posted":
    case "expense.unassigned": {
      const verb = e.detail.source === "template" ? "posted" : edited ? "edited" : "added";
      return `${verb} this expense${e.action === "expense.unassigned" ? ", but it could not be split" : ""}`;
    }
    case "expense.amount_entered":
      return "entered the amount";
    case "expense.fixed":
      return "split this expense, which could not be split before";
    case "expense.needs_amount":
      return "posted this bill, to wait for its amount";
    case "expense.voided":
      return "removed this expense";
    case "settlement.recorded":
      return "recorded this payment";
    case "settlement.edited":
      return "edited this payment";
    case "settlement.voided":
      return "undid this payment";
    case "income.recorded": {
      const owner = typeof e.detail.ownerId === "string" && e.detail.ownerId !== e.actorMemberId ? names.get(e.detail.ownerId) : undefined;
      return owner ? `added this income for ${owner}` : "added this income";
    }
    case "income.changed":
      return "changed this income";
    case "income.removed":
      return "removed this income";
    case "income.withdrawn":
      return "withdrew this income";
    case "income.share_mode_changed":
      return e.detail.to === "amount" ? "showed the amount of this income" : "hid the amount of this income";
    case "split_rule.added":
      return "added this rule";
    case "split_rule.changed":
      return "changed this rule";
    case "split_rule.removed":
      return "removed this rule";
    case "expense_template.created":
      return "set up this recurring cost";
    case "expense_template.changed":
      return from ? `changed this recurring cost, from ${from}` : "changed this recurring cost";
    default:
      return null;
  }
}
