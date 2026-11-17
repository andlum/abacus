import { and, asc, eq, sql } from "drizzle-orm";
import { category, DEFAULT_CATEGORY, type Category, type GroupKind, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";
import { UserError } from "@abacus/core/errors";

type Starter = { slug: string; label: string };

// What a new group starts with, by kind. Short on purpose: a group adds its
// own under Settings. Changing a list here changes new groups only; groups
// that exist keep the rows they have. Every list ends with `other`.
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
    { slug: "software", label: "Software" },
    { slug: "travel", label: "Travel" },
    { slug: "meals", label: "Meals" },
    { slug: "fees", label: "Fees" },
    { slug: DEFAULT_CATEGORY, label: "Other" },
  ],
};

// Gives a new group its starting list. Call it in the transaction that
// creates the group: a cost cannot be saved in a group with no categories.
export async function seedCategories(db: Db, householdId: string, kind: GroupKind): Promise<void> {
  await db
    .insert(category)
    .values(DEFAULT_CATEGORIES[kind].map((c) => ({ householdId, slug: c.slug, label: c.label })))
    .onConflictDoNothing();
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
