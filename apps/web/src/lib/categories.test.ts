import { beforeEach, describe, expect, it } from "vitest";
import { category, DEFAULT_CATEGORY, household } from "@/db/schema";
import { recentAudit } from "./audit";
import {
  addCategory,
  DEFAULT_CATEGORIES,
  listCategories,
  renameCategory,
  removeCategory,
  seedCategories,
  slugFor,
  toCategory,
} from "./categories";
import { createExpense, listMonth } from "./expenses";
import { createWorld, type World } from "./testing/world";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

const slugs = async (householdId = w.householdId, removed = false) =>
  (await listCategories(w.db, householdId, { removed })).map((c) => c.slug);

const spend = (categoryText: string) =>
  createExpense(w.db, w.householdId, {
    kind: "manual",
    actor: w.alex,
    description: "Something",
    category: categoryText,
    totalCents: 1000,
    date: "2026-11-01",
    payerId: w.alex.id,
    today: "2026-11-05",
  });

describe("starting lists", () => {
  it("are short, differ by kind, and both have other", () => {
    expect(DEFAULT_CATEGORIES.household.map((c) => c.label)).toEqual([
      "Housing",
      "Utilities",
      "Groceries",
      "Dining out",
      "Subscriptions",
      "Other",
    ]);
    expect(DEFAULT_CATEGORIES.business.map((c) => c.label)).toEqual([
      "Advertising",
      "Car and truck",
      "Commissions and fees",
      "Contract labor",
      "Insurance",
      "Legal and professional",
      "Office expense",
      "Rent",
      "Repairs",
      "Supplies",
      "Taxes and licenses",
      "Travel",
      "Meals",
      "Utilities",
      "Software and subscriptions",
      "Other",
    ]);
    for (const list of Object.values(DEFAULT_CATEGORIES)) {
      expect(list.at(-1)!.slug).toBe(DEFAULT_CATEGORY);
      expect(list.every((c) => slugFor(c.slug) === c.slug)).toBe(true);
    }
    expect(DEFAULT_CATEGORIES.business.map((c) => c.slug)).toContain("software");
    expect(DEFAULT_CATEGORIES.household.map((c) => c.slug)).not.toContain("software");
  });

  it("give a business its own list, and seeding twice changes nothing", async () => {
    const [shop] = await w.db.insert(household).values({ name: "Corner Bakery", kind: "business" }).returning();
    await seedCategories(w.db, shop!.id, "business");
    await seedCategories(w.db, shop!.id, "business");
    expect((await slugs(shop!.id)).sort()).toEqual(DEFAULT_CATEGORIES.business.map((c) => c.slug).sort());
  });

  it("list other last", async () => {
    expect((await slugs()).at(-1)).toBe(DEFAULT_CATEGORY);
  });
});

describe("a group's own categories", () => {
  it("adds one, which a cost can then use", async () => {
    await expect(spend("Pet care")).rejects.toThrow("choose a category from the list");
    const made = await addCategory(w.db, w.alex, "  Pet   care ");
    expect(made).toMatchObject({ slug: "pet_care", label: "Pet care", createdBy: w.alex.id });
    await spend("pet_care");
    expect((await listMonth(w.db, w.householdId, "2026-11"))[0]!.category).toBe("pet_care");
    expect((await recentAudit(w.db, w.householdId, 5)).map((a) => a.action)).toContain("category.added");
  });

  it("refuses a second one of the same name, a blank one, and one with no letters", async () => {
    await expect(addCategory(w.db, w.alex, "groceries")).rejects.toThrow('there is already a category called "Groceries"');
    await expect(addCategory(w.db, w.alex, "   ")).rejects.toThrow("give the category a name");
    await expect(addCategory(w.db, w.alex, "!!!")).rejects.toThrow("needs a letter or a number");
    await expect(addCategory(w.db, w.alex, "x".repeat(41))).rejects.toThrow("at most 40");
  });

  it("keeps one group's categories out of another", async () => {
    const [shop] = await w.db.insert(household).values({ name: "Corner Bakery", kind: "business" }).returning();
    await seedCategories(w.db, shop!.id, "business");
    await expect(toCategory(w.db, w.householdId, "software")).rejects.toThrow("choose a category from the list");
    expect(await toCategory(w.db, shop!.id, "Software ")).toBe("software");
    await addCategory(w.db, w.alex, "Garden");
    expect(await slugs(shop!.id)).not.toContain("garden");
  });

  it("refuses a name another category already has, however it is typed", async () => {
    // "Dining out" has the slug `dining`, so a slug check alone misses these.
    await expect(addCategory(w.db, w.alex, "dining  OUT")).rejects.toThrow('there is already a category called "Dining out"');
    await expect(renameCategory(w.db, w.alex, "groceries", "Dining Out")).rejects.toThrow(
      'there is already a category called "Dining out"',
    );
    expect(await renameCategory(w.db, w.alex, "groceries", "GROCERIES")).toMatchObject({ label: "GROCERIES" });
  });

  it("renames one without touching the costs that have it", async () => {
    const e = await spend("groceries");
    const renamed = await renameCategory(w.db, w.alex, "groceries", "Food shop");
    expect(renamed).toMatchObject({ slug: "groceries", label: "Food shop" });
    expect((await listMonth(w.db, w.householdId, "2026-11"))[0]).toMatchObject({ id: e.id, category: "groceries" });
    await expect(renameCategory(w.db, w.alex, "nope", "X")).rejects.toThrow("not in this group");
  });

  it("removes one: gone from the list, its name kept on old costs, and a correction may still name it", async () => {
    await spend("dining");
    await removeCategory(w.db, w.alex, "dining");
    expect(await slugs()).not.toContain("dining");
    expect(await slugs(w.householdId, true)).toContain("dining");
    expect((await listMonth(w.db, w.householdId, "2026-11"))[0]!.category).toBe("dining");
    expect(await toCategory(w.db, w.householdId, "dining")).toBe("dining");
    expect((await recentAudit(w.db, w.householdId, 5)).map((a) => a.action)).toContain("category.removed");
    // Removing it again changes nothing.
    await removeCategory(w.db, w.alex, "dining");
    expect((await recentAudit(w.db, w.householdId, 10)).filter((a) => a.action === "category.removed")).toHaveLength(1);
  });

  it("adding a removed name again brings the old one back, so its costs come back with it", async () => {
    await spend("dining");
    await removeCategory(w.db, w.alex, "dining");
    const back = await addCategory(w.db, w.alex, "dining  OUT");
    expect(back).toMatchObject({ slug: "dining", label: "dining OUT", removedAt: null });
    expect(await slugs()).toContain("dining");
    // By slug too: "Dining" is a new name for the same slug.
    await removeCategory(w.db, w.alex, "dining");
    expect(await addCategory(w.db, w.alex, "Dining")).toMatchObject({ slug: "dining", label: "Dining", removedAt: null });
  });

  it("lets a live category take a removed one's name", async () => {
    await removeCategory(w.db, w.alex, "dining");
    expect(await renameCategory(w.db, w.alex, "groceries", "Dining out")).toMatchObject({ slug: "groceries", label: "Dining out" });
    await expect(addCategory(w.db, w.alex, "Dining out")).rejects.toThrow('there is already a category called "Dining out"');
  });

  it("never removes other, in the app or in the database", async () => {
    await expect(removeCategory(w.db, w.alex, DEFAULT_CATEGORY)).rejects.toThrow("cannot be removed");
    await expect(w.db.update(category).set({ removedAt: new Date() })).rejects.toThrow();
    await expect(removeCategory(w.db, w.alex, "nope")).rejects.toThrow("not in this group");
  });

  it("is enforced by the database: a cost cannot name a category its group lacks", async () => {
    const e = await spend("groceries");
    const { expense } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await expect(w.db.update(expense).set({ category: "software" }).where(eq(expense.id, e.id))).rejects.toThrow();
  });
});
