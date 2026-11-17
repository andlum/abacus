import { and, asc, eq, isNull } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "@/db/client";
import { household, member, type Member } from "@/db/schema";
import { isIsoDate, todayIn } from "@abacus/core/dates";
import { getAuth } from "./auth.ts";
import { DEV_AUTH_COOKIE, DEV_TODAY_COOKIE, devAuthEnabled } from "./dev-auth.ts";
import { canStartHousehold, signUpPolicy, type Founder } from "./household-setup.ts";
import { currentMembership, groupsFor } from "./groups.ts";
import { listAccounts } from "./accounts";
import { listCategories } from "./categories";
import { invitationsFor, resolveMemberships, type Invitation, type SignedInUser } from "./membership.ts";

// Remembers which group a person switched to. Holds a group id; one that is
// not theirs is ignored (currentMembership).
export const GROUP_COOKIE = "abacus_group";

// Who is asking, worked out once per request: every group they are in, the
// one this request acts in, and what they would need to start another.
const whoIsAsking = cache(async () => {
  const db = getDb();
  const jar = await cookies();

  // The local stand-in has no accounts: the cookie names a member row, and
  // rows with the same email are the same person in other groups.
  if (devAuthEnabled()) {
    const id = jar.get(DEV_AUTH_COOKIE)?.value;
    const [m] = id && /^[0-9a-f-]{36}$/.test(id) ? await db.select().from(member).where(and(eq(member.id, id), isNull(member.removedAt))) : [];
    if (!m) redirect("/dev-sign-in");
    const memberships = await db
      .select()
      .from(member)
      .where(and(eq(member.email, m.email), isNull(member.removedAt)))
      .orderBy(asc(member.createdAt), asc(member.id));
    return { memberships, current: m as Member | null, founder: { authUserId: null, email: m.email } as Founder | null, mayStart: false, invitations: [] as Invitation[], user: null as SignedInUser | null };
  }

  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  // Sign-in already requires a verified email, so this is belt and braces:
  // an unverified address must never link a member or found a group.
  const { user } = session;
  const signedIn: SignedInUser = { authUserId: user.id, verifiedEmails: user.emailVerified ? [user.email] : [] };
  const memberships = await resolveMemberships(db, signedIn);
  const invitations = await invitationsFor(db, signedIn);
  const current = currentMembership(memberships, jar.get(GROUP_COOKIE)?.value);
  const founder: Founder | null = user.emailVerified ? { authUserId: user.id, email: user.email } : null;
  const mayStart = !!founder && (await canStartHousehold(db, signUpPolicy()));
  return { memberships, current, founder, mayStart, invitations, user: signedIn as SignedInUser | null };
});

// The signed-in person's member row in the group they are working in. Every
// page and action that touches group data starts here. A signed-in user with
// no member row is sent to /invitations if one is waiting for them, else to
// /setup if they may start a group, and to /not-invited otherwise.
export async function requireMember(): Promise<Member> {
  const { current, mayStart, invitations } = await whoIsAsking();
  if (!current) redirect(invitations.length > 0 ? "/invitations" : mayStart ? "/setup" : "/not-invited");
  return current;
}

// For /invitations: the invitations waiting for the signed-in person, and
// what else they could do. Nothing waiting sends them where they belong.
export async function requireInvitee() {
  const { current, mayStart, invitations } = await whoIsAsking();
  const hasGroup = current !== null;
  if (invitations.length === 0) redirect(hasGroup ? "/" : mayStart ? "/setup" : "/not-invited");
  return { invitations, hasGroup, mayStart };
}

// For the actions behind /invitations. Unlike requireInvitee it does not
// redirect when nothing is waiting, so a stale click gets an error message.
export async function requireSignedInUser() {
  const { user } = await whoIsAsking();
  if (!user) redirect("/");
  return { db: getDb(), user };
}

// For the group switcher and /groups/new: the person's member row here, their
// rows in every group, and who they are when they add a group.
export async function requireGroups() {
  const me = await requireMember();
  const { memberships, founder, invitations } = await whoIsAsking();
  const db = getDb();
  return { me, db, memberships, groups: await groupsFor(db, memberships), founder: founder!, invitations };
}

// For /setup: someone signed in with a verified email who is in no group
// yet and may start one. Anyone else is sent where they belong.
export async function requireFounder(): Promise<Founder> {
  if (devAuthEnabled()) redirect("/dev-sign-in");
  const { current, founder, mayStart } = await whoIsAsking();
  if (current) redirect("/");
  if (!mayStart || !founder) redirect("/not-invited");
  return founder;
}

// With the sign-in stand-in on, a cookie can set the date, so a browser test
// or a person trying the app can see what happens on a due date.
async function devToday(): Promise<string | null> {
  if (!devAuthEnabled()) return null;
  const value = (await cookies()).get(DEV_TODAY_COOKIE)?.value;
  return value && isIsoDate(value) ? value : null;
}

// The member, their group, its members, and today's date where the group
// lives. What nearly every page and action needs first.
export async function requireHousehold() {
  const me = await requireMember();
  const db = getDb();
  const [home] = await db.select().from(household).where(eq(household.id, me.householdId));
  const members = await db
    .select()
    .from(member)
    .where(eq(member.householdId, me.householdId))
    .orderBy(member.id);
  // Every category of the group, removed ones too: old costs name them.
  const categories = await listCategories(db, me.householdId, { removed: true });
  // Every account too, for the same reason.
  const accounts = await listAccounts(db, me.householdId, { archived: true });
  return { me, db, home: home!, members, categories, accounts, today: (await devToday()) ?? todayIn(home!.timezone, new Date()) };
}
