import { and, asc, eq, inArray, isNotNull, isNull, ne, notInArray, or } from "drizzle-orm";
import { todayIn } from "@abacus/core/dates";
import { UserError } from "@abacus/core/errors";
import { apiToken, authSession, household, mcpToken, member, type GroupKind, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";
import { checkOpenInvites, inviteLimits, type InviteLimits } from "./invite-limits.ts";

export type SignedInUser = {
  authUserId: string;
  // Only addresses the sign-in has verified. An unverified address proves nothing.
  verifiedEmails: string[];
};

// A signed-in user's member rows, one per group they belong to, oldest
// first. Empty if they have no place in any group.
//
// Members are provisioned by email: at /setup or /groups/new
// (household-setup.ts), or by scripts/provision-household.ts. That makes an
// invitation, not a membership. Nobody is linked to a group by signing in:
// the invited person has to say yes (acceptInvitation), because anyone may
// name any address when they start a group.
export async function resolveMemberships(db: Db, user: SignedInUser): Promise<Member[]> {
  const byAge = [asc(member.createdAt), asc(member.id)];
  const emails = verifiedAddresses(user);
  const linked = await db.select().from(member).where(and(eq(member.authUserId, user.authUserId), isNull(member.removedAt))).orderBy(...byAge);
  if (linked.length > 0 || emails.length === 0) return linked;
  // An invitation waiting is not a failed link.
  if ((await invitationsFor(db, user)).length > 0) return [];

  // Nothing linked and nothing waiting. If the email belongs to a member
  // linked to a different auth user, keep a record of the attempt.
  const [taken] = await db.select().from(member).where(and(inArray(member.email, emails), isNull(member.removedAt))).limit(1);
  if (taken) {
    await writeAudit(db, {
      householdId: taken.householdId,
      actor: { kind: "system" },
      action: "member.link_rejected",
      entity: { type: "member", id: taken.id },
      detail: { attemptedAuthUserId: user.authUserId },
    });
  }
  return [];
}

const verifiedAddresses = (user: SignedInUser) => user.verifiedEmails.map((e) => e.trim().toLowerCase());

export type Invitation = {
  memberId: string;
  // The name the inviter gave them.
  displayName: string;
  householdId: string;
  householdName: string;
  kind: GroupKind;
  // Display names of the people already in the group.
  members: string[];
};

// The member rows this user may take up: their verified address, nobody
// linked, not withdrawn, not an address another account has already linked
// (its remaining invitations are not handed to a second account), and not a
// group they are already in.
const takeable = async (db: Db, user: SignedInUser, emails: string[]) => {
  const theirs = db
    .select({ email: member.email })
    .from(member)
    .where(and(isNotNull(member.authUserId), ne(member.authUserId, user.authUserId), isNull(member.removedAt)));
  const mine = await db.select({ householdId: member.householdId }).from(member).where(and(eq(member.authUserId, user.authUserId), isNull(member.removedAt)));
  return and(
    inArray(member.email, emails),
    isNull(member.authUserId),
    isNull(member.inviteCancelledAt),
    notInArray(member.email, theirs),
    mine.length > 0 ? notInArray(member.householdId, mine.map((m) => m.householdId)) : undefined,
  );
};

// The invitations waiting for this person, oldest first. This runs on each
// request, so an invitation shows up without signing in again.
export async function invitationsFor(db: Db, user: SignedInUser): Promise<Invitation[]> {
  const emails = verifiedAddresses(user);
  if (emails.length === 0) return [];
  const rows = await db
    .select({
      memberId: member.id,
      displayName: member.displayName,
      householdId: household.id,
      householdName: household.name,
      kind: household.kind,
    })
    .from(member)
    .innerJoin(household, eq(household.id, member.householdId))
    .where(await takeable(db, user, emails))
    .orderBy(asc(member.createdAt), asc(member.id));
  if (rows.length === 0) return [];
  const inside = await db
    .select({ householdId: member.householdId, displayName: member.displayName })
    .from(member)
    .where(and(inArray(member.householdId, rows.map((r) => r.householdId)), isNotNull(member.authUserId), isNull(member.removedAt)))
    .orderBy(asc(member.createdAt), asc(member.id));
  return rows.map((r) => ({
    ...r,
    members: inside.filter((m) => m.householdId === r.householdId).map((m) => m.displayName),
  }));
}

const noInvitation = () => new UserError("there is no invitation waiting for you there");

// Says yes to one invitation: links this person to that one row, and no
// other. `auth_user_id is null` is in the update itself, so of two racing
// accepts only one matches the row.
// Someone added after the group began counts in its splits from this day,
// in the group's timezone (`sharesFrom` in the schema).
export async function acceptInvitation(db: Db, user: SignedInUser, memberId: string, now: Date = new Date()): Promise<Member> {
  const emails = verifiedAddresses(user);
  if (emails.length === 0) throw noInvitation();
  return db.transaction(async (tx) => {
    const [linked] = await tx
      .update(member)
      .set({ authUserId: user.authUserId, linkedAt: now })
      .where(and(eq(member.id, memberId), await takeable(tx, user, emails)))
      .returning();
    if (!linked) throw noInvitation();
    let row = linked;
    if (row.sharesFrom === null) {
      const [group] = await tx.select({ timezone: household.timezone }).from(household).where(eq(household.id, row.householdId));
      [row] = await tx.update(member).set({ sharesFrom: todayIn(group!.timezone, now) }).where(eq(member.id, row.id)).returning() as [Member];
    }
    await writeAudit(tx, {
      householdId: row.householdId,
      actor: { kind: "member", memberId: row.id },
      action: "member.linked",
      entity: { type: "member", id: row.id },
      ...(linked.sharesFrom === null ? { detail: { sharesFrom: row.sharesFrom } } : {}),
    });
    return row;
  });
}

// Says no to one invitation. The row is left as cancelInvite leaves it, so
// the group sees it as cancelled and can invite again. The audit entry names
// the row, not the address.
export async function declineInvitation(db: Db, user: SignedInUser, memberId: string): Promise<void> {
  const emails = verifiedAddresses(user);
  if (emails.length === 0) throw noInvitation();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(member)
      .set({ inviteCancelledAt: new Date() })
      .where(and(eq(member.id, memberId), await takeable(tx, user, emails)))
      .returning();
    if (!row) throw noInvitation();
    await writeAudit(tx, {
      householdId: row.householdId,
      actor: { kind: "member", memberId: row.id },
      action: "member.invite_declined",
      entity: { type: "member", id: row.id },
    });
  });
}

// A member row provisioned for an address, if any: the oldest when it is in
// several groups. A cancelled invitation does not count. An address with none can create an account only if it may
// start a group (household-setup.ts).
export async function invitedMember(db: Db, email: string): Promise<Member | null> {
  const [row] = await db
    .select()
    .from(member)
    .where(and(eq(member.email, email.trim().toLowerCase()), isNull(member.inviteCancelledAt), isNull(member.removedAt)))
    .orderBy(asc(member.createdAt), asc(member.id))
    .limit(1);
  return row ?? null;
}

// `cancelledOn` is set when the invitation was withdrawn (cancelInvite).
export type PendingInvite = { id: string; displayName: string; email: string; invitedOn: string; cancelledOn: string | null };

// The members of a group who were invited by email and have not signed in
// yet, oldest invitation first. Days are in the group's timezone. Under the
// local sign-in stand-in (dev-auth.ts) nobody is ever linked, so everyone
// but the person looking counts as invited.
export function pendingInvites(members: Member[], timezone: string): PendingInvite[] {
  return members
    .filter((m) => m.authUserId === null && m.removedAt === null)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((m) => ({
      id: m.id,
      displayName: m.displayName,
      email: m.email,
      invitedOn: todayIn(timezone, m.createdAt),
      cancelledOn: m.inviteCancelledAt ? todayIn(timezone, m.inviteCancelledAt) : null,
    }));
}

// An invitation in `me`'s group that nobody has taken up, other than their own row.
const waitingInvite = (me: Member, memberId: string) =>
  and(eq(member.id, memberId), eq(member.householdId, me.householdId), ne(member.id, me.id), isNull(member.authUserId));

// Revokes (keeps, marked revoked) every device and agent token a member made.
async function revokeTokens(tx: Db, me: Member, memberId: string, now: Date): Promise<void> {
  const devices = await tx
    .update(apiToken)
    .set({ revokedAt: now })
    .where(and(eq(apiToken.memberId, memberId), isNull(apiToken.revokedAt)))
    .returning({ id: apiToken.id, name: apiToken.name });
  for (const t of devices) {
    await writeAudit(tx, {
      householdId: me.householdId,
      actor: { kind: "member", memberId: me.id },
      action: "api_token.revoked",
      entity: { type: "api_token", id: t.id },
      detail: { name: t.name },
    });
  }
  const agents = await tx
    .update(mcpToken)
    .set({ revokedAt: now })
    .where(and(eq(mcpToken.memberId, memberId), isNull(mcpToken.revokedAt)))
    .returning({ id: mcpToken.id, permission: mcpToken.permission });
  for (const t of agents) {
    await writeAudit(tx, {
      householdId: me.householdId,
      actor: { kind: "member", memberId: me.id },
      action: "mcp_token.revoked",
      entity: { type: "mcp_token", id: t.id },
      detail: { permission: t.permission },
    });
  }
}

// Withdraws an invitation: its email no longer lets anyone into the group.
// The person stays in the group's rules and shares; reinvite reopens it.
// Any device or agent token they made is revoked (kept, marked revoked):
// token sign-in refuses them anyway, and this keeps a reinvite from bringing
// the old tokens back to life.
export async function cancelInvite(db: Db, me: Member, memberId: string): Promise<void> {
  await db.transaction(async (tx) => {
    // `auth_user_id is null` in the update itself, so a sign-in that links
    // the row first wins and the cancel is refused.
    const [row] = await tx
      .update(member)
      .set({ inviteCancelledAt: new Date() })
      .where(and(waitingInvite(me, memberId), isNull(member.inviteCancelledAt)))
      .returning();
    if (!row) throw new UserError("there is no invite waiting for that person");
    await writeAudit(tx, {
      householdId: me.householdId,
      actor: { kind: "member", memberId: me.id },
      action: "member.invite_cancelled",
      entity: { type: "member", id: row.id },
    });
    await revokeTokens(tx, me, row.id, new Date());
  });
}

// Invites a person again, at the same address or a corrected one, reopening
// the invitation if it was cancelled. Returns their row so the caller can
// write to them.
// A removed member (removeMember) can be invited again the same way: the row
// goes back to being an invitation, with their history still attached.
const reinvitable = (me: Member, memberId: string) =>
  or(waitingInvite(me, memberId), and(eq(member.id, memberId), eq(member.householdId, me.householdId), ne(member.id, me.id), isNotNull(member.removedAt)));

export async function reinvite(db: Db, me: Member, memberId: string, email: string): Promise<Member> {
  const to = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new UserError("enter an email address");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(member).where(reinvitable(me, memberId)).for("update");
    if (!before) throw new UserError("there is no invite waiting for that person");
    const [clash] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.householdId, me.householdId), eq(member.email, to), ne(member.id, memberId)));
    if (clash) throw new UserError("someone in this group already has that email");
    const [row] = await tx
      .update(member)
      .set({ email: to, inviteCancelledAt: null, authUserId: null, linkedAt: null, removedAt: null, removedBy: null })
      .where(reinvitable(me, memberId))
      .returning();
    await writeAudit(tx, {
      householdId: me.householdId,
      actor: { kind: "member", memberId: me.id },
      action: "member.invited",
      entity: { type: "member", id: row!.id },
      detail: { email: to, ...(before.email === to ? {} : { previousEmail: before.email }), ...(before.removedAt ? { afterRemoval: true } : {}) },
    });
    return row!;
  });
}

// Takes a joined member's access away. The row stays (their costs, shares and
// audit entries name it) but it stops resolving as a signed-in member
// anywhere, so signing in with the same email does not bring it back. Device
// and agent tokens are revoked, and every sign-in session of their account is
// ended; if they are in other groups they just sign in again. Only access
// changes: they still count in rules, splits, recurring costs, balances and
// payments as before. Their bank connections are disconnected by the caller
// (bank.ts disconnectBanksOf). Reinvite gives access back.
export async function removeMember(db: Db, me: Member, memberId: string, now: Date = new Date()): Promise<Member> {
  if (memberId === me.id) throw new UserError("you cannot remove yourself");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(member)
      .where(and(eq(member.id, memberId), eq(member.householdId, me.householdId), isNull(member.removedAt)))
      .for("update");
    if (!row) throw new UserError("there is no one in this group by that id");
    if (row.authUserId === null && row.linkedAt === null) {
      throw new UserError("that person has not joined; cancel their invite instead");
    }
    const [removed] = await tx
      .update(member)
      .set({ removedAt: now, removedBy: me.id, isDefault: false })
      .where(eq(member.id, row.id))
      .returning();
    await writeAudit(tx, {
      householdId: me.householdId,
      actor: { kind: "member", memberId: me.id },
      action: "member.removed",
      entity: { type: "member", id: row.id },
    });
    await revokeTokens(tx, me, row.id, now);
    if (row.authUserId !== null) await tx.delete(authSession).where(eq(authSession.userId, row.authUserId));
    return removed!;
  });
}

export type NewPerson = { displayName: string; email: string };

// Adds a person to a group that already exists. What is saved is an
// invitation: they join by accepting it, and count in the group's splits
// from that day on, never before (`sharesFrom` in the schema). Any member
// may do this. `sharesFrom` is for the local sign-in stand-in (dev-auth.ts),
// where nobody ever accepts: there the person counts from that day at once.
export async function invitePerson(
  db: Db,
  me: Member,
  input: NewPerson,
  limits: InviteLimits = inviteLimits(),
  sharesFrom: string | null = null,
): Promise<Member> {
  const displayName = input.displayName.trim().replace(/\s+/g, " ");
  const email = input.email.trim().toLowerCase();
  if (!displayName) throw new UserError("enter their name");
  if (displayName.length > 80) throw new UserError("that name is too long");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserError("enter an email address");
  return db.transaction(async (tx) => {
    await checkOpenInvites(tx, me, limits);
    const [row] = await tx
      .insert(member)
      .values({ householdId: me.householdId, displayName, email, sharesFrom })
      .onConflictDoNothing({ target: [member.householdId, member.email] })
      .returning();
    if (!row) {
      const [taken] = await tx
        .select({ cancelled: member.inviteCancelledAt, authUserId: member.authUserId })
        .from(member)
        .where(and(eq(member.householdId, me.householdId), eq(member.email, email)));
      throw new UserError(
        taken?.cancelled && !taken.authUserId
          ? "that person's invitation was cancelled; use Invite again next to their name"
          : "someone in this group already has that email",
      );
    }
    await writeAudit(tx, {
      householdId: me.householdId,
      actor: { kind: "member", memberId: me.id },
      action: "member.invited",
      entity: { type: "member", id: row.id },
      detail: { added: true },
    });
    return row;
  });
}
