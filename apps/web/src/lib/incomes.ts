import { and, desc, eq, gte, ne } from "drizzle-orm";
import { income, member, type Income, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";
import { isIsoDate } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { incomeRatio, type RatioResult } from "@abacus/core/split";
import { memberIdsOn } from "./members.ts";
import { incomesOn, latestOn, loadContext, type IncomesOn } from "./split/resolve.ts";

export type IncomeInput = {
  annualCents: number;
  // Whose income it is, when the person entering it is someone else in the
  // household. Left out, it is the actor's own.
  ownerId?: string;
  // The date it counts from. Left out, today.
  effectiveFrom?: string;
};

// Later than any date, so `latestOn` gives the row that comes last.
const ALWAYS = "9999-12-31";

const memberActor = (m: Member) => ({ kind: "member" as const, memberId: m.id });

// Who may add, change or remove an owner's income: the owner, or anyone in
// the group while the owner has not joined yet, so the person setting up
// alone is not stuck. "Joined" means signed in (`linkedAt`). Pages use this
// to decide what to offer; `ownerFor` enforces it.
export function mayWriteIncome(actor: Pick<Member, "id">, owner: Pick<Member, "id" | "linkedAt">): boolean {
  return owner.id === actor.id || owner.linkedAt === null;
}

// The owner, in the actor's group, whose income the actor may write. Throws,
// in plain words, when they may not.
async function ownerFor(tx: Db, actor: Member, ownerId: string): Promise<Member> {
  // Matched in code, so an id that is not a uuid is refused, not thrown by Postgres.
  const inHousehold = await tx.select().from(member).where(eq(member.householdId, actor.householdId));
  const owner = inHousehold.find((m) => m.id === ownerId);
  if (!owner) throw new UserError("that person is not a member of this household");
  if (!mayWriteIncome(actor, owner)) {
    throw new UserError(`${owner.displayName} has joined, so only they can change their income`);
  }
  // Holds the owner's row until the transaction ends, so two saves or
  // removals of one person's income run one after the other, each reading
  // the rows the other left.
  await lockOwner(tx, owner.id);
  return owner;
}

// Locks one member's row for the rest of the transaction. Anything that
// reads an owner's incomes and then writes them takes this lock first.
export async function lockOwner(tx: Db, ownerId: string): Promise<void> {
  await tx.select({ id: member.id }).from(member).where(eq(member.id, ownerId)).for("update");
}

// The owner's income from its date onwards: the active row that comes last.
// An edit replaces this one.
async function latestRow(tx: Db, householdId: string, ownerId: string): Promise<Income | undefined> {
  const rows = await tx
    .select()
    .from(income)
    .where(and(eq(income.householdId, householdId), eq(income.ownerId, ownerId), eq(income.status, "active")));
  return latestOn(rows, ALWAYS);
}

// Adds an income, or changes one, and it counts at once from `effectiveFrom`
// (default today). Nothing already split moves: an expense keeps the shares
// it was given.
//
// A change is a new row pointing back at the one it replaces, never an
// update of the amount. With a later date it is a raise or a cut from that
// date, and the old amount still holds before it. With the same date or an
// earlier one it replaces every row of that owner dated on or after it:
// those become `void`, with `replacedBy` set to the new row, so they stay on
// record but no longer count. Rows dated before it still hold before it.
//
// Everyone in the group sees the amount. Amounts hidden before hiding went
// away stay hidden, including the ones this row follows or replaces, until
// their owner shows them (`setShareMode`). The audit entry carries ids,
// never the amount.
export async function recordIncome(db: Db, actor: Member, input: IncomeInput, today: string): Promise<Income> {
  if (!Number.isSafeInteger(input.annualCents) || input.annualCents < 0) {
    throw new UserError("an income is a whole number of cents, zero or more");
  }
  const effectiveFrom = input.effectiveFrom || today;
  if (!isIsoDate(effectiveFrom)) throw new UserError("the date it counts from is not a date");
  const ownerId = input.ownerId || actor.id;
  const forSomeoneElse = ownerId !== actor.id;
  const shareMode = "amount";
  return db.transaction(async (tx) => {
    await ownerFor(tx, actor, ownerId);
    const replaces = await latestRow(tx, actor.householdId, ownerId);
    // Saved last wins a same-date tie, even within the same millisecond.
    const now = new Date();
    const after = replaces?.activatedAt ? replaces.activatedAt.getTime() + 1 : 0;
    const activatedAt = now.getTime() > after ? now : new Date(after);
    const [row] = await tx
      .insert(income)
      .values({
        householdId: actor.householdId,
        ownerId,
        annualCents: input.annualCents,
        effectiveFrom,
        shareMode,
        status: "active",
        activatedAt,
        supersedesId: replaces?.id ?? null,
        createdBy: actor.id,
      })
      .returning();
    const voided = await tx
      .update(income)
      .set({ status: "void", voidedAt: now, voidedBy: actor.id, replacedBy: row!.id })
      .where(
        and(
          eq(income.householdId, actor.householdId),
          eq(income.ownerId, ownerId),
          eq(income.status, "active"),
          gte(income.effectiveFrom, effectiveFrom),
          ne(income.id, row!.id),
        ),
      )
      .returning({ id: income.id });
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: memberActor(actor),
      action: replaces ? "income.changed" : "income.recorded",
      entity: { type: "income", id: row!.id },
      detail: {
        shareMode,
        effectiveFrom,
        ...(forSomeoneElse ? { ownerId } : {}),
        ...(replaces ? { supersedesId: replaces.id } : {}),
        ...(voided.length > 0 ? { replacedIds: voided.map((v) => v.id) } : {}),
      },
    });
    return row!;
  });
}

// Removes an owner's income: every row still active becomes `void` and
// stays on record. From then on they have no income on any date, so a split
// by income says it is missing until one is added again. Expenses already
// split keep their shares.
export async function removeIncome(db: Db, actor: Member, ownerId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await ownerFor(tx, actor, ownerId);
    const latest = await latestRow(tx, actor.householdId, ownerId);
    if (!latest) throw new UserError("there is no income on record to remove");
    const voided = await tx
      .update(income)
      .set({ status: "void", voidedAt: new Date(), voidedBy: actor.id })
      .where(and(eq(income.householdId, actor.householdId), eq(income.ownerId, ownerId), eq(income.status, "active")))
      .returning({ id: income.id });
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: memberActor(actor),
      action: "income.removed",
      entity: { type: "income", id: latest.id },
      detail: { ownerId, incomeIds: voided.map((v) => v.id) },
    });
  });
}

// Shows an amount hidden before hiding went away. Only its owner may, it
// changes no split, and it applies at once. It covers all the owner's rows,
// so the amounts it replaced are shown along with it. The audit entry
// records the switch. Nothing hides an amount any more.
export async function setShareMode(db: Db, actor: Member, incomeId: string, shareMode: "amount"): Promise<void> {
  if (shareMode !== "amount") throw new UserError("an income amount can no longer be hidden");
  await db.transaction(async (tx) => {
    const mine = and(eq(income.householdId, actor.householdId), eq(income.ownerId, actor.id));
    const [before] = await tx
      .select({ shareMode: income.shareMode })
      .from(income)
      .where(and(mine, eq(income.id, incomeId)))
      .limit(1);
    if (!before) throw new UserError("only your own income can be changed");
    if (before.shareMode === shareMode) return;
    await tx.update(income).set({ shareMode }).where(mine);
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: memberActor(actor),
      action: "income.share_mode_changed",
      entity: { type: "income", id: incomeId },
      detail: { from: before.shareMode, to: shareMode },
    });
  });
}

// An income as one person may see it. `annualCents` is null when the owner
// hid the amount (before hiding went away) and the viewer is someone else. `state` says where a
// row stands on `today`: the owner's `current` one, in force today; an active
// one dated after today, `upcoming`; an active one dated before the current
// one, which still holds before it, `earlier`; one voided by an edit dated on
// or before it, `replaced`; or one `removed`. It is null for a row that never
// took effect, such as one withdrawn from a change set (migration 0021).
export type IncomeState = "current" | "upcoming" | "earlier" | "replaced" | "removed";
export type VisibleIncome = Omit<Income, "annualCents"> & { annualCents: number | null; state: IncomeState | null };

// Whether a viewer may see an income row's amount: their own, or one the
// owner has not hidden. Every page that shows an amount asks this.
export function incomeAmountVisible(row: Pick<Income, "ownerId" | "shareMode">, viewer: Pick<Member, "id">): boolean {
  return row.ownerId === viewer.id || row.shareMode === "amount";
}

// The only way income rows reach a page. Owners see their own amounts; a
// partner sees an amount only when it is shared as an amount. Newest first.
export async function listIncomes(db: Db, viewer: Member, today: string): Promise<VisibleIncome[]> {
  const rows = await db
    .select()
    .from(income)
    .where(eq(income.householdId, viewer.householdId))
    .orderBy(desc(income.createdAt));
  const current = new Set<string>();
  for (const ownerId of new Set(rows.map((r) => r.ownerId))) {
    const inForce = latestOn(
      rows.filter((r) => r.ownerId === ownerId && r.status === "active"),
      today,
    );
    if (inForce) current.add(inForce.id);
  }
  const stateOf = (row: Income): IncomeState | null => {
    if (current.has(row.id)) return "current";
    if (row.status === "active") return row.effectiveFrom! > today ? "upcoming" : "earlier";
    if (row.status === "void") return row.replacedBy !== null ? "replaced" : "removed";
    return null;
  };
  return rows.map((row) => ({
    ...row,
    annualCents: incomeAmountVisible(row, viewer) ? row.annualCents : null,
    state: stateOf(row),
  }));
}

// Each member's income in force on a date, or who has none. For the split
// calculation only: it returns amounts regardless of share mode, so nothing
// it returns may be shown to a person. Pages use `listIncomes`.
export async function incomesInForce(db: Db, householdId: string, date: string): Promise<IncomesOn> {
  return incomesOn(await loadContext(db, householdId), date);
}

// The income ratio on a date, in basis points. Everyone in the group may see it.
export async function currentRatio(db: Db, householdId: string, date: string): Promise<RatioResult> {
  const ctx = await loadContext(db, householdId);
  const incomes = incomesOn(ctx, date);
  if (!incomes.ok) return { ok: false, reason: "income_missing" };
  return incomeRatio(memberIdsOn(ctx.members, date), incomes.annualCents);
}
