import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { household, member } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import type { Db } from "@/db/types";
import { recentAudit } from "./audit";
import {
  acceptInvitation,
  cancelInvite,
  declineInvitation,
  invitationsFor,
  invitedMember,
  pendingInvites,
  reinvite,
  resolveMemberships,
  type SignedInUser,
} from "./membership";

// A person who says yes to every invitation waiting for them, then lands in
// the group they belong to first. Nothing links without that yes.
const resolveMember = async (db: Db, user: SignedInUser) => (await joinAll(db, user))[0] ?? null;
async function joinAll(db: Db, user: SignedInUser) {
  for (const inv of await invitationsFor(db, user)) await acceptInvitation(db, user, inv.memberId);
  return resolveMemberships(db, user);
}

let db: Db;
let householdId: string;

beforeEach(async () => {
  db = await createTestDb();
  const [h] = await db.insert(household).values({ name: "Test household" }).returning();
  householdId = h!.id;
  await db.insert(member).values([
    { householdId, email: "alex@example.com", displayName: "Alex" },
    { householdId, email: "sam@example.com", displayName: "Sam" },
  ]);
});

describe("resolveMember", () => {
  it("links a provisioned member once they accept, with a verified email", async () => {
    const m = await resolveMember(db, { authUserId: "user_alex", verifiedEmails: ["alex@example.com"] });

    expect(m).toMatchObject({ displayName: "Alex", authUserId: "user_alex", householdId });
    expect(m!.linkedAt).toBeInstanceOf(Date);
  });

  it("writes one audit entry for the link, and none on later sign-ins", async () => {
    const first = await resolveMember(db, { authUserId: "user_alex", verifiedEmails: ["alex@example.com"] });
    const again = await resolveMember(db, { authUserId: "user_alex", verifiedEmails: ["alex@example.com"] });

    expect(again!.id).toBe(first!.id);
    const entries = await recentAudit(db, householdId, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "member.linked",
      actorKind: "member",
      actorMemberId: first!.id,
      entityType: "member",
      entityId: first!.id,
    });
  });

  it("matches email case-insensitively", async () => {
    const m = await resolveMember(db, { authUserId: "user_alex", verifiedEmails: ["Alex@Example.com"] });
    expect(m?.displayName).toBe("Alex");
  });

  it("recognises a linked member even after their email changes", async () => {
    await resolveMember(db, { authUserId: "user_alex", verifiedEmails: ["alex@example.com"] });
    const m = await resolveMember(db, { authUserId: "user_alex", verifiedEmails: ["new@example.com"] });
    expect(m?.displayName).toBe("Alex");
  });

  it("returns null for someone who was not provisioned, and links nothing", async () => {
    const m = await resolveMember(db, { authUserId: "user_stranger", verifiedEmails: ["stranger@example.com"] });

    expect(m).toBeNull();
    const rows = await db.select().from(member);
    expect(rows.every((r) => r.authUserId === null)).toBe(true);
  });

  it("returns null when there is no verified email", async () => {
    expect(await resolveMember(db, { authUserId: "user_x", verifiedEmails: [] })).toBeNull();
  });

  it("refuses a second auth account claiming an already-linked email, and records the attempt", async () => {
    const alex = await resolveMember(db, { authUserId: "user_alex", verifiedEmails: ["alex@example.com"] });
    const imposter = await resolveMember(db, { authUserId: "user_other", verifiedEmails: ["alex@example.com"] });

    expect(imposter).toBeNull();
    const [row] = await db.select().from(member).where(eq(member.id, alex!.id));
    expect(row!.authUserId).toBe("user_alex");
    const entries = await recentAudit(db, householdId, 10);
    expect(entries[0]).toMatchObject({
      action: "member.link_rejected",
      actorKind: "system",
      entityType: "member",
      entityId: alex!.id,
    });
  });

  it("keeps the two partners separate", async () => {
    const alex = await resolveMember(db, { authUserId: "user_alex", verifiedEmails: ["alex@example.com"] });
    const sam = await resolveMember(db, { authUserId: "user_sam", verifiedEmails: ["sam@example.com"] });

    expect(alex!.id).not.toBe(sam!.id);
    expect(sam!.householdId).toBe(alex!.householdId);
  });
});

describe("resolveMemberships, for someone in several groups", () => {
  const alex = { authUserId: "user_alex", verifiedEmails: ["alex@example.com"] };

  async function secondGroup() {
    const [h] = await db.insert(household).values({ name: "Corner Bakery", kind: "business" }).returning();
    await db.insert(member).values({ householdId: h!.id, email: "alex@example.com", displayName: "Alex" });
    return h!.id;
  }

  it("lists every group the person accepted, oldest first", async () => {
    const bakery = await secondGroup();
    const mine = await joinAll(db, alex);

    expect(mine.map((m) => m.householdId)).toEqual([householdId, bakery]);
    expect(mine.every((m) => m.authUserId === "user_alex")).toBe(true);
  });

  it("picks up an invitation that arrives after the first one was accepted", async () => {
    await joinAll(db, alex);
    const bakery = await secondGroup();
    const mine = await joinAll(db, alex);

    expect(mine.map((m) => m.householdId)).toEqual([householdId, bakery]);
    expect((await recentAudit(db, bakery, 10)).map((e) => e.action)).toEqual(["member.linked"]);
  });

  it("does not hand an invitation to a different account with the same email", async () => {
    await joinAll(db, alex);
    const bakery = await secondGroup();
    // The bakery row is unlinked, but the address already belongs to user_alex.
    const other = { authUserId: "user_other", verifiedEmails: ["alex@example.com"] };
    const imposter = await joinAll(db, other);

    expect(imposter).toEqual([]);
    await expect(acceptInvitation(db, other, (await db.select().from(member).where(eq(member.householdId, bakery)))[0]!.id)).rejects.toThrow(
      "no invitation",
    );
    const [row] = await db.select().from(member).where(eq(member.householdId, bakery));
    expect(row!.authUserId).toBeNull();
  });
});

describe("invitations need an explicit yes", () => {
  const alex = { authUserId: "user_alex", verifiedEmails: ["alex@example.com"] };
  const sam = { authUserId: "user_sam", verifiedEmails: ["sam@example.com"] };
  const rowFor = async (email: string, hid = householdId) =>
    (await db.select().from(member).where(and(eq(member.email, email), eq(member.householdId, hid))))[0]!;
  async function bakeryInvitesAlex() {
    const [h] = await db.insert(household).values({ name: "Corner Bakery", kind: "business" }).returning();
    await db.insert(member).values([
      { householdId: h!.id, email: "lee@example.com", displayName: "Lee" },
      { householdId: h!.id, email: "alex@example.com", displayName: "Al" },
    ]);
    return h!.id;
  }

  it("a verified sign-in with an invitation waiting is not a member until they accept", async () => {
    expect(await resolveMemberships(db, alex)).toEqual([]);
    expect((await rowFor("alex@example.com")).authUserId).toBeNull();
    expect(await recentAudit(db, householdId, 10)).toEqual([]);

    const [inv] = await invitationsFor(db, alex);
    expect(inv).toMatchObject({ memberId: (await rowFor("alex@example.com")).id, displayName: "Alex", householdName: "Test household" });
  });

  it("describes the group and who is already in it", async () => {
    await joinAll(db, sam);
    expect(await invitationsFor(db, alex)).toEqual([
      {
        memberId: expect.any(String),
        displayName: "Alex",
        householdId,
        householdName: "Test household",
        kind: "household",
        members: ["Sam"],
      },
    ]);
  });

  it("accepting links only that row and audits it", async () => {
    const bakery = await bakeryInvitesAlex();
    const mine = await rowFor("alex@example.com", bakery);
    const m = await acceptInvitation(db, alex, mine.id);

    expect(m).toMatchObject({ id: mine.id, authUserId: "user_alex" });
    expect(m.linkedAt).toBeInstanceOf(Date);
    expect((await rowFor("alex@example.com")).authUserId).toBeNull();
    expect((await resolveMemberships(db, alex)).map((x) => x.householdId)).toEqual([bakery]);
    expect(await recentAudit(db, bakery, 5)).toContainEqual(
      expect.objectContaining({ action: "member.linked", actorKind: "member", actorMemberId: mine.id, entityId: mine.id }),
    );
    expect(await recentAudit(db, householdId, 5)).toEqual([]);
    await expect(acceptInvitation(db, alex, mine.id)).rejects.toThrow("no invitation");
  });

  it("declining leaves them out and marks the invite cancelled", async () => {
    const mine = await rowFor("alex@example.com");
    await declineInvitation(db, alex, mine.id);

    expect(await resolveMemberships(db, alex)).toEqual([]);
    expect(await invitationsFor(db, alex)).toEqual([]);
    const after = await rowFor("alex@example.com");
    expect(after.authUserId).toBeNull();
    expect(after.inviteCancelledAt).toBeInstanceOf(Date);
    const entry = (await recentAudit(db, householdId, 5)).find((e) => e.action === "member.invite_declined");
    expect(entry).toMatchObject({ actorKind: "member", actorMemberId: mine.id, entityId: mine.id });
    expect(JSON.stringify(entry!.detail)).not.toContain("@");
    await expect(declineInvitation(db, alex, mine.id)).rejects.toThrow("no invitation");
  });

  it("a declined invite can be reissued by the group", async () => {
    const mine = await rowFor("alex@example.com");
    await declineInvitation(db, alex, mine.id);
    const sammy = (await joinAll(db, sam))[0]!;
    await reinvite(db, sammy, mine.id, "alex@example.com");
    expect(await invitationsFor(db, alex)).toHaveLength(1);
  });

  it("cannot accept or decline an invitation addressed to someone else", async () => {
    const samsRow = await rowFor("sam@example.com");
    await expect(acceptInvitation(db, alex, samsRow.id)).rejects.toThrow("no invitation");
    await expect(declineInvitation(db, alex, samsRow.id)).rejects.toThrow("no invitation");
    const after = await rowFor("sam@example.com");
    expect(after.authUserId).toBeNull();
    expect(after.inviteCancelledAt).toBeNull();
  });

  it("an unverified email sees no invitations and cannot accept", async () => {
    const unverified = { authUserId: "user_alex", verifiedEmails: [] };
    expect(await invitationsFor(db, unverified)).toEqual([]);
    await expect(acceptInvitation(db, unverified, (await rowFor("alex@example.com")).id)).rejects.toThrow("no invitation");
  });

  it("an email already linked by another account sees no invitations", async () => {
    await joinAll(db, alex);
    await bakeryInvitesAlex();
    const other = { authUserId: "user_other", verifiedEmails: ["alex@example.com"] };
    expect(await invitationsFor(db, other)).toEqual([]);
  });

  it("two invitations from two groups are accepted independently", async () => {
    const bakery = await bakeryInvitesAlex();
    const both = await invitationsFor(db, alex);
    expect(both.map((i) => i.householdId)).toEqual([householdId, bakery]);

    await acceptInvitation(db, alex, both[1]!.memberId);
    expect((await resolveMemberships(db, alex)).map((m) => m.householdId)).toEqual([bakery]);
    expect((await invitationsFor(db, alex)).map((i) => i.householdId)).toEqual([householdId]);
    await acceptInvitation(db, alex, both[0]!.memberId);
    expect((await resolveMemberships(db, alex)).map((m) => m.householdId)).toEqual([householdId, bakery]);
  });

  it("someone in group A invited to B is not in B until they accept", async () => {
    await joinAll(db, alex);
    const bakery = await bakeryInvitesAlex();
    expect((await resolveMemberships(db, alex)).map((m) => m.householdId)).toEqual([householdId]);
    expect((await invitationsFor(db, alex)).map((i) => i.householdId)).toEqual([bakery]);
  });

  it("records a rejected link only when nothing is waiting for them", async () => {
    await resolveMemberships(db, alex);
    expect(await recentAudit(db, householdId, 5)).toEqual([]);
  });
});

describe("invitedMember", () => {
  it("finds a provisioned member by email, whatever its case", async () => {
    expect((await invitedMember(db, "Alex@Example.com "))?.displayName).toBe("Alex");
  });

  it("is null for anyone else", async () => {
    expect(await invitedMember(db, "stranger@example.com")).toBeNull();
  });
});

describe("pendingInvites", () => {
  const rows = () => db.select().from(member).where(eq(member.householdId, householdId));

  it("lists the members who have not signed in yet, with the day they were invited", async () => {
    await db.update(member).set({ createdAt: new Date("2026-03-02T03:00:00Z") }).where(eq(member.email, "sam@example.com"));
    await resolveMember(db, { authUserId: "user_alex", verifiedEmails: ["alex@example.com"] });

    // 03:00 UTC on the 2nd is still the 1st in New York.
    expect(pendingInvites(await rows(), "America/New_York")).toEqual([
      { id: expect.any(String), displayName: "Sam", email: "sam@example.com", invitedOn: "2026-03-01", cancelledOn: null },
    ]);
  });

  it("is empty once everyone has signed in", async () => {
    await resolveMember(db, { authUserId: "user_alex", verifiedEmails: ["alex@example.com"] });
    await resolveMember(db, { authUserId: "user_sam", verifiedEmails: ["sam@example.com"] });

    expect(pendingInvites(await rows(), "America/New_York")).toEqual([]);
  });
});

describe("cancelInvite and reinvite", () => {
  const alex = { authUserId: "user_alex", verifiedEmails: ["alex@example.com"] };
  const sam = { authUserId: "user_sam", verifiedEmails: ["sam@example.com"] };
  const row = async (email: string) => (await db.select().from(member).where(eq(member.email, email)))[0]!;

  it("a cancelled invite no longer lets its email join, and the person stays in the group", async () => {
    const me = (await resolveMember(db, alex))!;
    await cancelInvite(db, me, (await row("sam@example.com")).id);

    expect(await resolveMember(db, sam)).toBeNull();
    expect(await invitedMember(db, "sam@example.com")).toBeNull();
    const [invite] = pendingInvites([await row("sam@example.com")], "UTC");
    expect(invite).toMatchObject({ displayName: "Sam", cancelledOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(await recentAudit(db, householdId, 5)).toContainEqual(
      expect.objectContaining({ action: "member.invite_cancelled", actorMemberId: me.id }),
    );
  });

  it("inviting again reopens a cancelled invite", async () => {
    const me = (await resolveMember(db, alex))!;
    const samId = (await row("sam@example.com")).id;
    await cancelInvite(db, me, samId);
    await reinvite(db, me, samId, "sam@example.com");

    expect(await resolveMember(db, sam)).toMatchObject({ id: samId, authUserId: "user_sam" });
  });

  it("inviting again at a new address moves the invite there", async () => {
    const me = (await resolveMember(db, alex))!;
    const samId = (await row("sam@example.com")).id;
    const invited = await reinvite(db, me, samId, " Sam.Lee@Example.com ");

    expect(invited.email).toBe("sam.lee@example.com");
    expect(await resolveMember(db, sam)).toBeNull();
    expect(await resolveMember(db, { authUserId: "user_sam", verifiedEmails: ["sam.lee@example.com"] })).toMatchObject({ id: samId });
    expect((await recentAudit(db, householdId, 2))[1]).toMatchObject({
      action: "member.invited",
      detail: { email: "sam.lee@example.com", previousEmail: "sam@example.com" },
    });
  });

  it("refuses an address that is not one, or that someone in the group already has", async () => {
    const me = (await resolveMember(db, alex))!;
    const samId = (await row("sam@example.com")).id;

    await expect(reinvite(db, me, samId, "sam")).rejects.toThrow("enter an email address");
    await expect(reinvite(db, me, samId, "alex@example.com")).rejects.toThrow("someone in this group already has that email");
  });

  it("leaves alone someone who has signed in, yourself, and another group's invite", async () => {
    const me = (await resolveMember(db, alex))!;
    const joined = (await resolveMember(db, sam))!;
    const [other] = await db.insert(household).values({ name: "Other household" }).returning();
    const [stranger] = await db.insert(member).values({ householdId: other!.id, email: "kim@example.com", displayName: "Kim" }).returning();

    for (const id of [joined.id, me.id, stranger!.id]) {
      await expect(cancelInvite(db, me, id)).rejects.toThrow("no invite waiting");
      await expect(reinvite(db, me, id, "new@example.com")).rejects.toThrow("no invite waiting");
    }
  });
});
