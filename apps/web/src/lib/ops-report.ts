// The operator's daily email: how many people signed up, made groups and
// sent invites since the last one, and a warning when that looks like bots
// or when the daily job had failures. Sent by the daily job to
// ABACUS_OPS_EMAIL; off when that is unset.
//
// It carries counts only: no names, email addresses or amounts, so it can
// go to an inbox that is not as well kept as the database.
import { and, count, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { auditLog, authUser, household, member, opsReport } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import type { DailyJobSummary } from "./daily-job.ts";
import type { InviteLimits } from "./invite-limits.ts";
import type { Mail, Mailer } from "./mail.ts";

export type OpsSettings = {
  to: string;
  // Sign-ups in one report that count as unusual.
  signUpAlert: number;
};

export function opsSettings(env: Record<string, string | undefined> = process.env): OpsSettings | null {
  const to = env.ABACUS_OPS_EMAIL?.trim();
  if (!to) return null;
  const n = Number(env.ABACUS_OPS_SIGNUP_ALERT);
  return { to, signUpAlert: env.ABACUS_OPS_SIGNUP_ALERT && Number.isInteger(n) && n > 0 ? n : 20 };
}

export type OpsCounts = {
  signUps: number;
  unconfirmed: number;
  groupsCreated: number;
  inviteEmails: number;
  mostGroupsByOneAccount: number;
  mostInviteEmailsByOneAccount: number;
  accounts: number;
  groups: number;
};

export async function opsCounts(db: Db, start: Date, end: Date): Promise<OpsCounts> {
  const [signUps] = await db
    .select({ n: count(), unconfirmed: sql<number>`count(*) filter (where not ${authUser.emailVerified})`.mapWith(Number) })
    .from(authUser)
    .where(and(gte(authUser.createdAt, start), lt(authUser.createdAt, end)));

  // Per account, so one busy account stands out from many ordinary ones.
  const perAccount = (action: string) => {
    const account = sql`coalesce(${member.authUserId}, ${member.email})`;
    return db
      .select({ n: count() })
      .from(auditLog)
      .innerJoin(member, eq(member.id, auditLog.actorMemberId))
      .where(and(eq(auditLog.action, action), gte(auditLog.at, start), lt(auditLog.at, end)))
      .groupBy(account);
  };
  const groupsBy = await perAccount("household.created");
  const invitesBy = await perAccount("member.invite_emailed");
  const sum = (rows: { n: number }[]) => rows.reduce((t, r) => t + r.n, 0);
  const most = (rows: { n: number }[]) => rows.reduce((m, r) => Math.max(m, r.n), 0);

  const [accounts] = await db.select({ n: count() }).from(authUser);
  const [groups] = await db.select({ n: count() }).from(household);

  return {
    signUps: signUps!.n,
    unconfirmed: signUps!.unconfirmed,
    groupsCreated: sum(groupsBy),
    inviteEmails: sum(invitesBy),
    mostGroupsByOneAccount: most(groupsBy),
    mostInviteEmailsByOneAccount: most(invitesBy),
    accounts: accounts!.n,
    groups: groups!.n,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function opsWarnings(c: OpsCounts, job: DailyJobSummary | null, limits: InviteLimits, settings: OpsSettings): string[] {
  const w: string[] = [];
  if (c.signUps >= settings.signUpAlert) {
    w.push(`${c.signUps} sign-ups, at or above the ${settings.signUpAlert} set as unusual (ABACUS_OPS_SIGNUP_ALERT)`);
  }
  // Under five, one or two people who have not opened their mail yet.
  if (c.signUps >= 5 && c.unconfirmed * 2 > c.signUps) {
    w.push(`${c.unconfirmed} of ${c.signUps} new accounts never confirmed their email, which is how bot sign-ups look`);
  }
  if (c.mostGroupsByOneAccount >= limits.groupsPerDay) {
    w.push(`One account created ${c.mostGroupsByOneAccount} groups (the limit is ${limits.groupsPerDay} a day)`);
  }
  if (c.mostInviteEmailsByOneAccount >= limits.invitesPerDay) {
    w.push(`One account sent ${c.mostInviteEmailsByOneAccount} invite emails (the limit is ${limits.invitesPerDay} a day)`);
  }
  if (job && job.failed > 0) {
    w.push(`Posting recurring costs failed for ${plural(job.failed, "group")}; the server log has the error`);
  }
  if (job?.bank && job.bank.failed > 0) {
    w.push(`Syncing failed for ${plural(job.bank.failed, "bank connection")}; the server log has the error`);
  }
  return w;
}

const stamp = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function opsMail(
  settings: OpsSettings,
  c: OpsCounts,
  job: DailyJobSummary | null,
  limits: InviteLimits,
  start: Date,
  end: Date,
): Mail {
  const warnings = opsWarnings(c, job, limits, settings);
  const lead = warnings.length ? plural(warnings.length, "warning") : "all quiet";
  const lines = [
    `From ${stamp(start)} to ${stamp(end)}.`,
    "",
    ...(warnings.length ? ["Warnings", ...warnings.map((x) => `- ${x}`)] : ["No warnings."]),
    "",
    `Sign-ups: ${c.signUps} (${c.unconfirmed} not confirmed)`,
    `Groups created: ${c.groupsCreated} (most by one account: ${c.mostGroupsByOneAccount})`,
    `Invite emails sent: ${c.inviteEmails} (most by one account: ${c.mostInviteEmailsByOneAccount})`,
  ];
  if (job) {
    lines.push("", `Daily job: ${plural(job.groups, "group")} checked`, `Recurring costs posted: ${job.posted}, failed: ${job.failed}`);
    if (job.bank) {
      lines.push(`Banks synced: ${job.bank.synced}, need re-linking: ${job.bank.needsRelink}, failed: ${job.bank.failed}`);
    }
  }
  lines.push("", `All time: ${plural(c.accounts, "account")}, ${plural(c.groups, "group")}`);
  return { to: settings.to, subject: `Abacus daily: ${lead}, ${plural(c.signUps, "sign-up")}`, text: lines.join("\n") };
}

// How long a claim holds before another run may take it: long enough for
// one send to finish, short enough that a failed one is retried the same day.
const CLAIM_MS = 30 * 60 * 1000;

// Sends today's report unless it has gone out or another run is sending it.
// A failed send throws, and the next hourly run after CLAIM_MS tries again.
export async function sendOpsReport(
  db: Db,
  mailer: Mailer,
  settings: OpsSettings,
  now: Date,
  job: DailyJobSummary | null,
  limits: InviteLimits,
): Promise<"sent" | "not-due"> {
  const day = now.toISOString().slice(0, 10);
  const [last] = await db
    .select({ periodEnd: opsReport.periodEnd })
    .from(opsReport)
    .where(and(isNotNull(opsReport.sentAt), lt(opsReport.day, day)))
    .orderBy(desc(opsReport.day))
    .limit(1);
  const start = last?.periodEnd ?? new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [claim] = await db
    .insert(opsReport)
    .values({ day, periodStart: start, periodEnd: now, claimedAt: now })
    .onConflictDoUpdate({
      target: opsReport.day,
      set: { periodStart: start, periodEnd: now, claimedAt: now },
      setWhere: sql`${opsReport.sentAt} is null and ${opsReport.claimedAt} < ${new Date(now.getTime() - CLAIM_MS).toISOString()}`,
    })
    .returning({ day: opsReport.day });
  if (!claim) return "not-due";

  const counts = await opsCounts(db, start, now);
  await mailer(opsMail(settings, counts, job, limits, start, now));
  await db.update(opsReport).set({ counts, sentAt: new Date() }).where(eq(opsReport.day, day));
  return "sent";
}
