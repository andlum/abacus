// How much one account may do in a day that reaches other people: create
// groups and send invite emails. Without a ceiling, an account on a site
// with open sign-up could use Clementine to send mail to any address. Everything
// is counted from rows already kept (audit_log, member), so the counts
// survive a restart and hold across machines.
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { UserError } from "@abacus/core/errors";
import { auditLog, member, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";

export type InviteLimits = {
  // Groups one account may create in 24 hours.
  groupsPerDay: number;
  // Invite emails one account may send in 24 hours, across its groups.
  invitesPerDay: number;
  // Invite emails one address may receive in 24 hours, from anyone.
  perAddressPerDay: number;
  // Invitations nobody has answered, across the account's groups.
  openInvites: number;
};

export function inviteLimits(env: Record<string, string | undefined> = process.env): InviteLimits {
  const whole = (name: string, otherwise: number) => {
    const n = Number(env[name]);
    return env[name] && Number.isInteger(n) && n >= 0 ? n : otherwise;
  };
  return {
    groupsPerDay: whole("ABACUS_MAX_GROUPS_PER_DAY", 5),
    invitesPerDay: whole("ABACUS_MAX_INVITE_EMAILS_PER_DAY", 10),
    perAddressPerDay: whole("ABACUS_MAX_INVITE_EMAILS_PER_ADDRESS", 1),
    openInvites: whole("ABACUS_MAX_OPEN_INVITES", 20),
  };
}

// An account, as sign-in knows it. `authUserId` is null only under the
// local sign-in stand-in, where a person is their email.
type Person = { authUserId: string | null; email: string };

const dayBefore = (now: Date) => new Date(now.getTime() - 24 * 60 * 60 * 1000);

// The person's member rows, one per group they are in.
async function rowsOf(db: Db, who: Person): Promise<{ id: string; householdId: string }[]> {
  return db
    .select({ id: member.id, householdId: member.householdId })
    .from(member)
    .where(and(who.authUserId ? eq(member.authUserId, who.authUserId) : eq(member.email, who.email.trim().toLowerCase()), isNull(member.removedAt)));
}

async function actionsSince(db: Db, memberIds: string[], action: string, since: Date): Promise<number> {
  if (memberIds.length === 0) return 0;
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), inArray(auditLog.actorMemberId, memberIds), gt(auditLog.at, since)));
  return row!.n;
}

// Throws when this person may not create another group now. `inviting` is
// true when the new group names a second person. Call it inside the
// transaction that creates the group.
export async function checkGroupAllowance(
  tx: Db,
  who: Person,
  inviting: boolean,
  limits: InviteLimits,
  now: Date = new Date(),
): Promise<void> {
  const mine = await rowsOf(tx, who);
  if (mine.length === 0) return;
  const made = await actionsSince(tx, mine.map((m) => m.id), "household.created", dayBefore(now));
  if (made >= limits.groupsPerDay) {
    throw new UserError(`you have created ${limits.groupsPerDay} groups in a day, which is the most allowed; try again tomorrow`);
  }
  if (inviting) await checkOpenInvites(tx, who, limits);
}

// Throws when this person's groups already have as many unanswered
// invitations as allowed. Call it inside the transaction that adds one.
export async function checkOpenInvites(tx: Db, who: Person, limits: InviteLimits): Promise<void> {
  const mine = await rowsOf(tx, who);
  if (mine.length === 0) return;
  // One at a time per person, so two invitations sent at once cannot both
  // see room for one more.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"abacus.open-invites." + (who.authUserId ?? who.email.trim().toLowerCase())}))`);
  const [waiting] = await tx
    .select({ n: count() })
    .from(member)
    .where(
      and(
        inArray(member.householdId, mine.map((m) => m.householdId)),
        isNull(member.authUserId),
        isNull(member.inviteCancelledAt),
        isNull(member.removedAt),
      ),
    );
  if (waiting!.n >= limits.openInvites) {
    throw new UserError(
      `you have ${limits.openInvites} invitations still waiting for an answer, which is the most allowed; cancel some in Settings first`,
    );
  }
}

// Call before emailing an invite. Records that `me` is emailing `invitee`,
// or throws when either has had their emails for the day. Claimed before
// sending, so a failing mail server cannot be hammered either.
export async function claimInviteEmail(
  db: Db,
  me: Member,
  invitee: Pick<Member, "id" | "email">,
  limits: InviteLimits,
  now: Date = new Date(),
): Promise<void> {
  const since = dayBefore(now);
  await db.transaction(async (tx) => {
    // One claim at a time, so two at once cannot both take the last place.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('abacus.invite-email'))`);
    const [toAddress] = await tx
      .select({ n: count() })
      .from(auditLog)
      .innerJoin(member, eq(sql`${member.id}::text`, auditLog.entityId))
      .where(and(eq(auditLog.action, "member.invite_emailed"), eq(member.email, invitee.email), gt(auditLog.at, since)));
    if (toAddress!.n >= limits.perAddressPerDay) {
      throw new UserError(`${invitee.email} has already been emailed an invite in the last day; try again tomorrow`);
    }
    const mine = await rowsOf(tx, me);
    const sent = await actionsSince(tx, mine.map((m) => m.id), "member.invite_emailed", since);
    if (sent >= limits.invitesPerDay) {
      throw new UserError(`you have sent ${limits.invitesPerDay} invite emails in a day, which is the most allowed; try again tomorrow`);
    }
    await writeAudit(tx, {
      householdId: me.householdId,
      actor: { kind: "member", memberId: me.id },
      action: "member.invite_emailed",
      entity: { type: "member", id: invitee.id },
    });
  });
}
