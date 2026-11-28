// Expenses. An expense exists because something happened: a recurring cost
// reached its due date, someone entered a cost by hand, or a file was
// imported. All three go through `createExpense`. Once posted, an expense's
// shares never change; it can only be voided or superseded by a new one.
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray, sql, type SQL } from "drizzle-orm";
import {
  auditLog,
  cardPayment,
  category,
  expense,
  expenseShare,
  expenseTemplate,
  household,
  type Expense,
  type ExpenseTemplate,
  type Member,
} from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit, type Actor, type AuditAction } from "./audit.ts";
import { toAccountId } from "./accounts.ts";
import { toCategory } from "./categories.ts";
import { addMonths, isIsoDate, isMonth, monthOf } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { followEdit, releaseTie, tieWaitingPurchase } from "./bank-match.ts";
import { dropPayment, followPayment } from "./card-payments.ts";
import { isUuid } from "./ids.ts";
import { householdMembers, memberIdsOn, requireHouseholdMember } from "./members.ts";
import { isValidRule, type Rule } from "@abacus/core/split";
import { loadContext, resolveSplit, templateSeed, type Resolved, type SplitRequest } from "./split/resolve.ts";
import { dueBeforeStart, dueInMonth, type Due } from "./templates.ts";

export type ExpenseWithShares = Expense & { shares: Record<string, number> };

// What an expense can say beyond its amount. Each left out keeps what the
// replaced expense said, or starts empty and at 100%.
export type ExpenseDetail = {
  // Who was paid, apart from the description. Blank clears it.
  vendor?: string | null;
  // What it was for. Blank clears it.
  note?: string | null;
  // How much of it was for the business, in basis points: 1 to 10000. Below
  // 10000 only in a business group, and only with `useBasis`.
  businessUseBp?: number;
  // The one-line reason for a share below 100%. Dropped at 100%.
  useBasis?: string | null;
};

export const WHOLE_BP = 10000;
const DETAIL_MAX = 500;

function cleanText(v: string | null | undefined, name: string): string | null {
  const t = (v ?? "").trim();
  if (t.length > DETAIL_MAX) throw new UserError(`the ${name} is too long: ${DETAIL_MAX} characters at most`);
  return t || null;
}

// The four columns an expense is saved with: what was given, else what the
// replaced expense had.
async function resolveDetail(tx: Db, householdId: string, given: ExpenseDetail, old: Expense | undefined) {
  const vendor = given.vendor === undefined ? (old?.vendor ?? null) : cleanText(given.vendor, "vendor");
  const note = given.note === undefined ? (old?.note ?? null) : cleanText(given.note, "note");
  const businessUseBp = given.businessUseBp ?? old?.businessUseBp ?? WHOLE_BP;
  if (!Number.isInteger(businessUseBp) || businessUseBp < 1 || businessUseBp > WHOLE_BP) {
    throw new UserError("business use is a percentage above 0 and up to 100");
  }
  if (businessUseBp === WHOLE_BP) return { vendor, note, businessUseBp, useBasis: null };
  if (given.businessUseBp !== undefined) {
    const [h] = await tx.select({ kind: household.kind }).from(household).where(eq(household.id, householdId));
    if (h?.kind !== "business") throw new UserError("business use below 100% can be set only in a business group");
  }
  const useBasis = given.useBasis === undefined ? (old?.useBasis ?? null) : cleanText(given.useBasis, "reason");
  if (!useBasis) throw new UserError("business use below 100% needs a reason: say why in one line");
  return { vendor, note, businessUseBp, useBasis };
}

// The business part of an amount, rounded to the cent.
export function businessPart(totalCents: number, businessUseBp: number): number {
  return Math.round((totalCents * businessUseBp) / WHOLE_BP);
}

export type ExpenseEvent =
  // A recurring cost reached its due date.
  // `by` is set when a member entered it for a month before the cost started.
  | { kind: "template"; due: Due; by?: Member }
  | ({
      kind: "manual";
      actor: Member;
      date: string;
      description: string;
      category?: string;
      totalCents: number;
      payerId: string;
      // The account it was paid from: an id of the group's, or blank for none.
      // Left out, an edit keeps the account the old expense had.
      accountId?: string | null;
      // A split picked for this one expense instead of the agreed rules.
      rule?: Rule;
      // Fixes who receives a leftover cent, so a preview of this entry and
      // the entry agree. A fresh draw when left out.
      seed?: string;
      // Today, in the household's timezone: an expense cannot be dated later.
      today: string;
      replaces?: Expense;
      // The agent token the member acted through, when an agent entered it:
      // the expense is then `agent`-sourced and the audit entry names the token.
      agentTokenId?: string;
      // With agentTokenId: if that token already added a live expense with the
      // same date, amount, description, category and payer since this instant,
      // that one is returned (alreadyAdded) and nothing is added, so a call the
      // agent resends after a timeout does not post twice.
      retrySince?: Date;
    } & ExpenseDetail)
  | {
      kind: "import";
      actor: Member;
      date: string;
      description: string;
      category?: string;
      totalCents: number;
      payerId: string;
      // Found or added from the file's account column; see `accountId` above.
      accountId?: string | null;
      // The day of the import: its rules and incomes are used.
      today: string;
      importBatchId: string;
      // Fixed by the file and the row, so the preview and the import agree
      // on who receives a leftover cent.
      seed: string;
      replaces?: Expense;
    }
  | ({
      // A card transaction from a connected bank (bank.ts): posted by the
      // sync itself when the account shares everything (`auto`), or added by
      // the connection's owner from the list waiting to be sorted.
      kind: "bank";
      actor: Member;
      auto: boolean;
      date: string;
      description: string;
      category?: string;
      totalCents: number;
      payerId: string;
      accountId: string;
      today: string;
      // The Plaid transaction id, so a leftover cent goes the same way
      // however often the split is worked out.
      seed: string;
      // A split picked for this one purchase in a card review, instead of
      // the agreed rules.
      rule?: Rule;
    } & ExpenseDetail)
  | {
      // A payment to a shared card (card-review.ts): posted by the sync when
      // it arrives (`auto`), and superseded with a smaller total when a
      // review takes purchases out of it, or a larger one when one is put
      // back. Always in the `card_payment` category.
      kind: "card_payment";
      actor: Member;
      auto: boolean;
      date: string;
      description: string;
      totalCents: number;
      payerId: string;
      accountId: string;
      today: string;
      seed: string;
      // Kept from the version it replaces, when someone chose one.
      rule?: Rule;
      replaces?: Expense;
    };

// The category a shared card's payment is in. Added to a group the first
// time it needs it, so groups made before card review get it too.
export const CARD_PAYMENT_CATEGORY = { slug: "card_payment", label: "Card payment" } as const;

const LIVE = ["posted", "unassigned", "needs_amount"] as const;
// Whether an expense counts now: posted, waiting to be split, or waiting for
// its amount.
export const isLive = (e: Pick<Expense, "status">) => (LIVE as readonly string[]).includes(e.status);

export function validCents(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

async function insertResolved(
  tx: Db,
  values: typeof expense.$inferInsert,
  resolved: Resolved,
  chosenRule: Rule | undefined,
): Promise<ExpenseWithShares> {
  const [row] = await tx
    .insert(expense)
    .values({
      ...values,
      ruleSource: resolved.source,
      chosenRule: chosenRule ?? null,
      ...(resolved.ok
        ? { status: "posted", computation: resolved.computation }
        : { status: "unassigned", unassignedReason: resolved.reason }),
    })
    .returning();
  const shares = resolved.ok ? resolved.shares : {};
  if (resolved.ok) {
    await tx.insert(expenseShare).values(
      Object.entries(shares).map(([memberId, shareCents]) => ({
        expenseId: row!.id,
        memberId,
        householdId: row!.householdId,
        shareCents,
      })),
    );
  }
  return { ...row!, shares };
}

type EntryEvent = Exclude<ExpenseEvent, { kind: "template" }>;

// The split someone chose for this one expense, if any.
function chosenRule(event: EntryEvent): Rule | undefined {
  return event.kind === "manual" || event.kind === "bank" || event.kind === "card_payment" ? event.rule : undefined;
}

// How an expense entered by hand or imported is split. createExpense saves
// by it, and previewEdit shows what it would save.
function entryRequest(event: EntryEvent, lineageId: string | null, category: string): SplitRequest {
  const chosen = chosenRule(event);
  return {
    templateLineageId: lineageId,
    category,
    totalCents: event.totalCents,
    payerId: event.payerId,
    seed: event.seed ?? randomUUID(),
    // A hand-entered expense uses the rules of its own date. An import
    // uses the rules of the day it is imported.
    rulesAsOf: event.kind === "import" ? event.today : event.date,
    membersAsOf: event.date,
    chosen: chosen ? { rule: chosen, by: event.actor.id } : undefined,
  };
}

// The one path by which an expense comes to exist.
export async function createExpense(
  db: Db,
  householdId: string,
  event: ExpenseEvent,
): Promise<ExpenseWithShares & { alreadyAdded?: true }> {
  if (event.kind === "template") {
    const t = event.due.template;
    const base = {
      householdId,
      templateId: t.id,
      templateLineageId: t.lineageId,
      period: event.due.period,
      date: event.due.date,
      description: t.name,
      category: t.category,
      payerId: t.payerId,
      accountId: t.accountId,
      source: "template" as const,
      createdBy: event.by?.id ?? null,
    };
    return db.transaction(async (tx) => {
      const actor: Actor = event.by ? { kind: "member", memberId: event.by.id } : { kind: "system" };
      if (t.amountCents === null) {
        const [row] = await tx
          .insert(expense)
          .values({ ...base, status: "needs_amount" })
          .returning();
        await writeAudit(tx, {
          householdId,
          actor,
          action: "expense.needs_amount",
          entity: { type: "expense", id: row!.id },
          detail: { templateLineageId: t.lineageId, period: event.due.period },
        });
        return { ...row!, shares: {} };
      }
      const resolved = resolveSplit(await loadContext(tx, householdId), {
        templateLineageId: t.lineageId,
        category: t.category,
        totalCents: t.amountCents,
        payerId: t.payerId,
        seed: templateSeed(t.lineageId, event.due.period),
        rulesAsOf: event.due.date,
      });
      const row = await insertResolved(tx, { ...base, totalCents: t.amountCents, status: "posted" }, resolved, undefined);
      await writeAudit(tx, {
        householdId,
        actor,
        action: row.status === "unassigned" ? "expense.unassigned" : "expense.posted",
        entity: { type: "expense", id: row.id },
        detail: {
          templateLineageId: t.lineageId,
          period: event.due.period,
          source: "template",
          ...(t.accountId ? { accountId: t.accountId } : {}),
        },
      });
      // A card purchase that arrived before this cost was posted is the same money.
      // Matching never stops a cost posting: in a savepoint, and logged if it fails.
      try {
        await tx.transaction((sp) => tieWaitingPurchase(sp, row, new Date()));
      } catch (e) {
        console.error(`bank: matching a card purchase to expense ${row.id} failed: ${e instanceof Error ? e.name : "error"}`);
      }
      return row;
    });
  }

  const { actor } = event;
  if (actor.householdId !== householdId) throw new UserError("that is not your household");
  if (!event.description.trim()) throw new UserError("an expense needs a description");
  if (!validCents(event.totalCents)) throw new UserError("the amount must be more than zero");
  if (!isIsoDate(event.date)) throw new UserError("the date is not a date");
  if (event.date > event.today) throw new UserError("an expense cannot be dated later than today");
  await requireHouseholdMember(db, householdId, event.payerId, "the payer", event.date);
  const chosen = chosenRule(event);
  if (chosen) {
    const memberIds = memberIdsOn(await householdMembers(db, householdId), event.date);
    if (!isValidRule(chosen, memberIds)) throw new UserError("that split is not valid for this household");
  }

  const source = event.kind === "manual" && event.agentTokenId ? "agent" : event.kind;
  const tokenId = event.kind === "manual" ? event.agentTokenId : undefined;

  return db.transaction(async (tx) => {
    const old = event.kind === "bank" ? undefined : event.replaces;
    if (old) {
      const superseded = await tx
        .update(expense)
        .set({ status: "superseded" })
        .where(and(eq(expense.id, old.id), eq(expense.householdId, householdId), inArray(expense.status, [...LIVE])))
        .returning({ id: expense.id });
      if (superseded.length === 0) throw new UserError("that expense has already been replaced or voided");
    }
    const lineageId = old?.templateLineageId ?? null;
    const category = event.kind === "card_payment" ? (old?.category ?? (await ensureCardPaymentCategory(tx, householdId))) : await toCategory(tx, householdId, event.category);
    // An import or a bank may name an archived account: they record what was.
    const accountId =
      event.accountId === undefined
        ? (old?.accountId ?? null)
        : await toAccountId(tx, householdId, event.accountId, { keep: old?.accountId, archived: event.kind !== "manual" });
    // Posted by the sync, not by a person.
    const auto = (event.kind === "bank" || event.kind === "card_payment") && event.auto;
    const retrySince = event.kind === "manual" && !old ? event.retrySince : undefined;
    if (tokenId && retrySince) {
      const [same] = await tx
        .select({ e: expense })
        .from(expense)
        .innerJoin(
          auditLog,
          and(eq(auditLog.entityId, sql`${expense.id}::text`), eq(auditLog.actorTokenId, tokenId), gte(auditLog.at, retrySince)),
        )
        .where(
          and(
            eq(expense.householdId, householdId),
            inArray(expense.status, [...LIVE]),
            isNull(expense.supersedesId),
            eq(expense.date, event.date),
            eq(expense.totalCents, event.totalCents),
            eq(expense.description, event.description.trim()),
            eq(expense.category, category),
            eq(expense.payerId, event.payerId),
          ),
        )
        .limit(1);
      if (same) return { ...(await withShares(tx, [same.e]))[0]!, alreadyAdded: true as const };
    }
    const detail = await resolveDetail(tx, householdId, event.kind === "manual" || event.kind === "bank" ? event : {}, old);
    const resolved = resolveSplit(await loadContext(tx, householdId), entryRequest(event, lineageId, category));
    const row = await insertResolved(
      tx,
      {
        householdId,
        templateId: old?.templateId ?? null,
        templateLineageId: lineageId,
        period: old?.period ?? null,
        date: event.date,
        description: event.description.trim(),
        category,
        totalCents: event.totalCents,
        payerId: event.payerId,
        accountId,
        ...detail,
        status: "posted",
        source,
        supersedesId: old?.id ?? null,
        importBatchId: event.kind === "import" ? event.importBatchId : null,
        createdBy: auto ? null : actor.id,
      },
      resolved,
      chosen,
    );
    await writeAudit(tx, {
      householdId,
      actor: auto ? { kind: "system" } : { kind: "member", memberId: actor.id, ...(tokenId ? { tokenId } : {}) },
      action: row.status === "unassigned" ? "expense.unassigned" : "expense.posted",
      entity: { type: "expense", id: row.id },
      detail: { source, ...(old ? { supersedesId: old.id } : {}), ...(accountId ? { accountId } : {}) },
    });
    // A bank purchase tied to the old version follows the new one, and so
    // does a card payment it holds.
    if (old) {
      await followEdit(tx, old, row, actor);
      await followPayment(tx, old, row);
    }
    return row;
  });
}

async function ensureCardPaymentCategory(tx: Db, householdId: string): Promise<string> {
  await tx
    .insert(category)
    .values({ householdId, ...CARD_PAYMENT_CATEGORY })
    .onConflictDoNothing();
  return CARD_PAYMENT_CATEGORY.slug;
}

function isUniqueViolation(e: unknown): boolean {
  for (let at = e as { code?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) {
    if (at.code === "23505") return true;
  }
  return false;
}

// Creates the expense for every recurring cost with a due date on or before
// `today` that has none yet for that period. Safe to run any number of
// times; catches up on periods that were missed, each with its own date.
export async function postDue(db: Db, householdId: string, today: string): Promise<ExpenseWithShares[]> {
  const versions = await db.select().from(expenseTemplate).where(eq(expenseTemplate.householdId, householdId));
  const lineages = new Map<string, ExpenseTemplate[]>();
  for (const v of versions) lineages.set(v.lineageId, [...(lineages.get(v.lineageId) ?? []), v]);

  // Any expense counts, whatever its status: a voided one is not re-created.
  const existing = await db
    .select({ lineageId: expense.templateLineageId, period: expense.period })
    .from(expense)
    .where(and(eq(expense.householdId, householdId), isNotNull(expense.templateLineageId)));
  const have = new Set(existing.map((e) => `${e.lineageId}:${e.period}`));

  const due: Due[] = [];
  for (const [lineageId, rows] of lineages) {
    const start = rows.reduce((min, r) => (r.startDate < min ? r.startDate : min), rows[0]!.startDate);
    for (let month = monthOf(start); month <= monthOf(today); month = addMonths(month, 1)) {
      const d = dueInMonth(rows, month);
      if (d && d.date <= today && !have.has(`${lineageId}:${d.period}`)) due.push(d);
    }
  }
  due.sort((a, b) => a.date.localeCompare(b.date) || a.template.name.localeCompare(b.template.name));

  const created: ExpenseWithShares[] = [];
  for (const d of due) {
    try {
      created.push(await createExpense(db, householdId, { kind: "template", due: d }));
    } catch (e) {
      // Someone else opened the app at the same moment and posted it first.
      if (!isUniqueViolation(e)) throw e;
    }
  }
  return created;
}

// Enters a recurring cost for a month before it started, on that month's
// due day and with the rules of that day. `postDue` never reaches these
// months, so someone asks for each one.
export async function postEarlier(
  db: Db,
  actor: Member,
  lineageId: string,
  month: string,
  today: string,
): Promise<ExpenseWithShares> {
  if (!isMonth(month)) throw new UserError("choose a month");
  const versions = await db
    .select()
    .from(expenseTemplate)
    .where(and(eq(expenseTemplate.householdId, actor.householdId), eq(expenseTemplate.lineageId, lineageId)));
  const due = dueBeforeStart(versions, month);
  if (due === null) throw new UserError("that recurring cost does not exist");
  if (due === "not_due") throw new UserError("this cost does not fall due in that month");
  if (due === "after_start") throw new UserError("this cost is entered by itself from that month on");
  if (due.date > today) throw new UserError("an expense cannot be dated later than today");
  try {
    return await createExpense(db, actor.householdId, { kind: "template", due, by: actor });
  } catch (e) {
    if (isUniqueViolation(e)) throw new UserError("that month is already entered for this cost");
    throw e;
  }
}

export async function withShares(db: Db, rows: Expense[]): Promise<ExpenseWithShares[]> {
  if (rows.length === 0) return [];
  const shares = await db
    .select()
    .from(expenseShare)
    .where(
      inArray(
        expenseShare.expenseId,
        rows.map((r) => r.id),
      ),
    );
  const byExpense = new Map<string, Record<string, number>>();
  for (const s of shares) {
    byExpense.set(s.expenseId, { ...(byExpense.get(s.expenseId) ?? {}), [s.memberId]: s.shareCents });
  }
  return rows.map((r) => ({ ...r, shares: byExpense.get(r.id) ?? {} }));
}

export async function getExpense(db: Db, householdId: string, expenseId: string): Promise<ExpenseWithShares> {
  if (!isUuid(expenseId)) throw new UserError("that expense does not exist");
  const rows = await db
    .select()
    .from(expense)
    .where(and(eq(expense.id, expenseId), eq(expense.householdId, householdId)));
  const [found] = await withShares(db, rows);
  if (!found) throw new UserError("that expense does not exist");
  return found;
}

// Every expense dated in a calendar month, including voided and replaced
// ones so the month's history is complete. Proposals are not expenses yet,
// so they are left out, as are the ones that were turned down. With `limit`,
// only that many of the oldest are loaded.
export async function listMonth(db: Db, householdId: string, month: string, opts: ListOptions = {}): Promise<ExpenseWithShares[]> {
  return listWhere(db, householdId, and(gte(expense.date, `${month}-01`), lt(expense.date, `${addMonths(month, 1)}-01`))!, opts);
}

// The same, for the dates from `from` to `to`, both included. The caller
// checks that both are dates and limits how far apart they are.
export async function listRange(db: Db, householdId: string, from: string, to: string, opts: ListOptions = {}): Promise<ExpenseWithShares[]> {
  return listWhere(db, householdId, and(gte(expense.date, from), lte(expense.date, to))!, opts);
}

export type ListOptions = { limit?: number };

async function listWhere(db: Db, householdId: string, dates: SQL, { limit }: ListOptions): Promise<ExpenseWithShares[]> {
  const query = db
    .select()
    .from(expense)
    .where(
      and(
        eq(expense.householdId, householdId),
        dates,
        notInArray(expense.status, ["proposed", "rejected"]),
      ),
    )
    .orderBy(asc(expense.date), asc(expense.createdAt));
  return withShares(db, limit === undefined ? await query : await query.limit(limit));
}

export async function listByStatus(
  db: Db,
  householdId: string,
  status: Expense["status"],
): Promise<ExpenseWithShares[]> {
  const rows = await db
    .select()
    .from(expense)
    .where(and(eq(expense.householdId, householdId), eq(expense.status, status)))
    .orderBy(asc(expense.date), asc(expense.createdAt));
  return withShares(db, rows);
}

export async function lockLive(tx: Db, actor: Member, expenseId: string, wanted?: Expense["status"]): Promise<Expense> {
  if (!isUuid(expenseId)) throw new UserError("that expense does not exist");
  const [row] = await tx
    .select()
    .from(expense)
    .where(and(eq(expense.id, expenseId), eq(expense.householdId, actor.householdId)))
    .for("update");
  if (!row) throw new UserError("that expense does not exist");
  if (wanted ? row.status !== wanted : !isLive(row)) {
    throw new UserError(`that expense is ${row.status.replace("_", " ")}; nothing was changed`);
  }
  return row;
}

export async function settle(tx: Db, actor: Member, row: Expense, resolved: Resolved, action: AuditAction, totalCents: number) {
  if (resolved.ok) {
    await tx.insert(expenseShare).values(
      Object.entries(resolved.shares).map(([memberId, shareCents]) => ({
        expenseId: row.id,
        memberId,
        householdId: row.householdId,
        shareCents,
      })),
    );
  }
  const [updated] = await tx
    .update(expense)
    .set({
      totalCents,
      ruleSource: resolved.source,
      ...(resolved.ok
        ? { status: "posted", computation: resolved.computation, unassignedReason: null }
        : { status: "unassigned", unassignedReason: resolved.reason }),
    })
    .where(eq(expense.id, row.id))
    .returning();
  await writeAudit(tx, {
    householdId: row.householdId,
    actor: { kind: "member", memberId: actor.id },
    action,
    entity: { type: "expense", id: row.id },
    detail: { status: updated!.status },
  });
  return { ...updated!, shares: resolved.ok ? resolved.shares : {} };
}

// Someone enters the bill for a recurring cost whose amount varies. The
// shares use the rules of the expense's own date.
export async function enterAmount(
  db: Db,
  actor: Member,
  expenseId: string,
  totalCents: number,
): Promise<ExpenseWithShares> {
  if (!validCents(totalCents)) throw new UserError("the amount must be more than zero");
  return db.transaction(async (tx) => {
    const row = await lockLive(tx, actor, expenseId, "needs_amount");
    const resolved = resolveSplit(await loadContext(tx, row.householdId), amountRequest(row, totalCents));
    return settle(tx, actor, row, resolved, "expense.amount_entered", totalCents);
  });
}

// How a bill given its amount is split: by enterAmount, and by
// previewAmount without saving.
function amountRequest(row: Expense, totalCents: number): SplitRequest {
  return {
    templateLineageId: row.templateLineageId,
    category: row.category,
    totalCents,
    payerId: row.payerId,
    seed: row.templateLineageId && row.period ? templateSeed(row.templateLineageId, row.period) : randomUUID(),
    rulesAsOf: row.date,
  };
}

// What entering this amount would post, saving nothing.
export async function previewAmount(db: Db, row: Expense, totalCents: number): Promise<Resolved> {
  return resolveSplit(await loadContext(db, row.householdId), amountRequest(row, totalCents));
}

// Gives an unassigned expense its shares: by the rules and incomes in force
// today, or by a split picked by hand. Today, not the expense's date, so a
// rule or income saved now fixes it whatever date it was saved from. (Both
// can be dated back too, but this does not look at the expense's date.)
// Who is in the group is still taken on the expense's date.
export async function fixUnassigned(
  db: Db,
  actor: Member,
  expenseId: string,
  today: string,
  rule?: Rule,
): Promise<ExpenseWithShares> {
  return db.transaction(async (tx) => {
    const row = await lockLive(tx, actor, expenseId, "unassigned");
    const ctx = await loadContext(tx, row.householdId);
    if (rule && !isValidRule(rule, memberIdsOn(ctx.members, row.date))) throw new UserError("that split is not valid for this household");
    const resolved = resolveSplit(ctx, {
      templateLineageId: row.templateLineageId,
      category: row.category,
      totalCents: row.totalCents!,
      payerId: row.payerId,
      seed: row.templateLineageId && row.period ? templateSeed(row.templateLineageId, row.period) : randomUUID(),
      rulesAsOf: today,
      membersAsOf: row.date,
      chosen: rule ? { rule, by: actor.id } : undefined,
    });
    if (!resolved.ok) {
      throw new UserError(`the segments still cannot be computed (${resolved.reason.replaceAll("_", " ")})`);
    }
    return settle(tx, actor, row, resolved, "expense.fixed", row.totalCents!);
  });
}

// `via` is the agent token the member acted through, if any.
export async function voidExpense(db: Db, actor: Member, expenseId: string, via: { agentTokenId?: string } = {}): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockLive(tx, actor, expenseId);
    await tx.update(expense).set({ status: "void" }).where(eq(expense.id, row.id));
    await writeAudit(tx, {
      householdId: row.householdId,
      actor: { kind: "member", memberId: actor.id, ...(via.agentTokenId ? { tokenId: via.agentTokenId } : {}) },
      action: "expense.voided",
      entity: { type: "expense", id: row.id },
      detail: { was: row.status },
    });
    await dropPayment(tx, row, actor);
    await releaseTie(tx, row, actor);
  });
}

export type ExpenseEdit = {
  date: string;
  description: string;
  category?: string;
  totalCents: number;
  payerId: string;
  // Left out, the edit keeps the account; blank clears it.
  accountId?: string | null;
  rule?: Rule;
  // See `seed` on a manual entry.
  seed?: string;
} & ExpenseDetail;

// An edit keeps the old expense as `superseded` and enters a new one that
// points back at it. `via` is the agent token the member acted through, if any.
export async function editExpense(
  db: Db,
  actor: Member,
  expenseId: string,
  edit: ExpenseEdit,
  today: string,
  via: { agentTokenId?: string } = {},
): Promise<ExpenseWithShares> {
  const old = await getExpense(db, actor.householdId, expenseId);
  if (!isLive(old)) throw new UserError(`that expense is ${old.status}; nothing was changed`);
  // What a card payment still shares is the amount paid less the purchases
  // a review took out of it; only a review changes it.
  if (edit.totalCents !== old.totalCents || edit.date !== old.date) {
    const [held] = await db
      .select({ id: cardPayment.id })
      .from(cardPayment)
      .where(and(eq(cardPayment.expenseId, old.id), eq(cardPayment.householdId, actor.householdId)));
    if (held) throw new UserError("a card payment's amount and date come from the bank; to take purchases out of it, review the card in Accounts");
  }
  return createExpense(db, actor.householdId, { kind: "manual", actor, ...edit, today, replaces: old, agentTokenId: via.agentTokenId });
}

// What editing this expense would post, saving nothing: the split
// createExpense makes for the same edit. With `edit.seed`, exactly that.
export async function previewEdit(db: Db, actor: Member, old: Expense, edit: ExpenseEdit, today: string): Promise<Resolved> {
  const category = await toCategory(db, old.householdId, edit.category);
  return resolveSplit(await loadContext(db, old.householdId), entryRequest({ kind: "manual", actor, ...edit, today }, old.templateLineageId ?? null, category));
}
