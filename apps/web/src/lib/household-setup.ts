import { and, eq, isNull, sql } from "drizzle-orm";
import { isTimezone } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { GROUP_KINDS, household, member, type GroupKind, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";
import { seedCategories } from "./categories.ts";
import { checkGroupAllowance, inviteLimits, type InviteLimits } from "./invite-limits.ts";

// Who may create a group without being invited to one. Someone who is
// already a member of a group may always add another; this is about
// everyone else.
//
// Closed (the default): only while the database has no household, so the
// person who installs Clementine can set it up in the browser and nobody after
// them can. Open: anyone with a verified email, which is what a hosted
// service wants. Set ABACUS_OPEN_SIGNUP=1 to open it.
export type SignUpPolicy = { openSignUp: boolean };

export function signUpPolicy(env: Record<string, string | undefined> = process.env): SignUpPolicy {
  return { openSignUp: env.ABACUS_OPEN_SIGNUP === "1" };
}

export async function canStartHousehold(db: Db, policy: SignUpPolicy): Promise<boolean> {
  if (policy.openSignUp) return true;
  const [any] = await db.select({ id: household.id }).from(household).limit(1);
  return !any;
}

export type HouseholdSetup = {
  householdName: string;
  // Left out, it is a household.
  kind?: GroupKind;
  // IANA name, such as America/New_York. Decides which day "today" is.
  timezone: string;
  myName: string;
  partnerName: string;
  partnerEmail: string;
};

// The person creating the group. The email must be one the sign-in has
// verified. `authUserId` is null only under the local sign-in stand-in
// (dev-auth.ts), where a person is known by their email alone.
export type Founder = { authUserId: string | null; email: string };

// Creates a group with its members: the founder, linked at once, and the
// other person, who is invited by email and joins when they accept the
// invitation (acceptInvitation). A business may be one person, with both of the other
// person's fields left empty; a household is always two. Returns the
// founder's member row in the new group.
export async function createHousehold(
  db: Db,
  founder: Founder,
  input: HouseholdSetup,
  policy: SignUpPolicy,
  limits: InviteLimits = inviteLimits(),
  now: Date = new Date(),
): Promise<Member> {
  const householdName = input.householdName.trim();
  const kind = input.kind ?? "household";
  const myName = input.myName.trim();
  const partnerName = input.partnerName.trim();
  const myEmail = founder.email.trim().toLowerCase();
  const partnerEmail = input.partnerEmail.trim().toLowerCase();

  if (!householdName) throw new UserError("give the group a name");
  if (!GROUP_KINDS.includes(kind)) throw new UserError("choose a household or a business");
  if (!myName) throw new UserError("enter your name");
  const solo = kind === "business" && !partnerName && !partnerEmail;
  if (!solo) {
    if (!partnerName) throw new UserError("enter the other person's name");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(partnerEmail)) throw new UserError("enter the other person's email address");
    if (partnerEmail === myEmail) throw new UserError("the other person needs a different email from yours");
  }
  if (!isTimezone(input.timezone)) throw new UserError("choose a timezone from the list");

  return db.transaction(async (tx) => {
    // One setup at a time, so two people racing to be first cannot both win.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('abacus.household-setup'))`);

    const [already] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(founder.authUserId ? eq(member.authUserId, founder.authUserId) : eq(member.email, myEmail), isNull(member.removedAt)))
      .limit(1);
    if (!already && !(await canStartHousehold(tx, policy))) throw new UserError("this Clementine is already set up; ask to be invited");
    await checkGroupAllowance(tx, founder, !solo, limits, now);

    const [h] = await tx.insert(household).values({ name: householdName, kind, timezone: input.timezone }).returning();
    await seedCategories(tx, h!.id, kind);
    const [me] = await tx
      .insert(member)
      .values({
        householdId: h!.id,
        email: myEmail,
        displayName: myName,
        authUserId: founder.authUserId,
        linkedAt: founder.authUserId ? new Date() : null,
      })
      .returning();
    const partners = solo
      ? []
      : await tx.insert(member).values({ householdId: h!.id, email: partnerEmail, displayName: partnerName }).returning();

    await writeAudit(tx, {
      householdId: h!.id,
      actor: { kind: "member", memberId: me!.id },
      action: "household.created",
      entity: { type: "household", id: h!.id },
      detail: { kind, memberIds: [me!.id, ...partners.map((p) => p.id)] },
    });
    return me!;
  });
}
