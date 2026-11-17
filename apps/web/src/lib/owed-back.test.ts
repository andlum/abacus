import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { expense, household, member, reimbursement, type Member } from "@/db/schema";
import { addAccount, setAccountArchived } from "./accounts";
import { recentAudit } from "./audit";
import { seedCategories } from "./categories";
import { createExpense, editExpense, voidExpense } from "./expenses";
import { getBalance, recordSettlement, voidSettlement } from "./balance";
import { getOwedBack, listReimbursements, recordReimbursement, voidReimbursement } from "./owed-back";
import { createWorld, type World } from "./testing/world";
import { UserError } from "@abacus/core/errors";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

const today = "2026-11-12";

type Biz = { id: string; alex: Member; sam: Member | null };

// Alex's business, with Sam in it too when asked.
async function business({ withSam = false } = {}): Promise<Biz> {
  const [biz] = await w.db.insert(household).values({ name: "Alex Studio", kind: "business" }).returning();
  await seedCategories(w.db, biz!.id, "business");
  const add = async (name: string) =>
    (
      await w.db
        .insert(member)
        .values({ householdId: biz!.id, email: `${name.toLowerCase()}@example.com`, displayName: name, linkedAt: new Date() })
        .returning()
    )[0]!;
  const alex = await add("Alex");
  const sam = withSam ? await add("Sam") : null;
  return { id: biz!.id, alex, sam };
}

const spend = (b: Biz, payer: Member, totalCents: number, accountId: string | null, over: object = {}) =>
  createExpense(w.db, b.id, {
    kind: "manual",
    actor: payer,
    date: "2026-11-01",
    description: "Design tool",
    totalCents,
    payerId: payer.id,
    accountId,
    today,
    ...over,
  });

// An expense row in a state the app reaches by other flows.
const insertAs = (b: Biz, status: "proposed" | "rejected" | "needs_amount", accountId: string, totalCents: number | null = 5000) =>
  w.db.insert(expense).values({
    householdId: b.id,
    date: "2026-11-01",
    description: "Paper",
    totalCents,
    payerId: b.alex.id,
    status,
    source: "manual",
    accountId,
  });

const repay = (b: Biz, amountCents: number, over: object = {}) =>
  recordReimbursement(w.db, b.alex, { memberId: b.alex.id, amountCents, date: today, ...over }, today);

const figure = async (b: Biz, who: Member) => (await getOwedBack(w.db, b.id))!.members.find((m) => m.memberId === who.id);

describe("what the business owes a member", () => {
  it("adds up the costs each member paid on a personal account, and only those", async () => {
    const b = await business();
    const visa = await addAccount(w.db, b.alex, { name: "Visa", kind: "personal" });
    const amex = await addAccount(w.db, b.alex, { name: "Amex", kind: "business" });
    await spend(b, b.alex, 4000, visa.id);
    await spend(b, b.alex, 1000, visa.id);
    await spend(b, b.alex, 9000, amex.id);
    await spend(b, b.alex, 3000, null);
    expect(await getOwedBack(w.db, b.id)).toEqual({
      members: [{ memberId: b.alex.id, personalPaidCents: 5000, repaidCents: 0, owedCents: 5000 }],
      untaggedCount: 1,
      untaggedCents: 3000,
    });
  });

  it("leaves out voided, replaced, proposed, rejected and waiting expenses, and counts an edit once at its new amount", async () => {
    const b = await business();
    const visa = await addAccount(w.db, b.alex, { name: "Visa", kind: "personal" });
    const gone = await spend(b, b.alex, 7000, visa.id);
    await voidExpense(w.db, b.alex, gone.id);
    await insertAs(b, "proposed", visa.id);
    await insertAs(b, "rejected", visa.id);
    await insertAs(b, "needs_amount", visa.id, null);
    const first = await spend(b, b.alex, 4000, visa.id);
    await editExpense(w.db, b.alex, first.id, { date: first.date, description: "Design tool", totalCents: 4500, payerId: b.alex.id }, today);
    expect(await figure(b, b.alex)).toEqual({ memberId: b.alex.id, personalPaidCents: 4500, repaidCents: 0, owedCents: 4500 });
  });

  it("counts a cost that could not be split: it has an amount and a payer", async () => {
    const b = await business();
    const visa = await addAccount(w.db, b.alex, { name: "Visa", kind: "personal" });
    const stuck = await spend(b, b.alex, 4000, visa.id, { rule: { kind: "income_proportional" } });
    expect(stuck.status).toBe("unassigned");
    const loose = await spend(b, b.alex, 1500, null, { rule: { kind: "income_proportional" } });
    expect(loose.status).toBe("unassigned");
    await insertAs(b, "needs_amount", visa.id, null);
    expect(await getOwedBack(w.db, b.id)).toEqual({
      members: [{ memberId: b.alex.id, personalPaidCents: 4000, repaidCents: 0, owedCents: 4000 }],
      untaggedCount: 1,
      untaggedCents: 1500,
    });
  });

  it("drops a cost moved from a personal account to a business one", async () => {
    const b = await business();
    const visa = await addAccount(w.db, b.alex, { name: "Visa", kind: "personal" });
    const amex = await addAccount(w.db, b.alex, { name: "Amex", kind: "business" });
    const e = await spend(b, b.alex, 4000, visa.id);
    await editExpense(w.db, b.alex, e.id, { date: e.date, description: "Design tool", totalCents: 4000, payerId: b.alex.id, accountId: amex.id }, today);
    expect((await figure(b, b.alex))!.owedCents).toBe(0);
  });

  it("is reduced by repayments, not by voided ones, and goes below zero when repaid too much", async () => {
    const b = await business();
    const visa = await addAccount(w.db, b.alex, { name: "Visa", kind: "personal" });
    await spend(b, b.alex, 10000, visa.id);
    await repay(b, 6000);
    expect((await figure(b, b.alex))!.owedCents).toBe(4000);
    const extra = await repay(b, 3000);
    await voidReimbursement(w.db, b.alex, extra.id);
    expect(await figure(b, b.alex)).toEqual({ memberId: b.alex.id, personalPaidCents: 10000, repaidCents: 6000, owedCents: 4000 });
    await repay(b, 5000);
    expect((await figure(b, b.alex))!.owedCents).toBe(-1000);
  });

  it("keeps each member's figure to the costs they paid and the money they were repaid", async () => {
    const b = await business({ withSam: true });
    const sam = b.sam!;
    const alexCard = await addAccount(w.db, b.alex, { name: "Alex Visa", kind: "personal" });
    const samCard = await addAccount(w.db, b.alex, { name: "Sam Visa", kind: "personal" });
    await spend(b, b.alex, 4000, alexCard.id);
    await spend(b, sam, 2500, samCard.id);
    await recordReimbursement(w.db, b.alex, { memberId: sam.id, amountCents: 1000, date: today }, today);
    const all = (await getOwedBack(w.db, b.id))!.members;
    expect(all).toHaveLength(2);
    expect(all).toContainEqual({ memberId: b.alex.id, personalPaidCents: 4000, repaidCents: 0, owedCents: 4000 });
    expect(all).toContainEqual({ memberId: sam.id, personalPaidCents: 2500, repaidCents: 1000, owedCents: 1500 });
  });

  it("is nothing in a household, which cannot record a repayment", async () => {
    expect(await getOwedBack(w.db, w.householdId)).toBeNull();
    await expect(
      recordReimbursement(w.db, w.alex, { memberId: w.alex.id, amountCents: 100, date: today }, today),
    ).rejects.toThrow("only for a business");
  });
});

// Alex pays 100.00 for Alex and Sam, split evenly.
const evenly = { rule: { kind: "even" } };

describe("what members owe each other in a business", () => {
  it("leaves out a cost paid on a personal account: the business owes it back in full", async () => {
    const b = await business({ withSam: true });
    const sam = b.sam!;
    const visa = await addAccount(w.db, b.alex, { name: "Alex Visa", kind: "personal" });
    const e = await spend(b, b.alex, 10000, visa.id, evenly);
    expect(e.shares).toEqual({ [b.alex.id]: 5000, [sam.id]: 5000 });
    expect(await getBalance(w.db, b.id)).toEqual({ net: { [b.alex.id]: 0, [sam.id]: 0 }, owes: [], entries: [] });
    expect((await figure(b, b.alex))!.owedCents).toBe(10000);
  });

  it("counts a cost on a business account or on none, as before", async () => {
    const b = await business({ withSam: true });
    const sam = b.sam!;
    const card = await addAccount(w.db, b.alex, { name: "Studio card", kind: "business" });
    const onCard = await spend(b, b.alex, 10000, card.id, evenly);
    const onNone = await spend(b, b.alex, 2000, null, evenly);
    const balance = await getBalance(w.db, b.id);
    expect(balance.owes).toEqual([{ from: sam.id, to: b.alex.id, amountCents: 6000 }]);
    expect(balance.entries.map((x) => x.id)).toEqual([onCard.id, onNone.id]);
    expect((await figure(b, b.alex))!.owedCents).toBe(0);
  });

  it("follows the expense when it moves between a personal and a business account", async () => {
    const b = await business({ withSam: true });
    const sam = b.sam!;
    const visa = await addAccount(w.db, b.alex, { name: "Alex Visa", kind: "personal" });
    const card = await addAccount(w.db, b.alex, { name: "Studio card", kind: "business" });
    const e = await spend(b, b.alex, 10000, visa.id, evenly);
    const edit = (accountId: string) =>
      editExpense(w.db, b.alex, e.id, { date: e.date, description: "Design tool", totalCents: 10000, payerId: b.alex.id, accountId, rule: { kind: "even" } }, today);
    const moved = await edit(card.id);
    expect((await getBalance(w.db, b.id)).owes).toEqual([{ from: sam.id, to: b.alex.id, amountCents: 5000 }]);
    expect((await figure(b, b.alex))!.owedCents).toBe(0);
    await editExpense(w.db, b.alex, moved.id, { date: e.date, description: "Design tool", totalCents: 10000, payerId: b.alex.id, accountId: visa.id, rule: { kind: "even" } }, today);
    expect((await getBalance(w.db, b.id)).owes).toEqual([]);
    expect((await figure(b, b.alex))!.owedCents).toBe(10000);
  });
});

describe("recording a repayment", () => {
  it("is kept with who was repaid, the business account and a note, and audited by ids only", async () => {
    const b = await business();
    const amex = await addAccount(w.db, b.alex, { name: "Amex", kind: "business" });
    const r = await repay(b, 6000, { accountId: amex.id, note: "  Bank transfer " });
    expect(r).toMatchObject({ householdId: b.id, memberId: b.alex.id, amountCents: 6000, accountId: amex.id, note: "Bank transfer", status: "recorded", createdBy: b.alex.id });
    const [entry] = await recentAudit(w.db, b.id, 1);
    expect(entry).toMatchObject({ action: "reimbursement.recorded", entityType: "reimbursement", entityId: r.id });
    expect(JSON.stringify(entry!.detail)).not.toContain("Bank");
    expect(JSON.stringify(entry!.detail)).not.toContain("6000");
    expect((await listReimbursements(w.db, b.id)).map((x) => x.id)).toEqual([r.id]);
  });

  it("refuses an id that is not an id as a mistake, not a database error", async () => {
    const b = await business({ withSam: true });
    await expect(repay(b, 100, { memberId: "nope" })).rejects.toThrow(UserError);
    await expect(repay(b, 100, { memberId: "nope" })).rejects.toThrow("must be a member");
    await expect(repay(b, 100, { accountId: "nope" })).rejects.toThrow(UserError);
    await expect(voidReimbursement(w.db, b.alex, "nope")).rejects.toThrow(UserError);
    const settle = (over: object) =>
      recordSettlement(w.db, b.alex, { fromMemberId: b.sam!.id, toMemberId: b.alex.id, amountCents: 100, date: today, ...over }, today);
    await expect(settle({ fromMemberId: "nope" })).rejects.toThrow(UserError);
    await expect(settle({ toMemberId: "nope" })).rejects.toThrow("must be a member");
    await expect(voidSettlement(w.db, b.alex, "nope")).rejects.toThrow(UserError);
    await expect(voidSettlement(w.db, b.alex, "nope")).rejects.toThrow("does not exist or was already voided");
  });

  it("refuses a bad amount, date or note", async () => {
    const b = await business();
    await expect(repay(b, 0)).rejects.toThrow("more than zero");
    await expect(repay(b, 1.5)).rejects.toThrow("more than zero");
    await expect(repay(b, 100, { date: "2026-11-13" })).rejects.toThrow("later than today");
    await expect(repay(b, 100, { date: "Tuesday" })).rejects.toThrow("not a date");
    await expect(repay(b, 100, { note: "Bank\ttransfer" })).rejects.toThrow("control characters");
    await expect(repay(b, 100, { note: "x".repeat(201) })).rejects.toThrow("too long");
  });

  it("refuses another group's member or account, a personal account and an archived one", async () => {
    const b = await business();
    const elsewhere = await addAccount(w.db, w.alex, { name: "Joint card" });
    const visa = await addAccount(w.db, b.alex, { name: "Visa", kind: "personal" });
    const old = await addAccount(w.db, b.alex, { name: "Old Amex", kind: "business" });
    await setAccountArchived(w.db, b.alex, old.id, true);
    await expect(repay(b, 100, { memberId: w.sam.id })).rejects.toThrow("must be a member");
    await expect(repay(b, 100, { accountId: elsewhere.id })).rejects.toThrow("choose an account");
    await expect(repay(b, 100, { accountId: visa.id })).rejects.toThrow("business account");
    await expect(repay(b, 100, { accountId: old.id })).rejects.toThrow("archived");
    expect(await listReimbursements(w.db, b.id)).toEqual([]);
  });

  it("is voided once, kept on record, and audited; another group's id reads as unknown", async () => {
    const b = await business();
    const r = await repay(b, 6000);
    await voidReimbursement(w.db, b.alex, r.id);
    const [row] = await listReimbursements(w.db, b.id);
    expect(row).toMatchObject({ status: "void", voidedBy: b.alex.id });
    expect(row!.voidedAt).toBeInstanceOf(Date);
    const [entry] = await recentAudit(w.db, b.id, 1);
    expect(entry).toMatchObject({ action: "reimbursement.voided", entityType: "reimbursement", entityId: r.id });
    await expect(voidReimbursement(w.db, b.alex, r.id)).rejects.toThrow("does not exist or was already voided");

    const other = await business();
    const theirs = await repay(other, 100);
    const unknown = voidReimbursement(w.db, b.alex, "00000000-0000-4000-8000-000000000000");
    const foreign = voidReimbursement(w.db, b.alex, theirs.id);
    await expect(unknown).rejects.toThrow("does not exist or was already voided");
    await expect(foreign).rejects.toThrow("does not exist or was already voided");
    await expect(voidReimbursement(w.db, b.alex, "nope")).rejects.toThrow("does not exist or was already voided");
    const [still] = await w.db.select().from(reimbursement).where(eq(reimbursement.id, theirs.id));
    expect(still!.status).toBe("recorded");
  });

  it("cannot name another group's account, even in the database", async () => {
    const b = await business();
    const elsewhere = await addAccount(w.db, w.alex, { name: "Joint card" });
    const r = await repay(b, 100);
    await expect(w.db.update(reimbursement).set({ accountId: elsewhere.id }).where(eq(reimbursement.id, r.id))).rejects.toThrow();
  });
});
