import { and, asc, eq, sql } from "drizzle-orm";
import { category, DEFAULT_CATEGORY, household, type Category, type GroupKind, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";
import { UserError } from "@abacus/core/errors";

// `taxLine` is the line of the tax form the category reports on; `half` marks
// meals, which count at half.
type Starter = { slug: string; label: string; taxLine?: string; half?: true };

// What a new group starts with, by kind. A household's is short on purpose: a
// group adds its own under Settings. A business's follows Schedule C (Form
// 1040), part II; the line numbers were read from the 2026 form, where
// "Other expenses" is line 27b. They are a guide and can change from year to
// year. Changing a list here changes new groups only; groups that exist keep
// the rows they have, and Settings offers them what they lack
// (missingStarters). Every list ends with `other`.
export const DEFAULT_CATEGORIES: Record<GroupKind, readonly Starter[]> = {
  household: [
    { slug: "housing", label: "Housing" },
    { slug: "utilities", label: "Utilities" },
    { slug: "groceries", label: "Groceries" },
    { slug: "dining", label: "Dining out" },
    { slug: "subscriptions", label: "Subscriptions" },
    { slug: DEFAULT_CATEGORY, label: "Other" },
  ],
  business: [
    { slug: "advertising", label: "Advertising", taxLine: "8" },
    { slug: "car_and_truck", label: "Car and truck", taxLine: "9" },
    { slug: "commissions_and_fees", label: "Commissions and fees", taxLine: "10" },
    { slug: "contract_labor", label: "Contract labor", taxLine: "11" },
    { slug: "insurance", label: "Insurance", taxLine: "15" },
    { slug: "legal_and_professional", label: "Legal and professional", taxLine: "17" },
    { slug: "office_expense", label: "Office expense", taxLine: "18" },
    { slug: "rent", label: "Rent", taxLine: "20b" },
    { slug: "repairs", label: "Repairs", taxLine: "21" },
    { slug: "supplies", label: "Supplies", taxLine: "22" },
    { slug: "taxes_and_licenses", label: "Taxes and licenses", taxLine: "23" },
    { slug: "travel", label: "Travel", taxLine: "24a" },
    { slug: "meals", label: "Meals", taxLine: "24b", half: true },
    { slug: "utilities", label: "Utilities", taxLine: "25" },
    { slug: "software", label: "Software and subscriptions", taxLine: "27b" },
    { slug: DEFAULT_CATEGORY, label: "Other" },
  ],
};

// Gives a new group its starting list. Call it in the transaction that
// creates the group: a cost cannot be saved in a group with no categories.
export async function seedCategories(db: Db, householdId: string, kind: GroupKind): Promise<void> {
  await db
    .insert(category)
    .values(DEFAULT_CATEGORIES[kind].map((c) => starterRow(householdId, c)))
    .onConflictDoNothing();
}

const starterRow = (householdId: string, c: Starter) => ({
  householdId,
  slug: c.slug,
  label: c.label,
  taxLine: c.taxLine ?? null,
  halfDeductible: c.half ?? false,
});

// The starting categories of its kind that a group lacks: none of its
// categories, removed ones included, has the slug, and none it shows has the
// name. A group made before the list grew is offered these in Settings.
export async function missingStarters(db: Db, householdId: string, kind: GroupKind): Promise<Starter[]> {
  const rows = await db.select().from(category).where(eq(category.householdId, householdId));
  const slugs = new Set(rows.map((c) => c.slug));
  const names = new Set(rows.filter((c) => !c.removedAt).map((c) => c.label.toLowerCase()));
  return DEFAULT_CATEGORIES[kind].filter((c) => !slugs.has(c.slug) && !names.has(c.label.toLowerCase()));
}

// Adds every starting category the actor's group lacks. What it has is left
// as it is: its names, and its lines or lack of them.
export async function addStarterCategories(db: Db, actor: Member): Promise<Category[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"abacus.category." + actor.householdId}))`);
    const [h] = await tx.select({ kind: household.kind }).from(household).where(eq(household.id, actor.householdId));
    const missing = await missingStarters(tx, actor.householdId, h!.kind);
    if (missing.length === 0) return [];
    const rows = await tx
      .insert(category)
      .values(missing.map((c) => ({ ...starterRow(actor.householdId, c), createdBy: actor.id })))
      .returning();
    for (const row of rows) {
      await writeAudit(tx, {
        householdId: actor.householdId,
        actor: { kind: "member", memberId: actor.id },
        action: "category.added",
        entity: { type: "category", id: row.id },
        detail: { slug: row.slug, label: row.label, ...(row.taxLine ? { taxLine: row.taxLine } : {}) },
      });
    }
    return rows;
  });
}

// A group's categories by label, with `other` last. Removed ones are left
// out unless asked for, which is only to show the label on an old cost.
export async function listCategories(db: Db, householdId: string, { removed = false } = {}): Promise<Category[]> {
  const rows = await db.select().from(category).where(eq(category.householdId, householdId)).orderBy(asc(category.label));
  return rows
    .filter((c) => removed || !c.removedAt)
    .sort((a, b) => Number(a.slug === DEFAULT_CATEGORY) - Number(b.slug === DEFAULT_CATEGORY));
}

// Slug to label, for showing costs. Includes removed categories, since old
// costs still name them.
export async function categoryLabels(db: Db, householdId: string): Promise<Record<string, string>> {
  const rows = await listCategories(db, householdId, { removed: true });
  return Object.fromEntries(rows.map((c) => [c.slug, c.label]));
}

// The slug a piece of text names among `slugs`, ignoring case and spaces
// around it. Blank is `other`; null when it names none.
export function parseCategory(slugs: ReadonlySet<string> | readonly string[], text: string | null | undefined): string | null {
  const value = (text ?? "").trim().toLowerCase();
  if (!value) return DEFAULT_CATEGORY;
  return (slugs instanceof Set ? slugs.has(value) : (slugs as readonly string[]).includes(value)) ? value : null;
}

// The group's category that `text` names, or a UserError. A removed
// category still counts: it is gone from the pickers, but a correction to an
// old cost, or a file exported earlier, may name it.
export async function toCategory(db: Db, householdId: string, text: string | null | undefined): Promise<string> {
  const value = (text ?? "").trim().toLowerCase();
  if (!value) return DEFAULT_CATEGORY;
  const [row] = await db
    .select({ slug: category.slug })
    .from(category)
    .where(and(eq(category.householdId, householdId), eq(category.slug, value)))
    .limit(1);
  if (!row) throw new UserError("choose a category from the list");
  return row.slug;
}

const MAX_LABEL = 40;

function cleanLabel(label: string): string {
  const value = label.trim().replace(/\s+/g, " ");
  if (!value) throw new UserError("give the category a name");
  if (value.length > MAX_LABEL) throw new UserError(`a category name can be at most ${MAX_LABEL} characters`);
  return value;
}

// "Meals & travel" becomes "meals_travel".
export function slugFor(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function find(db: Db, householdId: string, slug: string): Promise<Category> {
  const [row] = await db
    .select()
    .from(category)
    .where(and(eq(category.householdId, householdId), eq(category.slug, slug)))
    .limit(1);
  if (!row) throw new UserError("that category is not in this group");
  return row;
}

// Refuses a name that another of the group's live categories has, compared
// without case: two entries in a picker that read the same cannot be told
// apart. `except` is the category being renamed. Holds a lock for the
// transaction so two people cannot both take a name.
async function nameIsFree(tx: Db, householdId: string, name: string, except?: string): Promise<Category[]> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"abacus.category." + householdId}))`);
  const rows = await tx.select().from(category).where(eq(category.householdId, householdId));
  const same = rows.find((c) => !c.removedAt && c.id !== except && c.label.toLowerCase() === name.toLowerCase());
  if (same) throw new UserError(`there is already a category called "${same.label}"`);
  return rows;
}

// Adds a category. A removed one with the same name or slug comes back under
// the new name instead, so the costs that still have it are under it again.
export async function addCategory(db: Db, actor: Member, label: string): Promise<Category> {
  const name = cleanLabel(label);
  const slug = slugFor(name);
  if (!slug) throw new UserError("a category name needs a letter or a number");
  return db.transaction(async (tx) => {
    const rows = await nameIsFree(tx, actor.householdId, name);
    const old =
      rows.find((c) => c.removedAt && c.label.toLowerCase() === name.toLowerCase()) ?? rows.find((c) => c.slug === slug);
    if (old && !old.removedAt) throw new UserError(`there is already a category called "${old.label}"`);
    const [row] = old
      ? await tx.update(category).set({ label: name, removedAt: null }).where(eq(category.id, old.id)).returning()
      : await tx.insert(category).values({ householdId: actor.householdId, slug, label: name, createdBy: actor.id }).returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "category.added",
      entity: { type: "category", id: row!.id },
      detail: old ? { slug: old.slug, label: name, from: old.label } : { slug, label: name },
    });
    return row!;
  });
}

// Changes what a category is called. Its slug stays, so costs and rules that
// name it are untouched.
export async function renameCategory(db: Db, actor: Member, slug: string, label: string): Promise<Category> {
  const name = cleanLabel(label);
  return db.transaction(async (tx) => {
    const before = await find(tx, actor.householdId, slug);
    if (before.label === name) return before;
    await nameIsFree(tx, actor.householdId, name, before.id);
    const [row] = await tx.update(category).set({ label: name }).where(eq(category.id, before.id)).returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "category.renamed",
      entity: { type: "category", id: before.id },
      detail: { slug, from: before.label, to: name },
    });
    return row!;
  });
}

// Takes a category off the group's list. Costs and rules that already name it
// keep it and show its label; nothing new can pick it.
export async function removeCategory(db: Db, actor: Member, slug: string): Promise<void> {
  if (slug === DEFAULT_CATEGORY) throw new UserError('"Other" cannot be removed: it is what a cost has when nobody picks a category');
  await db.transaction(async (tx) => {
    const before = await find(tx, actor.householdId, slug);
    if (before.removedAt) return;
    await tx.update(category).set({ removedAt: new Date() }).where(eq(category.id, before.id));
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "category.removed",
      entity: { type: "category", id: before.id },
      detail: { slug, label: before.label },
    });
  });
}

const MAX_TAX_LINE = 12;

// Sets where a category goes on the tax form: its line (blank for none) and
// whether it is meals, which count at half. A guide for the year's totals;
// which line a cost belongs on is the filer's call.
export async function setCategoryTax(
  db: Db,
  actor: Member,
  slug: string,
  to: { taxLine: string | null; halfDeductible: boolean },
): Promise<Category> {
  const taxLine = (to.taxLine ?? "").trim() || null;
  if (taxLine && taxLine.length > MAX_TAX_LINE) throw new UserError(`a tax line can be at most ${MAX_TAX_LINE} characters, like "24b"`);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"abacus.category." + actor.householdId}))`);
    const before = await find(tx, actor.householdId, slug);
    if (before.taxLine === taxLine && before.halfDeductible === to.halfDeductible) return before;
    const [row] = await tx.update(category).set({ taxLine, halfDeductible: to.halfDeductible }).where(eq(category.id, before.id)).returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "category.tax_changed",
      entity: { type: "category", id: before.id },
      detail: { slug, from: { taxLine: before.taxLine, halfDeductible: before.halfDeductible }, to: { taxLine, halfDeductible: to.halfDeductible } },
    });
    return row!;
  });
}
