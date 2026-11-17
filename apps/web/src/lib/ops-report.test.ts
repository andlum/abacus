import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@/db/test-db";
import { auditLog, authUser, opsReport } from "@/db/schema";
import type { Db } from "@/db/types";
import { createHousehold } from "./household-setup";
import { inviteLimits } from "./invite-limits";
import type { Mail } from "./mail";
import { opsCounts, opsMail, opsSettings, opsWarnings, sendOpsReport, type OpsCounts } from "./ops-report";

const limits = inviteLimits({});
const settings = opsSettings({ ABACUS_OPS_EMAIL: "ops@example.com" })!;
const now = new Date("2026-03-05T12:00:00Z");
const hoursAgo = (n: number) => new Date(now.getTime() - n * 60 * 60 * 1000);

let db: Db;
let n = 0;

beforeEach(async () => {
  db = await createTestDb();
  n = 0;
});

const signUp = (createdAt: Date, emailVerified = true) => {
  n += 1;
  return db.insert(authUser).values({ id: `user_${n}`, name: `Person ${n}`, email: `person${n}@example.com`, emailVerified, createdAt, updatedAt: createdAt });
};

const founder = (id: string) => ({ authUserId: id, email: `${id}@example.com` });

const group = (who = founder("user_alex")) =>
  createHousehold(
    db,
    who,
    { timezone: "UTC", myName: "Alex", householdName: `Group ${++n}`, kind: "business", partnerName: "", partnerEmail: "" },
    { openSignUp: true },
    limits,
  );

// An invite email as invite-limits.ts records it.
const inviteEmailed = (actorMemberId: string, householdId: string, at: Date) =>
  db.insert(auditLog).values({ householdId, actorKind: "member", actorMemberId, action: "member.invite_emailed", entityType: "member", entityId: actorMemberId, at });

const quiet: OpsCounts = {
  signUps: 0,
  unconfirmed: 0,
  groupsCreated: 0,
  inviteEmails: 0,
  mostGroupsByOneAccount: 0,
  mostInviteEmailsByOneAccount: 0,
  accounts: 0,
  groups: 0,
};

describe("opsSettings", () => {
  it("is off without an address", () => {
    expect(opsSettings({})).toBeNull();
    expect(opsSettings({ ABACUS_OPS_EMAIL: "  " })).toBeNull();
  });

  it("warns at 20 sign-ups unless told otherwise", () => {
    expect(opsSettings({ ABACUS_OPS_EMAIL: "ops@example.com" })).toEqual({ to: "ops@example.com", signUpAlert: 20 });
    expect(opsSettings({ ABACUS_OPS_EMAIL: "ops@example.com", ABACUS_OPS_SIGNUP_ALERT: "5" })!.signUpAlert).toBe(5);
    expect(opsSettings({ ABACUS_OPS_EMAIL: "ops@example.com", ABACUS_OPS_SIGNUP_ALERT: "lots" })!.signUpAlert).toBe(20);
  });
});

describe("opsCounts", () => {
  it("counts sign-ups in the period, and how many never confirmed", async () => {
    await signUp(hoursAgo(30));
    await signUp(hoursAgo(5));
    await signUp(hoursAgo(2), false);
    const c = await opsCounts(db, hoursAgo(24), now);
    expect(c.signUps).toBe(2);
    expect(c.unconfirmed).toBe(1);
    expect(c.accounts).toBe(3);
  });

  it("counts groups and invite emails, and the most any one account made", async () => {
    // Audit rows take the database's clock, so this one runs on real time.
    const t = Date.now();
    const ago = (h: number) => new Date(t - h * 60 * 60 * 1000);
    const a = await group(founder("user_alex"));
    await group(founder("user_alex"));
    const b = await group(founder("user_blake"));
    await inviteEmailed(a.id, a.householdId, ago(2));
    await inviteEmailed(a.id, a.householdId, ago(1));
    await inviteEmailed(b.id, b.householdId, ago(1));
    await inviteEmailed(b.id, b.householdId, ago(40));

    const c = await opsCounts(db, ago(24), new Date(t + 60_000));
    expect(c.groupsCreated).toBe(3);
    expect(c.mostGroupsByOneAccount).toBe(2);
    expect(c.inviteEmails).toBe(3);
    expect(c.mostInviteEmailsByOneAccount).toBe(2);
    expect(c.groups).toBe(3);
  });
});

describe("opsWarnings", () => {
  it("says nothing on a quiet day", () => {
    expect(opsWarnings(quiet, null, limits, settings)).toEqual([]);
  });

  it("warns about a burst of sign-ups, or mostly unconfirmed ones", () => {
    expect(opsWarnings({ ...quiet, signUps: 20 }, null, limits, settings)).toEqual([
      "20 sign-ups, at or above the 20 set as unusual (ABACUS_OPS_SIGNUP_ALERT)",
    ]);
    expect(opsWarnings({ ...quiet, signUps: 6, unconfirmed: 4 }, null, limits, settings)).toEqual([
      "4 of 6 new accounts never confirmed their email, which is how bot sign-ups look",
    ]);
    // A handful is too few to read anything into.
    expect(opsWarnings({ ...quiet, signUps: 2, unconfirmed: 2 }, null, limits, settings)).toEqual([]);
  });

  it("warns when one account reaches a daily limit", () => {
    expect(opsWarnings({ ...quiet, mostGroupsByOneAccount: 5, mostInviteEmailsByOneAccount: 10 }, null, limits, settings)).toEqual([
      "One account created 5 groups (the limit is 5 a day)",
      "One account sent 10 invite emails (the limit is 10 a day)",
    ]);
  });

  it("warns when the daily job had failures", () => {
    const job = { groups: 3, posted: 2, failed: 1, bank: { synced: 1, needsRelink: 0, failed: 2 } };
    expect(opsWarnings(quiet, job as never, limits, settings)).toEqual([
      "Posting recurring costs failed for 1 group; the server log has the error",
      "Syncing failed for 2 bank connections; the server log has the error",
    ]);
  });
});

describe("opsMail", () => {
  it("leads with the warnings, and names no one", () => {
    const mail = opsMail(settings, { ...quiet, signUps: 6, unconfirmed: 4, accounts: 50, groups: 12 }, null, limits, hoursAgo(24), now);
    expect(mail.to).toBe("ops@example.com");
    expect(mail.subject).toBe("Abacus daily: 1 warning, 6 sign-ups");
    expect(mail.text).toContain("Warnings\n- 4 of 6 new accounts never confirmed");
    expect(mail.text).toContain("Sign-ups: 6 (4 not confirmed)");
    expect(mail.text).toContain("All time: 50 accounts, 12 groups");
    expect(mail.text).not.toContain("@");
  });

  it("says so when all is well", () => {
    const mail = opsMail(settings, quiet, { groups: 1, posted: 0, failed: 0 }, limits, hoursAgo(24), now);
    expect(mail.subject).toBe("Abacus daily: all quiet, 0 sign-ups");
    expect(mail.text).toContain("No warnings.");
    expect(mail.text).toContain("Recurring costs posted: 0, failed: 0");
  });
});

describe("sendOpsReport", () => {
  const outbox: Mail[] = [];
  const mailer = async (m: Mail) => {
    outbox.push(m);
  };
  beforeEach(() => {
    outbox.length = 0;
  });

  it("sends once a day, however often the job runs", async () => {
    expect(await sendOpsReport(db, mailer, settings, now, null, limits)).toBe("sent");
    expect(await sendOpsReport(db, mailer, settings, hoursAgo(-1), null, limits)).toBe("not-due");
    expect(outbox).toHaveLength(1);
    const [row] = await db.select().from(opsReport);
    expect(row!.day).toBe("2026-03-05");
    expect(row!.sentAt).not.toBeNull();
    expect(row!.counts).toMatchObject({ signUps: 0 });
  });

  it("covers the time since the last report, or the last day for the first one", async () => {
    await signUp(hoursAgo(30));
    await sendOpsReport(db, mailer, settings, now, null, limits);
    expect(outbox[0]!.text).toContain("Sign-ups: 0");

    await signUp(hoursAgo(-10));
    const tomorrow = hoursAgo(-20);
    await sendOpsReport(db, mailer, settings, tomorrow, null, limits);
    expect(outbox[1]!.text).toContain("Sign-ups: 1");
    const rows = await db.select().from(opsReport).orderBy(opsReport.day);
    expect(rows[1]!.periodStart).toEqual(now);
  });

  it("tries again later in the day when the mail fails", async () => {
    const failing = async () => {
      throw new Error("smtp down");
    };
    await expect(sendOpsReport(db, failing, settings, now, null, limits)).rejects.toThrow("smtp down");
    // Too soon: another machine may still be sending.
    expect(await sendOpsReport(db, mailer, settings, new Date(now.getTime() + 10 * 60 * 1000), null, limits)).toBe("not-due");
    expect(await sendOpsReport(db, mailer, settings, hoursAgo(-1), null, limits)).toBe("sent");
    expect(outbox).toHaveLength(1);
  });
});
