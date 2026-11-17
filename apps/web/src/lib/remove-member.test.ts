import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, authSession, bankConnection, authUser, expense, member } from "@/db/schema";
import { createWorld, type World } from "./testing/world";
import { createExpense, editExpense, postDue } from "./expenses";
import { createTemplate } from "./templates";
import { recordSettlement } from "./balance";
import { disconnectBanksOf } from "./bank";
import { createApiToken, memberForToken } from "./api-tokens";
import { authenticateMcpToken, createMcpToken } from "./mcp-tokens";
import { acceptInvitation, invitationsFor, pendingInvites, reinvite, removeMember, resolveMemberships } from "./membership";
import { createTestDb } from "@/db/test-db";
import { household } from "@/db/schema";

const samSignsIn = { authUserId: "user_sam", verifiedEmails: ["sam@example.com"] };
const now = new Date("2026-11-20T12:00:00Z");
const groceries = (date: string) => ({
  kind: "manual" as const,
  date,
  description: "Groceries",
  category: "groceries",
  totalCents: 9000,
  today: "2026-11-30",
});

let w: World;
beforeEach(async () => {
  w = await createWorld();
  // Sam has an account, a session, a device token and an agent token.
  await w.db.insert(authUser).values({ id: "user_sam", name: "Sam", email: "sam@example.com", emailVerified: true });
  await w.db.insert(authSession).values([
    { id: "s1", userId: "user_sam", token: "t1", expiresAt: new Date("2027-01-01") },
    { id: "s2", userId: "user_sam", token: "t2", expiresAt: new Date("2027-01-01") },
  ]);
  await w.db.update(member).set({ authUserId: "user_sam", linkedAt: new Date("2026-01-01") }).where(eq(member.id, w.sam.id));
});

const tokens = async () => ({
  device: (await createApiToken(w.db, w.sam, "phone")).token,
  agent: (await createMcpToken(w.db, w.sam, { name: "bot" })).token,
});

describe("removing a member", () => {
  it("stops sign-in, device tokens and agent tokens, and ends their sessions", async () => {
    const t = await tokens();
    expect(await resolveMemberships(w.db, samSignsIn)).toHaveLength(1);
    expect(await memberForToken(w.db, t.device)).not.toBeNull();

    await removeMember(w.db, w.alex, w.sam.id, now);

    expect(await resolveMemberships(w.db, samSignsIn)).toEqual([]);
    expect(await memberForToken(w.db, t.device)).toBeNull();
    expect(await authenticateMcpToken(w.db, t.agent)).toBeNull();
    expect(await w.db.select().from(authSession).where(eq(authSession.userId, "user_sam"))).toEqual([]);
    const [row] = await w.db.select().from(member).where(eq(member.id, w.sam.id));
    expect(row).toMatchObject({ removedBy: w.alex.id, isDefault: false });
    expect(row!.removedAt).toEqual(now);
  });

  it("is not undone by a fresh verified sign-in, and writes no link-rejected entries", async () => {
    await removeMember(w.db, w.alex, w.sam.id, now);
    expect(await resolveMemberships(w.db, samSignsIn)).toEqual([]);
    expect(await invitationsFor(w.db, samSignsIn)).toEqual([]);
    const other = { authUserId: "user_new", verifiedEmails: ["sam@example.com"] };
    expect(await resolveMemberships(w.db, other)).toEqual([]);
    expect(await invitationsFor(w.db, other)).toEqual([]);
    const rejected = (await w.db.select().from(auditLog)).filter((e) => e.action === "member.link_rejected");
    expect(rejected).toEqual([]);
  });

  it("changes only access: Sam still counts in splits, new costs, recurring costs and payments", async () => {
    const before = await createExpense(w.db, w.householdId, { ...groceries("2026-11-10"), actor: w.alex, payerId: w.sam.id });
    await removeMember(w.db, w.alex, w.sam.id, now);
    const [kept] = await w.db.select().from(expense).where(eq(expense.id, before.id));
    expect(kept).toMatchObject({ payerId: w.sam.id, totalCents: 9000 });
    const [row] = await w.db.select().from(member).where(eq(member.id, w.sam.id));
    expect(row!.sharesFrom).toBe("1970-01-01");

    // A 60/40 cost after removal splits normally and can be paid by Sam.
    const rule = { kind: "percent" as const, bp: { [w.alex.id]: 6000, [w.sam.id]: 4000 } };
    const added = await createExpense(w.db, w.householdId, { ...groceries("2026-11-21"), actor: w.alex, payerId: w.sam.id, rule });
    expect(added.shares).toEqual({ [w.alex.id]: 5400, [w.sam.id]: 3600 });

    // Sam's recurring cost posts with normal shares.
    await createTemplate(w.db, w.alex, { name: "Rent", amountCents: 200000, cadence: "monthly", dayOfMonth: 1, payerId: w.sam.id, startDate: "2026-12-01" });
    const [posted] = await postDue(w.db, w.householdId, "2026-12-02");
    expect(posted).toMatchObject({ payerId: w.sam.id });
    expect(posted!.shares).toEqual({ [w.alex.id]: 100000, [w.sam.id]: 100000 });

    // A payment to or from Sam after removal is accepted.
    await expect(
      recordSettlement(w.db, w.alex, { fromMemberId: w.alex.id, toMemberId: w.sam.id, amountCents: 1000, date: "2026-11-25" }, "2026-11-25"),
    ).resolves.toBeTruthy();
  });

  it("disconnects their bank connections even when Plaid is not set up", async () => {
    const [c] = await w.db
      .insert(bankConnection)
      .values({ householdId: w.householdId, ownerId: w.sam.id, itemId: "item_1", accessToken: "sealed", institutionName: "Test Bank", syncFrom: "2026-11-01" })
      .returning();
    const gone = await removeMember(w.db, w.alex, w.sam.id, now);
    await disconnectBanksOf(w.db, null, w.alex, gone);
    const [after] = await w.db.select().from(bankConnection).where(eq(bankConnection.id, c!.id));
    expect(after).toMatchObject({ accessToken: null });
    expect(after!.removedAt).toBeInstanceOf(Date);
  });

  it("keeps an existing sharesFrom through re-invite and accept, so old costs stay 50/50", async () => {
    const e = await createExpense(w.db, w.householdId, { ...groceries("2026-11-10"), actor: w.alex, payerId: w.alex.id });
    await removeMember(w.db, w.alex, w.sam.id, now);
    await reinvite(w.db, w.alex, w.sam.id, "sam@example.com");
    const back = await acceptInvitation(w.db, samSignsIn, w.sam.id, new Date("2026-12-01T12:00:00Z"));
    expect(back.sharesFrom).toBe("1970-01-01");
    const { kind: _k, today: _t, ...edit } = groceries("2026-11-10");
    const edited = await editExpense(w.db, w.alex, e.id, { ...edit, payerId: w.alex.id, description: "More groceries" }, "2026-12-02");
    expect(edited.shares).toEqual({ [w.alex.id]: 4500, [w.sam.id]: 4500 });
  });

  it("writes an audit entry by the person who removed them", async () => {
    await removeMember(w.db, w.alex, w.sam.id, now);
    const entries = (await w.db.select().from(auditLog)).filter((e) => e.action === "member.removed");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorMemberId: w.alex.id, entityId: w.sam.id, householdId: w.householdId });
  });

  it("revokes their tokens in the audit trail too", async () => {
    await tokens();
    await removeMember(w.db, w.alex, w.sam.id, now);
    const actions = (await w.db.select().from(auditLog)).map((e) => e.action);
    expect(actions).toContain("api_token.revoked");
    expect(actions).toContain("mcp_token.revoked");
  });

  it("refuses removing yourself, someone in another group, and someone already removed", async () => {
    await expect(removeMember(w.db, w.alex, w.alex.id, now)).rejects.toThrow("cannot remove yourself");
    const [other] = await w.db.insert(household).values({ name: "Other" }).returning();
    const [stranger] = await w.db.insert(member).values({ householdId: other!.id, email: "kim@example.com", displayName: "Kim" }).returning();
    await expect(removeMember(w.db, w.alex, stranger!.id, now)).rejects.toThrow("no one in this group");
    await removeMember(w.db, w.alex, w.sam.id, now);
    await expect(removeMember(w.db, w.alex, w.sam.id, now)).rejects.toThrow("no one in this group");
  });

  it("refuses someone who has not joined, whose invite is cancelled instead", async () => {
    await w.db.update(member).set({ authUserId: null, linkedAt: null }).where(eq(member.id, w.sam.id));
    await expect(removeMember(w.db, w.alex, w.sam.id, now)).rejects.toThrow("has not joined");
  });

  it("lets them in again once invited again, on the same row, with the old tokens still dead", async () => {
    const t = await tokens();
    await removeMember(w.db, w.alex, w.sam.id, now);
    expect(pendingInvites(await w.db.select().from(member), "UTC").map((i) => i.id)).not.toContain(w.sam.id);

    const row = await reinvite(w.db, w.alex, w.sam.id, "sam@example.com");
    expect(row).toMatchObject({ id: w.sam.id, removedAt: null, removedBy: null, authUserId: null, sharesFrom: "1970-01-01" });

    const [inv] = await invitationsFor(w.db, samSignsIn);
    expect(inv!.memberId).toBe(w.sam.id);
    await acceptInvitation(w.db, samSignsIn, w.sam.id, now);
    const [back] = await resolveMemberships(w.db, samSignsIn);
    expect(back!.id).toBe(w.sam.id);
    expect(await memberForToken(w.db, t.device)).toBeNull();
    expect(await authenticateMcpToken(w.db, t.agent)).toBeNull();
  });
});

describe("a group of one", () => {
  it("has nobody else to remove", async () => {
    const db = await createTestDb();
    const [h] = await db.insert(household).values({ name: "Solo" }).returning();
    const [a] = await db.insert(member).values({ householdId: h!.id, email: "alex@example.com", displayName: "Alex" }).returning();
    await expect(removeMember(db, a!, a!.id, now)).rejects.toThrow("cannot remove yourself");
  });
});
