import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, member } from "@/db/schema";
import { createWorld, type World } from "./testing/world";
import { createExpense, editExpense } from "./expenses";
import { inviteLimits } from "./invite-limits";
import { acceptInvitation, cancelInvite, invitePerson } from "./membership";
import { recordSettlement } from "./balance";
import { readRule } from "./rule-text";
import { addRule } from "./rules";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

const jo = { displayName: "Jo", email: "Jo@Example.com" };
const joSignsIn = { authUserId: "user_jo", verifiedEmails: ["jo@example.com"] };
const groceries = (date: string) => ({
  kind: "manual" as const,
  date,
  description: "Groceries",
  category: "groceries",
  totalCents: 9000,
  today: "2026-11-30",
});

describe("adding a person to a group that already exists", () => {
  it("saves an invitation that any member can send, and says who sent it", async () => {
    const row = await invitePerson(w.db, w.sam, jo);
    expect(row).toMatchObject({ householdId: w.householdId, displayName: "Jo", email: "jo@example.com", authUserId: null, sharesFrom: null });
    const [entry] = await w.db.select().from(auditLog).where(eq(auditLog.action, "member.invited"));
    expect(entry).toMatchObject({ actorMemberId: w.sam.id, entityId: row.id });
  });

  it("refuses an address the group already has, a bad address and an empty name", async () => {
    await expect(invitePerson(w.db, w.alex, { displayName: "Sam again", email: "sam@example.com" })).rejects.toThrow(
      "someone in this group already has that email",
    );
    await expect(invitePerson(w.db, w.alex, { displayName: "Jo", email: "jo" })).rejects.toThrow("enter an email address");
    await expect(invitePerson(w.db, w.alex, { displayName: " ", email: "jo@example.com" })).rejects.toThrow("enter their name");
  });

  it("refuses when too many invitations are still waiting", async () => {
    // In this world nobody has a sign-in account, so Alex and Sam count as waiting too.
    const limits = { ...inviteLimits({}), openInvites: 3 };
    await invitePerson(w.db, w.alex, jo, limits);
    await expect(invitePerson(w.db, w.alex, { displayName: "Kim", email: "kim@example.com" }, limits)).rejects.toThrow(
      "invitations still waiting",
    );
  });

  it("leaves costs between the people already there until the new person joins", async () => {
    await invitePerson(w.db, w.alex, jo);
    const e = await createExpense(w.db, w.householdId, { ...groceries("2026-11-10"), actor: w.alex, payerId: w.alex.id });
    expect(e.shares).toEqual({ [w.alex.id]: 4500, [w.sam.id]: 4500 });
  });

  it("splits three ways from the day they join, and not before, even when an earlier cost is edited later", async () => {
    const invited = await invitePerson(w.db, w.alex, jo);
    const before = await createExpense(w.db, w.householdId, { ...groceries("2026-11-10"), actor: w.alex, payerId: w.alex.id });
    const joined = await acceptInvitation(w.db, joSignsIn, invited.id, new Date("2026-11-15T17:00:00Z"));
    expect(joined.sharesFrom).toBe("2026-11-15");

    const after = await createExpense(w.db, w.householdId, { ...groceries("2026-11-15"), actor: w.alex, payerId: w.alex.id });
    expect(after.shares).toEqual({ [w.alex.id]: 3000, [w.sam.id]: 3000, [joined.id]: 3000 });

    const { kind: _k, today: _t, ...edit } = groceries("2026-11-10");
    const edited = await editExpense(w.db, w.alex, before.id, { ...edit, payerId: w.alex.id, description: "Groceries and wine" }, "2026-11-30");
    expect(edited.shares).toEqual({ [w.alex.id]: 4500, [w.sam.id]: 4500 });
  });

  it("never counts someone whose invitation was cancelled before they joined", async () => {
    const invited = await invitePerson(w.db, w.alex, jo);
    await cancelInvite(w.db, w.alex, invited.id);
    const e = await createExpense(w.db, w.householdId, { ...groceries("2026-11-20"), actor: w.alex, payerId: w.alex.id });
    expect(e.shares).toEqual({ [w.alex.id]: 4500, [w.sam.id]: 4500 });
  });

  it("keeps the first people of a group counting from the start", async () => {
    const rows = await w.db.select().from(member).where(eq(member.householdId, w.householdId));
    expect(rows.map((m) => m.sharesFrom)).toEqual(["1970-01-01", "1970-01-01"]);
  });

  it("lets a rule name the new person only from the day they count", async () => {
    const invited = await invitePerson(w.db, w.alex, jo);
    const thirds = { kind: "percent" as const, bp: { [w.alex.id]: 4000, [w.sam.id]: 3000, [invited.id]: 3000 } };
    await expect(addRule(w.db, w.alex, { scope: "household", rule: thirds, effectiveFrom: "2026-11-12" }, "2026-11-12")).rejects.toThrow(
      "that rule is not valid",
    );
    await acceptInvitation(w.db, joSignsIn, invited.id, new Date("2026-11-15T17:00:00Z"));
    const saved = await addRule(w.db, w.alex, { scope: "household", rule: thirds, effectiveFrom: "2026-11-16" }, "2026-11-16");
    expect(saved.status).toBe("active");
  });
  it("reads a percentage rule from a form that leaves someone blank, without naming them", async () => {
    const invited = await invitePerson(w.db, w.alex, jo);
    const everyone = [w.alex, w.sam, invited];
    const form = new FormData();
    form.set("rule_kind", "percent");
    form.set(`rule_pct_${w.alex.id}`, "60");
    form.set(`rule_pct_${w.sam.id}`, "40");
    form.set(`rule_pct_${invited.id}`, "");
    const rule = readRule(form, "rule_", everyone)!;
    expect(rule).toEqual({ kind: "percent", bp: { [w.alex.id]: 6000, [w.sam.id]: 4000 } });
    const cost = await createExpense(w.db, w.householdId, { ...groceries("2026-11-10"), actor: w.alex, payerId: w.alex.id, rule });
    expect(cost.shares).toEqual({ [w.alex.id]: 5400, [w.sam.id]: 3600 });
  });

  it("does not let someone pay, or be paid, on a date before they count", async () => {
    const invited = await invitePerson(w.db, w.alex, jo);
    const refused = "was not part of this group on that date";
    await expect(
      createExpense(w.db, w.householdId, { ...groceries("2026-11-10"), actor: w.alex, payerId: invited.id }),
    ).rejects.toThrow(refused);
    const pay = (from: string, to: string, date: string) =>
      recordSettlement(w.db, w.alex, { fromMemberId: from, toMemberId: to, amountCents: 1000, date }, "2026-11-30");
    await expect(pay(w.alex.id, invited.id, "2026-11-10")).rejects.toThrow(refused);
    await expect(pay(invited.id, w.alex.id, "2026-11-10")).rejects.toThrow(refused);

    await acceptInvitation(w.db, joSignsIn, invited.id, new Date("2026-11-15T12:00:00Z"));
    await expect(pay(w.alex.id, invited.id, "2026-11-14")).rejects.toThrow(refused);
    await pay(w.alex.id, invited.id, "2026-11-15");
    const cost = await createExpense(w.db, w.householdId, { ...groceries("2026-11-16"), actor: w.alex, payerId: invited.id });
    expect(cost.payerId).toBe(invited.id);
  });

  it("says so when the address belongs to an invitation that was cancelled", async () => {
    const invited = await invitePerson(w.db, w.alex, jo);
    await cancelInvite(w.db, w.alex, invited.id);
    await expect(invitePerson(w.db, w.alex, jo)).rejects.toThrow("was cancelled");
  });
});
