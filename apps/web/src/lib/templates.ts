import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { CADENCES, expenseTemplate, type Cadence, type ExpenseTemplate, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";
import { toAccountId } from "./accounts.ts";
import { toCategory } from "./categories.ts";
import { isIsoDate, isoDate, lastDayOfMonth, MONTHS, parseMonth } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { requireHouseholdMember } from "./members.ts";

export type TemplateInput = {
  name: string;
  category?: string;
  // Null for a cost whose amount varies, such as utilities.
  amountCents: number | null;
  cadence: Cadence;
  dayOfMonth: number;
  monthOfYear?: number | null;
  payerId: string;
  // The account it is paid from, copied to each expense it posts. Blank for
  // none.
  accountId?: string | null;
  startDate: string;
  endDate?: string | null;
};

export type TemplateChanges = Partial<
  Pick<TemplateInput, "name" | "category" | "amountCents" | "dayOfMonth" | "monthOfYear" | "payerId" | "accountId" | "endDate">
>;

export type Due = { template: ExpenseTemplate; date: string; period: string };

function validate(v: TemplateInput) {
  if (!v.name.trim()) throw new UserError("a recurring cost needs a name");
  if (v.amountCents !== null && !(Number.isSafeInteger(v.amountCents) && v.amountCents > 0)) {
    throw new UserError("the amount must be more than zero, or left empty for a cost that varies");
  }
  if (!Number.isInteger(v.dayOfMonth) || v.dayOfMonth < 1 || v.dayOfMonth > 31) {
    throw new UserError("the due day must be between 1 and 31");
  }
  if (!CADENCES.includes(v.cadence)) throw new UserError("a recurring cost repeats monthly, every 3 or 6 months, or yearly");
  if (v.cadence !== "monthly") {
    if (!Number.isInteger(v.monthOfYear) || v.monthOfYear! < 1 || v.monthOfYear! > 12) {
      throw new UserError("a cost that is not monthly needs the month it falls in");
    }
  }
  if (!isIsoDate(v.startDate)) throw new UserError("the start date is not a date");
  if (v.endDate != null && !isIsoDate(v.endDate)) throw new UserError("the end date is not a date");
  if (v.endDate != null && v.endDate < v.startDate) throw new UserError("the end date is before the start date");
}

export async function createTemplate(db: Db, actor: Member, input: TemplateInput): Promise<ExpenseTemplate> {
  validate(input);
  await requireHouseholdMember(db, actor.householdId, input.payerId, "the payer", input.startDate);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(expenseTemplate)
      .values({
        householdId: actor.householdId,
        lineageId: randomUUID(),
        name: input.name.trim(),
        category: await toCategory(tx, actor.householdId, input.category),
        amountCents: input.amountCents,
        cadence: input.cadence,
        dayOfMonth: input.dayOfMonth,
        monthOfYear: input.cadence === "monthly" ? null : input.monthOfYear!,
        payerId: input.payerId,
        accountId: await toAccountId(tx, actor.householdId, input.accountId),
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        effectiveFrom: input.startDate,
        createdBy: actor.id,
      })
      .returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "expense_template.created",
      entity: { type: "expense_template", id: row!.id },
      detail: { lineageId: row!.lineageId },
    });
    return row!;
  });
}

// Newest first: the head, then each version it replaced.
function chain(versions: ExpenseTemplate[]): ExpenseTemplate[] {
  const byId = new Map(versions.map((v) => [v.id, v]));
  const out: ExpenseTemplate[] = [];
  let at = versions.find((v) => v.status === "active");
  while (at) {
    out.push(at);
    at = at.supersedesId ? byId.get(at.supersedesId) : undefined;
  }
  return out;
}

// A later edit overrides earlier ones from its effective date onward.
function versionOn(newestFirst: ExpenseTemplate[], date: string): ExpenseTemplate | undefined {
  return newestFirst.find((v) => v.effectiveFrom <= date);
}

// Months between one due date and the next.
export const CADENCE_MONTHS: Record<Cadence, number> = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

// When a cost falls due, in words: "day 10 of February, May, August and November".
export function describeSchedule(t: Pick<ExpenseTemplate, "cadence" | "dayOfMonth" | "monthOfYear">): string {
  if (t.cadence === "monthly") return `day ${t.dayOfMonth} of each month`;
  if (t.cadence === "yearly") return `${MONTHS[t.monthOfYear! - 1]} ${t.dayOfMonth}, each year`;
  const step = CADENCE_MONTHS[t.cadence];
  const months = Array.from({ length: 12 / step }, (_, i) => ((t.monthOfYear! - 1 + i * step) % 12))
    .sort((a, b) => a - b)
    .map((m) => MONTHS[m]!);
  return `day ${t.dayOfMonth} of ${months.slice(0, -1).join(", ")} and ${months.at(-1)}`;
}

function dueDate(v: ExpenseTemplate, year: number, month: number): string | null {
  const step = CADENCE_MONTHS[v.cadence];
  if (step > 1 && (((month - v.monthOfYear!) % step) + step) % step !== 0) return null;
  return isoDate(year, month, Math.min(v.dayOfMonth, lastDayOfMonth(year, month)));
}

// Whether one recurring cost falls due in a calendar month, and as which
// version. Pure: takes every version of the cost.
export function dueInMonth(versions: ExpenseTemplate[], month: string): Due | null {
  const p = parseMonth(month);
  const newestFirst = chain(versions);
  let v = versionOn(newestFirst, isoDate(p.year, p.month, lastDayOfMonth(p.year, p.month)));
  if (!v) return null;
  let date = dueDate(v, p.year, p.month);
  if (date !== null && v.effectiveFrom > date) {
    // The change lands after this month's due day; the earlier version applies.
    v = versionOn(newestFirst, date);
    if (!v) return null;
    date = dueDate(v, p.year, p.month);
  }
  if (date === null || date < v.startDate || (v.endDate !== null && date > v.endDate)) return null;
  return { template: v, date, period: v.cadence === "yearly" ? month.slice(0, 4) : month };
}

// The due date a cost would have had in a month before it started, on the
// schedule it started with. Says why when there is none: it does not fall
// due that month, or the month is not before its start. Null when the cost
// does not exist.
export function dueBeforeStart(versions: ExpenseTemplate[], month: string): Due | "not_due" | "after_start" | null {
  const first = chain(versions).at(-1);
  if (!first) return null;
  const p = parseMonth(month);
  const date = dueDate(first, p.year, p.month);
  if (date === null) return "not_due";
  if (date >= first.startDate) return "after_start";
  return { template: first, date, period: first.cadence === "yearly" ? month.slice(0, 4) : month };
}

function byLineage(rows: ExpenseTemplate[]): ExpenseTemplate[][] {
  const groups = new Map<string, ExpenseTemplate[]>();
  for (const row of rows) groups.set(row.lineageId, [...(groups.get(row.lineageId) ?? []), row]);
  return [...groups.values()];
}

async function allVersions(db: Db, householdId: string): Promise<ExpenseTemplate[][]> {
  const rows = await db.select().from(expenseTemplate).where(eq(expenseTemplate.householdId, householdId));
  return byLineage(rows);
}

// The recurring costs that fall due in a calendar month (`YYYY-MM`).
export async function templatesDue(db: Db, householdId: string, month: string): Promise<Due[]> {
  const out: Due[] = [];
  for (const versions of await allVersions(db, householdId)) {
    const due = dueInMonth(versions, month);
    if (due) out.push(due);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.template.name.localeCompare(b.template.name));
}

export type TemplateListing = {
  lineageId: string;
  // As it stands today; null when it has not started applying yet.
  current: ExpenseTemplate | null;
  // The latest version, when it takes effect after today.
  upcoming: ExpenseTemplate | null;
  head: ExpenseTemplate;
  ended: boolean;
  versions: ExpenseTemplate[];
};

export async function listTemplates(db: Db, householdId: string, today: string): Promise<TemplateListing[]> {
  const out: TemplateListing[] = [];
  for (const versions of await allVersions(db, householdId)) {
    const newestFirst = chain(versions);
    const head = newestFirst[0];
    if (!head) continue;
    const current = versionOn(newestFirst, today) ?? null;
    out.push({
      lineageId: head.lineageId,
      current,
      upcoming: head.effectiveFrom > today ? head : null,
      head,
      ended: head.endDate !== null && head.endDate < today,
      versions: newestFirst,
    });
  }
  return out.sort((a, b) => a.head.name.localeCompare(b.head.name));
}

// An edit is a new version that takes effect on a date, today or later.
// Expenses already created are never changed by it.
export async function editTemplate(
  db: Db,
  actor: Member,
  lineageId: string,
  changes: TemplateChanges,
  effectiveFrom: string,
  today: string,
): Promise<ExpenseTemplate> {
  if (!isIsoDate(effectiveFrom)) throw new UserError("the effective date is not a date");
  if (effectiveFrom < today) throw new UserError("a change cannot take effect earlier than today");
  if (changes.payerId) await requireHouseholdMember(db, actor.householdId, changes.payerId, "the payer", effectiveFrom);
  return db.transaction(async (tx) => {
    const [head] = await tx
      .select()
      .from(expenseTemplate)
      .where(
        and(
          eq(expenseTemplate.householdId, actor.householdId),
          eq(expenseTemplate.lineageId, lineageId),
          eq(expenseTemplate.status, "active"),
        ),
      )
      .for("update");
    if (!head) throw new UserError("that recurring cost does not exist");
    const next: TemplateInput = {
      name: changes.name ?? head.name,
      category: changes.category ?? head.category,
      amountCents: changes.amountCents !== undefined ? changes.amountCents : head.amountCents,
      cadence: head.cadence,
      dayOfMonth: changes.dayOfMonth ?? head.dayOfMonth,
      monthOfYear: changes.monthOfYear !== undefined ? changes.monthOfYear : head.monthOfYear,
      payerId: changes.payerId ?? head.payerId,
      accountId: changes.accountId !== undefined ? changes.accountId : head.accountId,
      startDate: head.startDate,
      endDate: changes.endDate !== undefined ? changes.endDate : head.endDate,
    };
    validate(next);
    await tx.update(expenseTemplate).set({ status: "superseded" }).where(eq(expenseTemplate.id, head.id));
    const [row] = await tx
      .insert(expenseTemplate)
      .values({
        householdId: actor.householdId,
        lineageId,
        name: next.name.trim(),
        category: await toCategory(tx, actor.householdId, next.category),
        amountCents: next.amountCents,
        cadence: next.cadence,
        dayOfMonth: next.dayOfMonth,
        monthOfYear: next.cadence === "monthly" ? null : next.monthOfYear!,
        payerId: next.payerId,
        // A version that keeps an account archived since stays on it.
        accountId: await toAccountId(tx, actor.householdId, next.accountId, { keep: head.accountId }),
        startDate: next.startDate,
        endDate: next.endDate ?? null,
        effectiveFrom,
        supersedesId: head.id,
        createdBy: actor.id,
      })
      .returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "expense_template.changed",
      entity: { type: "expense_template", id: row!.id },
      detail: { lineageId, supersedesId: head.id, effectiveFrom, fields: Object.keys(changes).sort() },
    });
    return row!;
  });
}

// The cost stops falling due after `endDate`. Earlier months are untouched.
export async function endTemplate(db: Db, actor: Member, lineageId: string, endDate: string, today: string) {
  return editTemplate(db, actor, lineageId, { endDate }, today, today);
}
