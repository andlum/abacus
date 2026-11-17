import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { household, member } from "@/db/schema";
import { createTestDb, seedHousehold } from "@/db/test-db";
import type { Db } from "@/db/types";
import { recentAudit } from "./audit";
import { listAttention } from "./attention";
import { createExpense } from "./expenses";
import { gettingStarted } from "./getting-started";
import { createTemplate } from "./templates";
import { canStartHousehold, createHousehold, type HouseholdSetup } from "./household-setup";
import { invitedMember, resolveMemberships } from "./membership";

let db: Db;

beforeEach(async () => {
  db = await createTestDb();
});

const jo = { authUserId: "user_jo", email: "jo@example.com" };

const setup = (over: Partial<HouseholdSetup> = {}): HouseholdSetup => ({
  householdName: "Maple Street",
  timezone: "America/New_York",
  myName: "Jo",
  partnerName: "Kit",
  partnerEmail: "kit@example.com",
  ...over,
});

describe("canStartHousehold", () => {
  it("is true on an empty database", async () => {
    expect(await canStartHousehold(db, { openSignUp: false })).toBe(true);
  });

  it("is false once a household exists", async () => {
    await seedHousehold(db);
    expect(await canStartHousehold(db, { openSignUp: false })).toBe(false);
  });

  it("stays true with open sign-up, however many households exist", async () => {
    await seedHousehold(db);
    expect(await canStartHousehold(db, { openSignUp: true })).toBe(true);
  });
});

describe("createHousehold", () => {
  it("creates the household and both members, with the creator already linked", async () => {
    const me = await createHousehold(db, jo, setup(), { openSignUp: false });

    const [h] = await db.select().from(household);
    expect(h).toMatchObject({ name: "Maple Street", timezone: "America/New_York" });
    expect(me).toMatchObject({ householdId: h!.id, email: "jo@example.com", displayName: "Jo", authUserId: "user_jo" });
    expect(me.linkedAt).toBeInstanceOf(Date);

    const partner = await invitedMember(db, "kit@example.com");
    expect(partner).toMatchObject({ householdId: h!.id, displayName: "Kit", authUserId: null, linkedAt: null });
  });

  it("is where the creator's next request lands", async () => {
    const me = await createHousehold(db, jo, setup(), { openSignUp: false });
    const mine = await resolveMemberships(db, { authUserId: "user_jo", verifiedEmails: ["jo@example.com"] });
    expect(mine.map((m) => m.id)).toEqual([me.id]);
  });

  it("stores emails lowercase and trims what was typed", async () => {
    const me = await createHousehold(
      db,
      { authUserId: "user_jo", email: "Jo@Example.com" },
      setup({ householdName: "  Maple Street ", myName: " Jo ", partnerEmail: " Kit@Example.com " }),
      { openSignUp: false },
    );
    expect(me).toMatchObject({ email: "jo@example.com", displayName: "Jo" });
    expect(await invitedMember(db, "kit@example.com")).not.toBeNull();
    const [h] = await db.select().from(household);
    expect(h!.name).toBe("Maple Street");
  });

  it("writes one audit entry, by the creator, in the same transaction", async () => {
    const me = await createHousehold(db, jo, setup(), { openSignUp: false });
    const log = await recentAudit(db, me.householdId, 10);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "household.created", actorMemberId: me.id, entityId: me.householdId });
  });

  it("refuses a second household when sign-up is closed, and changes nothing", async () => {
    await seedHousehold(db);
    await expect(createHousehold(db, jo, setup(), { openSignUp: false })).rejects.toThrow(/already set up/);
    expect(await db.select().from(household)).toHaveLength(1);
    expect(await db.select().from(member)).toHaveLength(2);
  });

  it("allows a second household with open sign-up", async () => {
    const seeded = await seedHousehold(db);
    const me = await createHousehold(db, jo, setup(), { openSignUp: true });
    expect(me.householdId).not.toBe(seeded.household.id);
    expect(await db.select().from(household)).toHaveLength(2);
  });

  it("lets someone who is already a member add another group, even with sign-up closed", async () => {
    const first = await createHousehold(db, jo, setup(), { openSignUp: false });
    const second = await createHousehold(
      db,
      jo,
      setup({ householdName: "Corner Bakery", kind: "business", partnerEmail: "lee@example.com", partnerName: "Lee" }),
      { openSignUp: false },
    );

    expect(second.householdId).not.toBe(first.householdId);
    expect(second).toMatchObject({ email: "jo@example.com", authUserId: "user_jo" });
    const groups = await db.select().from(household).orderBy(household.createdAt);
    expect(groups.map((g) => g.kind)).toEqual(["household", "business"]);
  });

  it("lets the other person be someone who is already in another group", async () => {
    await seedHousehold(db);
    const me = await createHousehold(db, jo, setup({ partnerEmail: "alex@example.com" }), { openSignUp: true });
    const rows = await db.select().from(member).where(eq(member.email, "alex@example.com"));
    expect(rows.map((r) => r.householdId)).toContain(me.householdId);
    expect(rows).toHaveLength(2);
  });

  it("lets a business have one person, and splits its costs wholly to them", async () => {
    const me = await createHousehold(
      db,
      jo,
      setup({ householdName: "Corner Bakery", kind: "business", partnerName: "", partnerEmail: "" }),
      { openSignUp: false },
    );
    expect(await db.select().from(member).where(eq(member.householdId, me.householdId))).toHaveLength(1);

    const flour = await createExpense(db, me.householdId, {
      kind: "manual",
      actor: me,
      date: "2027-03-01",
      description: "Flour",
      category: "other",
      totalCents: 4001,
      payerId: me.id,
      today: "2027-03-01",
    });
    expect(flour.shares).toEqual({ [me.id]: 4001 });
    expect((await listAttention(db, me.householdId, "2027-03-01")).onDefault).toEqual([]);
    expect((await gettingStarted(db, me)).partner).toBeNull();
  });

  it("counts a solo business as started once it has a recurring cost, with nobody to wait for", async () => {
    const me = await createHousehold(
      db,
      jo,
      setup({ kind: "business", partnerName: "", partnerEmail: "" }),
      { openSignUp: false },
    );
    expect(await gettingStarted(db, me)).toMatchObject({ partner: null, partnerJoined: true, done: false });
    await createTemplate(db, me, {
      name: "Rent",
      category: "software",
      amountCents: 200000,
      cadence: "monthly",
      dayOfMonth: 1,
      payerId: me.id,
      startDate: "2027-03-01",
    });
    expect((await gettingStarted(db, me)).done).toBe(true);
  });

  it("still needs a second person for a household", async () => {
    await expect(
      createHousehold(db, jo, setup({ partnerName: "", partnerEmail: "" }), { openSignUp: false }),
    ).rejects.toThrow(/other person/);
  });

  it("refuses half of the other person's details for a business", async () => {
    await expect(
      createHousehold(db, jo, setup({ kind: "business", partnerName: "Lee", partnerEmail: "" }), { openSignUp: false }),
    ).rejects.toThrow(/email/);
  });

  it("refuses a kind that is not a household or a business", async () => {
    await expect(
      createHousehold(db, jo, setup({ kind: "club" as never }), { openSignUp: false }),
    ).rejects.toThrow(/household or a business/);
  });

  it("refuses your own email as the partner's", async () => {
    await expect(createHousehold(db, jo, setup({ partnerEmail: "JO@example.com" }), { openSignUp: false })).rejects.toThrow(
      /different email/,
    );
  });

  it.each([
    ["householdName", "", /give the group a name/],
    ["myName", "  ", /your name/i],
    ["partnerName", "", /other person.s name/i],
    ["partnerEmail", "not-an-email", /email/i],
    ["timezone", "Mars/Olympus", /timezone/i],
  ] as const)("refuses a bad %s", async (key, value, message) => {
    await expect(createHousehold(db, jo, setup({ [key]: value }), { openSignUp: false })).rejects.toThrow(message);
    expect(await db.select().from(household)).toHaveLength(0);
  });
});
