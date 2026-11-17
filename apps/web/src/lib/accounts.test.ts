import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { account, expense, household, member, type Member } from "@/db/schema";
import { recentAudit } from "./audit";
import {
  accountLabel,
  addAccount,
  listAccounts,
  renameAccount,
  setAccountArchived,
  setAccountKind,
  toAccountId,
} from "./accounts";
import { seedCategories } from "./categories";
import { createExpense, editExpense, postDue } from "./expenses";
import { createTemplate, editTemplate } from "./templates";
import { createWorld, type World } from "./testing/world";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

// Alex's one-person business, alongside the household Alex shares with Sam.
async function studio(): Promise<{ id: string; alex: Member }> {
  const [biz] = await w.db.insert(household).values({ name: "Alex Studio", kind: "business" }).returning();
  await seedCategories(w.db, biz!.id, "business");
  const [alex] = await w.db
    .insert(member)
    .values({ householdId: biz!.id, email: "alex@example.com", displayName: "Alex", linkedAt: new Date() })
    .returning();
  return { id: biz!.id, alex: alex! };
}

const actions = async (householdId = w.householdId, n = 10) =>
  (await recentAudit(w.db, householdId, n)).map((a) => a.action);

const spend = (accountId: string | null | undefined, actor: Member = w.alex, householdId = w.householdId) =>
  createExpense(w.db, householdId, {
    kind: "manual",
    actor,
    description: "Design tool, annual plan",
    totalCents: 10000,
    date: "2026-11-01",
    payerId: actor.id,
    accountId,
    today: "2026-11-05",
  });

describe("a group's accounts", () => {
  it("adds one with a name and last four digits, audited without the name", async () => {
    const card = await addAccount(w.db, w.alex, { name: "  Joint   card ", lastFour: "4242" });
    expect(card).toMatchObject({ householdId: w.householdId, name: "Joint card", lastFour: "4242", kind: null, archivedAt: null });
    expect(accountLabel(card)).toBe("Joint card ··4242");
    const [entry] = await recentAudit(w.db, w.householdId, 1);
    expect(entry).toMatchObject({ action: "account.added", entityType: "account", entityId: card.id });
    expect(JSON.stringify(entry!.detail)).not.toContain("Joint");
    expect(JSON.stringify(entry!.detail)).not.toContain("4242");
  });

  it("refuses a bad name or bad digits", async () => {
    await expect(addAccount(w.db, w.alex, { name: "   " })).rejects.toThrow("give the account a name");
    await expect(addAccount(w.db, w.alex, { name: "x".repeat(61) })).rejects.toThrow("too long");
    await expect(addAccount(w.db, w.alex, { name: "Card\tone" })).rejects.toThrow("control characters");
    await expect(addAccount(w.db, w.alex, { name: "Card\u202e1" })).rejects.toThrow("invisible characters");
    await expect(addAccount(w.db, w.alex, { name: "Card", lastFour: "42" })).rejects.toThrow("four digits");
    await expect(addAccount(w.db, w.alex, { name: "Card", lastFour: "4242 4242" })).rejects.toThrow("four digits");
    expect(await addAccount(w.db, w.alex, { name: "x".repeat(60), lastFour: " " })).toMatchObject({ lastFour: null });
  });

  it("refuses a name another account in use has, however it is typed, in the app and in the database", async () => {
    const card = await addAccount(w.db, w.alex, { name: "Joint card" });
    await expect(addAccount(w.db, w.alex, { name: "JOINT  card" })).rejects.toThrow('there is already an account called "Joint card"');
    const cash = await addAccount(w.db, w.alex, { name: "Cash" });
    await expect(renameAccount(w.db, w.alex, cash.id, { name: "joint card" })).rejects.toThrow("already an account");
    await expect(
      w.db.insert(account).values({ householdId: w.householdId, name: "joint CARD", createdBy: w.alex.id }),
    ).rejects.toThrow();
    // Its own name, typed differently, is not a clash.
    expect(await renameAccount(w.db, w.alex, card.id, { name: "JOINT CARD" })).toMatchObject({ name: "JOINT CARD" });
  });

  it("folds every run of spaces, no-break and wide ones included, into one space, so two names cannot only look alike", async () => {
    const card = await addAccount(w.db, w.alex, { name: " Joint   card　" });
    expect(card.name).toBe("Joint card");
    await expect(addAccount(w.db, w.alex, { name: "Joint card" })).rejects.toThrow("already an account");
    const cash = await addAccount(w.db, w.alex, { name: "Cash" });
    expect(await renameAccount(w.db, w.alex, cash.id, { name: "Cash  box " })).toMatchObject({ name: "Cash box" });
  });

  it("renames one, or changes its digits, without touching the costs paid from it", async () => {
    const card = await addAccount(w.db, w.alex, { name: "Card", lastFour: "1111" });
    const e = await spend(card.id);
    const renamed = await renameAccount(w.db, w.alex, card.id, { name: "Old card", lastFour: "2222" });
    expect(renamed).toMatchObject({ id: card.id, name: "Old card", lastFour: "2222" });
    const [row] = await w.db.select().from(expense).where(eq(expense.id, e.id));
    expect(row!.accountId).toBe(card.id);
    const [entry] = await recentAudit(w.db, w.householdId, 1);
    expect(entry).toMatchObject({ action: "account.renamed", entityId: card.id, detail: { fields: ["lastFour", "name"] } });
    // Saving it unchanged writes nothing.
    await renameAccount(w.db, w.alex, card.id, { name: "Old card", lastFour: "2222" });
    expect((await recentAudit(w.db, w.householdId, 1))[0]!.id).toBe(entry!.id);
  });

  it("archives one: off the list, still on old costs, and restorable while its name is free", async () => {
    const card = await addAccount(w.db, w.alex, { name: "Card" });
    await setAccountArchived(w.db, w.alex, card.id, true);
    expect(await listAccounts(w.db, w.householdId)).toEqual([]);
    expect((await listAccounts(w.db, w.householdId, { archived: true })).map((a) => a.id)).toEqual([card.id]);

    // The name is free again while it is archived; then restoring clashes.
    const second = await addAccount(w.db, w.alex, { name: "card" });
    await expect(setAccountArchived(w.db, w.alex, card.id, false)).rejects.toThrow('there is already an account called "card"');
    await setAccountArchived(w.db, w.alex, second.id, true);
    await setAccountArchived(w.db, w.alex, card.id, false);
    expect((await listAccounts(w.db, w.householdId)).map((a) => a.id)).toEqual([card.id]);
    expect(await actions()).toEqual(expect.arrayContaining(["account.archived", "account.restored"]));
    // Archiving twice is no change, and writes nothing.
    const before = (await recentAudit(w.db, w.householdId, 1))[0]!.id;
    await setAccountArchived(w.db, w.alex, card.id, false);
    expect((await recentAudit(w.db, w.householdId, 1))[0]!.id).toBe(before);
  });

  it("refuses an account id of another group, or none at all", async () => {
    const biz = await studio();
    const theirs = await addAccount(w.db, biz.alex, { name: "Business card", kind: "business" });
    await expect(renameAccount(w.db, w.alex, theirs.id, { name: "Mine" })).rejects.toThrow("not in this group");
    await expect(setAccountArchived(w.db, w.alex, theirs.id, true)).rejects.toThrow("not in this group");
    await expect(setAccountArchived(w.db, w.alex, "nope", true)).rejects.toThrow("not in this group");
  });

  it("keeps two groups' accounts apart", async () => {
    const biz = await studio();
    await addAccount(w.db, w.alex, { name: "Joint card" });
    // The same name in another group is no clash.
    await addAccount(w.db, biz.alex, { name: "Joint card", kind: "personal" });
    await addAccount(w.db, biz.alex, { name: "Business card", kind: "business" });
    expect((await listAccounts(w.db, w.householdId)).map((a) => a.name)).toEqual(["Joint card"]);
    expect((await listAccounts(w.db, biz.id)).map((a) => a.name)).toEqual(["Business card", "Joint card"]);
  });
});

describe("an account's kind", () => {
  it("is required in a business group, and can be changed later, audited", async () => {
    const biz = await studio();
    await expect(addAccount(w.db, biz.alex, { name: "Visa" })).rejects.toThrow("personal or business");
    await expect(addAccount(w.db, biz.alex, { name: "Visa", kind: "company" })).rejects.toThrow("personal or business");
    const visa = await addAccount(w.db, biz.alex, { name: "Visa", kind: "personal" });
    expect(visa.kind).toBe("personal");
    const changed = await setAccountKind(w.db, biz.alex, visa.id, "business");
    expect(changed.kind).toBe("business");
    const [entry] = await recentAudit(w.db, biz.id, 1);
    expect(entry).toMatchObject({ action: "account.kind_changed", entityId: visa.id, detail: { from: "personal", to: "business" } });
    await expect(setAccountKind(w.db, biz.alex, visa.id, null)).rejects.toThrow("personal or business");
  });

  it("is refused in a household", async () => {
    await expect(addAccount(w.db, w.alex, { name: "Card", kind: "business" })).rejects.toThrow("no kind");
    const card = await addAccount(w.db, w.alex, { name: "Card", kind: "" });
    await expect(setAccountKind(w.db, w.alex, card.id, "personal")).rejects.toThrow("no kind");
  });

  it("filters a group's accounts", async () => {
    const biz = await studio();
    const visa = await addAccount(w.db, biz.alex, { name: "Visa", kind: "personal" });
    await addAccount(w.db, biz.alex, { name: "Amex", kind: "business" });
    expect((await listAccounts(w.db, biz.id, { kind: "personal" })).map((a) => a.id)).toEqual([visa.id]);
  });

  it("cannot change once an expense of any status or a recurring cost uses the account", async () => {
    const biz = await studio();
    const refused = "this account is already in use. Archive it and add a new one instead";
    const visa = await addAccount(w.db, biz.alex, { name: "Visa", kind: "personal" });
    const e = await spend(visa.id, biz.alex, biz.id);
    await expect(setAccountKind(w.db, biz.alex, visa.id, "business")).rejects.toThrow(refused);
    await editExpense(w.db, biz.alex, e.id, { date: e.date, description: "Design tool", totalCents: 10000, payerId: biz.alex.id, accountId: "" }, "2026-11-05");
    // The replaced version still names it.
    await expect(setAccountKind(w.db, biz.alex, visa.id, "business")).rejects.toThrow(refused);

    const amex = await addAccount(w.db, biz.alex, { name: "Amex", kind: "business" });
    await createTemplate(w.db, biz.alex, {
      name: "Hosting",
      amountCents: 2000,
      cadence: "monthly",
      dayOfMonth: 28,
      payerId: biz.alex.id,
      accountId: amex.id,
      startDate: "2026-12-01",
    });
    await expect(setAccountKind(w.db, biz.alex, amex.id, "personal")).rejects.toThrow(refused);
    expect((await listAccounts(w.db, biz.id)).map((a) => a.kind).sort()).toEqual(["business", "personal"]);
    // Saying the same kind again is no change, and allowed.
    await expect(setAccountKind(w.db, biz.alex, visa.id, "personal")).resolves.toMatchObject({ kind: "personal" });
  });
});

describe("an expense's account", () => {
  it("is kept on the expense, and recorded by id in its audit entry", async () => {
    const card = await addAccount(w.db, w.alex, { name: "Card" });
    const e = await spend(card.id);
    expect(e.accountId).toBe(card.id);
    const [entry] = await recentAudit(w.db, w.householdId, 1);
    expect(entry).toMatchObject({ action: "expense.posted", detail: { accountId: card.id } });
    expect((await spend(null)).accountId).toBeNull();
    expect((await spend("")).accountId).toBeNull();
  });

  it("must be one of the group's, in the app and in the database", async () => {
    const biz = await studio();
    const theirs = await addAccount(w.db, biz.alex, { name: "Business card", kind: "business" });
    await expect(spend(theirs.id)).rejects.toThrow("choose an account from the list");
    await expect(spend("not-an-id")).rejects.toThrow("choose an account from the list");
    expect(await toAccountId(w.db, biz.id, theirs.id)).toBe(theirs.id);
    const mine = await spend(null);
    await expect(w.db.update(expense).set({ accountId: theirs.id }).where(eq(expense.id, mine.id))).rejects.toThrow();
  });

  it("cannot be an archived account for a new expense, but stays on an edit of an old one", async () => {
    const card = await addAccount(w.db, w.alex, { name: "Card" });
    const old = await spend(card.id);
    await setAccountArchived(w.db, w.alex, card.id, true);
    await expect(spend(card.id)).rejects.toThrow("archived");
    const edit = { date: old.date, description: "Design tool", totalCents: 12000, payerId: w.alex.id };
    // Left out, the edit keeps it; given again, it is still allowed.
    const kept = await editExpense(w.db, w.alex, old.id, edit, "2026-11-05");
    expect(kept).toMatchObject({ accountId: card.id, supersedesId: old.id });
    const again = await editExpense(w.db, w.alex, kept.id, { ...edit, accountId: card.id }, "2026-11-05");
    expect(again.accountId).toBe(card.id);
    // Moving it off the archived account is fine; moving it back is not.
    const cleared = await editExpense(w.db, w.alex, again.id, { ...edit, accountId: "" }, "2026-11-05");
    expect(cleared.accountId).toBeNull();
    await expect(editExpense(w.db, w.alex, cleared.id, { ...edit, accountId: card.id }, "2026-11-05")).rejects.toThrow("archived");
  });
});

describe("the account carried forward", () => {
  it("goes from a recurring cost to each expense it posts, and survives a later version", async () => {
    const card = await addAccount(w.db, w.alex, { name: "Card" });
    const rent = await createTemplate(w.db, w.alex, {
      name: "Rent",
      amountCents: 200000,
      cadence: "monthly",
      dayOfMonth: 1,
      payerId: w.alex.id,
      accountId: card.id,
      startDate: "2026-10-01",
    });
    expect(rent.accountId).toBe(card.id);
    const [posted] = await postDue(w.db, w.householdId, "2026-10-05");
    expect(posted).toMatchObject({ templateLineageId: rent.lineageId, accountId: card.id });
    const [entry] = await recentAudit(w.db, w.householdId, 1);
    expect(entry).toMatchObject({ action: "expense.posted", detail: { accountId: card.id } });

    // Archived since, a new version that leaves the account alone keeps it.
    await setAccountArchived(w.db, w.alex, card.id, true);
    const later = await editTemplate(w.db, w.alex, rent.lineageId, { amountCents: 210000 }, "2026-11-01", "2026-10-05");
    expect(later.accountId).toBe(card.id);
    await expect(
      editTemplate(w.db, w.alex, rent.lineageId, { accountId: "" }, "2026-11-01", "2026-10-05"),
    ).resolves.toMatchObject({ accountId: null });
  });

  it("is refused on a recurring cost when archived or another group's", async () => {
    const card = await addAccount(w.db, w.alex, { name: "Card" });
    await setAccountArchived(w.db, w.alex, card.id, true);
    const rent = { name: "Rent", amountCents: 200000, cadence: "monthly" as const, dayOfMonth: 1, payerId: w.alex.id, startDate: "2026-10-01" };
    await expect(createTemplate(w.db, w.alex, { ...rent, accountId: card.id })).rejects.toThrow("archived");
    await expect(createTemplate(w.db, w.alex, { ...rent, accountId: "nope" })).rejects.toThrow("choose an account");
  });
});
