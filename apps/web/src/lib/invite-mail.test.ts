import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@/db/test-db";
import type { Db } from "@/db/types";
import { createHousehold } from "./household-setup";
import { inviteFirstPartner, sendInviteEmail } from "./invite-mail";
import type { Mail } from "./mail";

const site = "https://abacus.example.com";
const alex = { authUserId: "user_alex", email: "alex@example.com" };
const base = { timezone: "UTC", myName: "Alex", householdName: "Maple Street" };

let db: Db;
let sent: Mail[];
const send = async (m: Mail) => {
  sent.push(m);
};

beforeEach(async () => {
  db = await createTestDb();
  sent = [];
});

describe("sendInviteEmail", () => {
  it("writes to the address with the inviter and group in the subject", async () => {
    await sendInviteEmail(send, { to: "sam@example.com", inviterName: "Alex", groupName: "Maple Street", site });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("sam@example.com");
    expect(sent[0]!.subject).toBe("Alex invited you to Maple Street on Clementine");
  });

  it("links to sign-in and says the invitation must be accepted", async () => {
    await sendInviteEmail(send, { to: "sam@example.com", inviterName: "Alex", groupName: "Maple Street", site });
    expect(sent[0]!.text).toContain(`${site}/sign-in`);
    expect(sent[0]!.text).toMatch(/accept/i);
    expect(sent[0]!.text).toContain("If you were not expecting this, ignore this message.");
  });

  it("cannot be made to add a header line through a name", async () => {
    await sendInviteEmail(send, {
      to: "sam@example.com",
      inviterName: "Alex\r\nBcc: x@example.com",
      groupName: "Home\nCc: y@example.com",
      site,
    });
    expect(sent[0]!.subject).not.toMatch(/[\r\n]/);
  });
});

describe("inviteFirstPartner", () => {
  it("emails the stored, normalised address of the new group's other person", async () => {
    const me = await createHousehold(db, alex, { ...base, partnerName: "Sam", partnerEmail: " Sam@Example.com " }, { openSignUp: true });
    await inviteFirstPartner(db, send, me, site);
    expect(sent.map((m) => m.to)).toEqual(["sam@example.com"]);
    expect(sent[0]!.subject).toContain("Maple Street");
    expect(sent[0]!.subject).toContain("Alex");
  });

  it("sends nothing for a one-person business", async () => {
    const me = await createHousehold(db, alex, { ...base, kind: "business", partnerName: "", partnerEmail: "" }, { openSignUp: true });
    await inviteFirstPartner(db, send, me, site);
    expect(sent).toEqual([]);
  });
});
