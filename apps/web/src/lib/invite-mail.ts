import { and, eq, isNull, ne } from "drizzle-orm";
import { household, member, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { claimInviteEmail, inviteLimits, type InviteLimits } from "./invite-limits.ts";
import type { Mailer } from "./mail.ts";

export type Invite = { to: string; inviterName: string; groupName: string; site: string };

// Names are typed by the inviter; a line break in one would add a header.
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

// Writes to a person invited to a group. `site` is the address of this
// site, such as https://abacus.example.com, with no trailing slash.
export async function sendInviteEmail(send: Mailer, { to, inviterName, groupName, site }: Invite): Promise<void> {
  await send({
    to,
    subject: `${oneLine(inviterName)} invited you to ${oneLine(groupName)} on Clementine`,
    text: `${inviterName} added you to ${groupName} on Clementine, where the people in it keep track of shared costs.\n\nTo join, create an account (or sign in) with this email address (${to}) at ${site}/sign-in, then accept the invitation on the Join page; signing in alone does not add you to the group.\n\nIf you were not expecting this, ignore this message.`,
  });
}

// After a group is created, emails the person it named who has not joined
// yet, at the address stored on their row. Does nothing for a one-person
// business. `me` is the creator's member row in the new group. Throws a
// UserError, having sent nothing, when the day's emails are used up.
export async function inviteFirstPartner(
  db: Db,
  send: Mailer,
  me: Member,
  site: string,
  limits: InviteLimits = inviteLimits(),
): Promise<void> {
  const [other] = await db
    .select({ id: member.id, email: member.email })
    .from(member)
    .where(and(eq(member.householdId, me.householdId), ne(member.id, me.id), isNull(member.authUserId)))
    .limit(1);
  if (!other) return;
  const [group] = await db.select({ name: household.name }).from(household).where(eq(household.id, me.householdId));
  await claimInviteEmail(db, me, other, limits);
  await sendInviteEmail(send, { to: other.email, inviterName: me.displayName, groupName: group!.name, site });
}
