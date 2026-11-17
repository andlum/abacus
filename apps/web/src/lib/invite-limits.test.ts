import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "@/db/test-db";
import { auditLog, member } from "@/db/schema";
import type { Db } from "@/db/types";
import { createHousehold } from "./household-setup";
import { claimInviteEmail, inviteLimits } from "./invite-limits";
import { inviteFirstPartner } from "./invite-mail";
import type { Mail } from "./mail";

const site = "https://abacus.example.com";
const alex = { authUserId: "user_alex", email: "alex@example.com" };
const blake = { authUserId: "user_blake", email: "blake@example.com" };
const open = { openSignUp: true };
const limits = inviteLimits({});
const hours = (n: number) => new Date(Date.now() + n * 60 * 60 * 1000);

let db: Db;
let n = 0;

beforeEach(async () => {
  db = await createTestDb();
  n = 0;
});

// A new two-person group whose other person has a fresh address each time.
const group = (founder = alex, partnerEmail = `sam${++n}@example.com`, l = limits, now?: Date) =>
  createHousehold(
    db,
    founder,
    { timezone: "UTC", myName: "Alex", householdName: `Group ${n}`, partnerName: "Sam", partnerEmail },
    open,
    l,
    now,
  );

const solo = (l = limits, now?: Date) =>
  createHousehold(
    db,
    alex,
    { timezone: "UTC", myName: "Alex", householdName: "Books", kind: "business", partnerName: "", partnerEmail: "" },
    open,
    l,
    now,
  );

const invitee = async (householdId: string) => {
  const rows = await db.select().from(member).where(eq(member.householdId, householdId));
  return rows.find((m) => m.authUserId === null)!;
};

describe("inviteLimits", () => {
  it("has defaults, and reads whole numbers from the environment", () => {
    expect(limits).toEqual({ groupsPerDay: 5, invitesPerDay: 10, perAddressPerDay: 1, openInvites: 20 });
    expect(inviteLimits({ ABACUS_MAX_GROUPS_PER_DAY: "50", ABACUS_MAX_OPEN_INVITES: "x" })).toMatchObject({
      groupsPerDay: 50,
      openInvites: 20,
    });
  });
});

describe("creating groups", () => {
  it("stops one account at five groups in a day, and lets it go on the next day", async () => {
    for (let i = 0; i < 5; i++) await solo();
    await expect(solo()).rejects.toThrow(/5 groups in a day/);
    await expect(solo(limits, hours(25))).resolves.toBeTruthy();
  });

  it("counts each account on its own", async () => {
    for (let i = 0; i < 5; i++) await solo();
    await expect(group(blake)).resolves.toBeTruthy();
  });

  it("stops a group that would leave too many invitations unanswered, but not a one-person business", async () => {
    const two = { ...limits, groupsPerDay: 99, openInvites: 2 };
    await group(alex, undefined, two);
    await group(alex, undefined, two);
    await expect(group(alex, undefined, two)).rejects.toThrow(/2 invitations .* waiting/);
    await expect(solo(two)).resolves.toBeTruthy();
  });
});

describe("claimInviteEmail", () => {
  it("records each email, with ids only", async () => {
    const me = await group();
    const sam = await invitee(me.householdId);
    await claimInviteEmail(db, me, sam, limits);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, "member.invite_emailed"));
    expect(row).toMatchObject({ actorMemberId: me.id, entityType: "member", entityId: sam.id, detail: {} });
  });

  it("refuses a second email to the same address within a day, whoever asks", async () => {
    const me = await group(alex, "sam@example.com");
    await claimInviteEmail(db, me, await invitee(me.householdId), limits);
    const other = await group(blake, "sam@example.com");
    const sam = await invitee(other.householdId);
    await expect(claimInviteEmail(db, other, sam, limits)).rejects.toThrow(/already been emailed/);
    await expect(claimInviteEmail(db, other, sam, limits, hours(25))).resolves.toBeUndefined();
  });

  it("stops one account at its daily number of emails across all its groups", async () => {
    const three = { ...limits, invitesPerDay: 3 };
    for (let i = 0; i < 3; i++) {
      const me = await group();
      await claimInviteEmail(db, me, await invitee(me.householdId), three);
    }
    const me = await group();
    await expect(claimInviteEmail(db, me, await invitee(me.householdId), three)).rejects.toThrow(/3 invite emails in a day/);
  });
});

describe("inviteFirstPartner", () => {
  it("sends nothing once the address has had its email for the day", async () => {
    const sent: Mail[] = [];
    const send = async (m: Mail) => void sent.push(m);
    const first = await group(alex, "sam@example.com");
    await inviteFirstPartner(db, send, first, site);
    const second = await group(alex, "sam@example.com");
    await expect(inviteFirstPartner(db, send, second, site)).rejects.toThrow(/already been emailed/);
    expect(sent).toHaveLength(1);
  });
});
