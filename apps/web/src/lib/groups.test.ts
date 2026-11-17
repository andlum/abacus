import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@/db/test-db";
import type { Db } from "@/db/types";
import { recentAudit } from "./audit";
import { currentMembership, groupsFor, setDefaultGroup } from "./groups";
import { createHousehold } from "./household-setup";
import { resolveMemberships } from "./membership";

let db: Db;
const jo = { authUserId: "user_jo", email: "jo@example.com" };
const mine = () => resolveMemberships(db, { authUserId: "user_jo", verifiedEmails: ["jo@example.com"] });

// Jo in two groups: a household, then a business.
beforeEach(async () => {
  db = await createTestDb();
  const base = { timezone: "UTC", myName: "Jo" };
  await createHousehold(
    db,
    jo,
    { ...base, householdName: "Maple Street", kind: "household", partnerName: "Kit", partnerEmail: "kit@example.com" },
    { openSignUp: false },
  );
  await createHousehold(
    db,
    jo,
    { ...base, householdName: "Corner Bakery", kind: "business", partnerName: "Lee", partnerEmail: "lee@example.com" },
    { openSignUp: false },
  );
});

describe("groupsFor", () => {
  it("lists a person's groups, oldest first, with what kind each is", async () => {
    const groups = await groupsFor(db, await mine());
    expect(groups.map((g) => [g.name, g.kind, g.isDefault])).toEqual([
      ["Maple Street", "household", false],
      ["Corner Bakery", "business", false],
    ]);
  });
});

describe("currentMembership", () => {
  it("is the oldest group when nothing has been chosen", async () => {
    const all = await mine();
    expect(currentMembership(all, undefined)?.id).toBe(all[0]!.id);
  });

  it("is the group that was switched to", async () => {
    const all = await mine();
    expect(currentMembership(all, all[1]!.householdId)?.id).toBe(all[1]!.id);
  });

  it("falls back to the default group when the choice is not one of theirs", async () => {
    await setDefaultGroup(db, await mine(), (await mine())[1]!.householdId);
    const all = await mine();
    expect(currentMembership(all, "00000000-0000-4000-8000-000000000000")?.id).toBe(all[1]!.id);
    expect(currentMembership(all, undefined)?.id).toBe(all[1]!.id);
  });

  it("is null for someone in no group", () => {
    expect(currentMembership([], undefined)).toBeNull();
  });
});

describe("setDefaultGroup", () => {
  it("marks one group as the default and unmarks the last one", async () => {
    const [home, bakery] = await mine();
    await setDefaultGroup(db, await mine(), home!.householdId);
    await setDefaultGroup(db, await mine(), bakery!.householdId);

    const groups = await groupsFor(db, await mine());
    expect(groups.map((g) => g.isDefault)).toEqual([false, true]);
  });

  it("writes an audit entry in the group that became the default", async () => {
    const [, bakery] = await mine();
    await setDefaultGroup(db, await mine(), bakery!.householdId);
    const [entry] = await recentAudit(db, bakery!.householdId, 1);
    expect(entry).toMatchObject({ action: "member.default_group_set", actorMemberId: bakery!.id });
  });

  it("refuses a group the person is not in", async () => {
    await expect(setDefaultGroup(db, await mine(), "00000000-0000-4000-8000-000000000000")).rejects.toThrow(
      /not in that group/,
    );
  });
});
