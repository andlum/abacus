import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { nextCookies } from "better-auth/next-js";
import { getDb } from "../db/client.ts";
import { authAccount, authSchema, authSession, authUser } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { createMailer, type Mailer } from "./mail.ts";
import { canStartHousehold, signUpPolicy } from "./household-setup.ts";
import { invitedMember } from "./membership.ts";

export type AuthOptions = {
  db: Db;
  mailer: Mailer;
  // Where the app is reached from outside; verification links point here.
  baseURL?: string;
  secret?: string;
  // Lets anyone with a verified email create a household (household-setup.ts).
  openSignUp?: boolean;
  plugins?: BetterAuthPlugin[];
  // Better Auth's limiter is off outside production unless asked; tests leave
  // it off so they stay deterministic, and the rate-limit tests turn it on.
  rateLimit?: boolean;
  // The request header the client address is read from (ABACUS_CLIENT_IP_HEADER).
  // Unset means no header is trusted: every client shares one bucket per path.
  clientIpHeader?: string;
};

// Per client address and path, in seconds. Counts live in memory, so they are
// per server process and reset on restart.
const SIGN_IN_RULE = { window: 60, max: 5 }; // password guessing
const SIGN_UP_RULE = { window: 600, max: 3 }; // sends a verification email each time
const MAIL_RULE = { window: 600, max: 3 }; // reset emails go to someone else's inbox
const RESEND_RULE = { window: 3600, max: 3 }; // "send the confirmation email again"

// Set on the browser that signs up. Whoever opens the confirmation link must
// present it too, or the password typed at sign-up is thrown away: it may have
// been typed by someone who does not own the mailbox.
const SIGN_UP_COOKIE = "abacus-sign-up";
const SIGN_UP_COOKIE_SECONDS = 24 * 60 * 60;
const sign = (secret: string, userId: string) => createHmac("sha256", secret).update(`sign-up:${userId}`).digest("base64url");

function cookieValue(header: string | null | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
}

function holdsSignUpCookie(secret: string, userId: string, header: string | null | undefined): boolean {
  const given = Buffer.from(cookieValue(header, SIGN_UP_COOKIE) ?? "");
  const want = Buffer.from(`${userId}.${sign(secret, userId)}`);
  return given.length === want.length && timingSafeEqual(given, want);
}

// Sign-in with an email and a password, run by Better Auth inside the app so
// a self-hosted copy needs no outside account.
//
// An account can be created by an invited email, or by someone who may set
// up a household of their own: the first person on a fresh install, or
// anyone when sign-up is open (databaseHooks below). A password alone never
// gets anyone in: the address has to be verified by
// the emailed link first. A verified account still joins a group only when
// its owner accepts the invitation (acceptInvitation in membership.ts).
export function createAuth(opts: AuthOptions) {
  const { db, mailer } = opts;
  // Requests that opened a confirmation link without the sign-up cookie, so the
  // redirect that follows can point the person at "set a password". Lives only
  // as long as the one request, so it needs no sharing between servers.
  const withoutCookie = new WeakSet<Request>();

  const auth = betterAuth({
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    baseURL: opts.baseURL,
    secret: opts.secret,
    rateLimit: {
      enabled: opts.rateLimit ?? false,
      storage: "memory",
      customRules: {
        "/sign-in/email": SIGN_IN_RULE,
        "/sign-up/email": SIGN_UP_RULE,
        "/request-password-reset": MAIL_RULE,
        "/forget-password": MAIL_RULE,
        "/send-verification-email": RESEND_RULE,
      },
    },
    // An empty list reads no header at all, so with no trusted proxy header
    // every client falls into one shared bucket instead of choosing its own
    // with a made-up x-forwarded-for.
    advanced: { ipAddress: { ipAddressHeaders: opts.clientIpHeader ? [opts.clientIpHeader] : [] } },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await mailer({
          to: user.email,
          subject: "Reset your Clementine password",
          text: `Someone asked to reset the password for ${user.email}.\n\nIf that was you, open this link:\n${url}\n\nIf not, ignore this message; nothing changes.`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      // Runs before the account is marked verified, so the outsider's password
      // is already gone when it first becomes usable. A failure here aborts the
      // verification (the endpoint awaits it with no catch).
      beforeEmailVerification: async (user, request) => {
        // The member's provisioned name is the one the household knows. It is
        // applied here, not at sign-up, so the sign-up reply says nothing about it.
        const invited = await invitedMember(db, user.email);
        if (invited) await db.update(authUser).set({ name: invited.displayName }).where(eq(authUser.id, user.id));
        const secret = (await auth.$context).secret;
        if (request && holdsSignUpCookie(secret, user.id, request.headers.get("cookie"))) return;
        // Not the browser that signed up: the password may be an outsider's.
        // Whoever has the mailbox stays signed in and sets their own.
        await db.delete(authAccount).where(and(eq(authAccount.userId, user.id), eq(authAccount.providerId, "credential")));
        await db.delete(authSession).where(eq(authSession.userId, user.id));
        if (request) withoutCookie.add(request);
      },
      sendVerificationEmail: async ({ user, url }) => {
        // Not awaited, so an invited address answers as fast as any other and the
        // reply's timing does not reveal it. A failure is logged, not shown.
        mailer({
          to: user.email,
          subject: "Confirm your email for Clementine",
          text: `Open this link to confirm ${user.email} and sign in:\n${url}\n\nIf you did not create an Clementine account, ignore this message.`,
        }).catch((e) => console.error("Could not send the confirmation email", e));
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const invited = await invitedMember(db, user.email);
            // The sign-up reply must look the same for every address, so nothing
            // from the member row goes into the account here (the name is applied
            // when the email is confirmed).
            if (invited) return;
            // Not invited: welcome only if they may start a household (/setup).
            if (await canStartHousehold(db, { openSignUp: opts.openSignUp ?? false })) return;
            // 403 is the one status Better Auth turns into its ordinary sign-up
            // reply, so nobody can tell which addresses were invited.
            throw new APIError("FORBIDDEN");
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-up/email") {
          // Every reply gets one, invited or not: the id in a stand-in reply is
          // random, so its cookie matches no account and does nothing.
          const id = (ctx.context.returned as { user?: { id?: string } } | undefined)?.user?.id;
          if (!id) return;
          ctx.setCookie(SIGN_UP_COOKIE, `${id}.${sign(ctx.context.secret, id)}`, {
            httpOnly: true,
            sameSite: "lax",
            secure: ctx.context.baseURL.startsWith("https:"),
            path: "/",
            maxAge: SIGN_UP_COOKIE_SECONDS,
          });
        } else if (ctx.path === "/verify-email") {
          if (ctx.request && withoutCookie.has(ctx.request)) throw ctx.redirect("/sign-in?notice=set-password");
        }
      }),
    },
    plugins: opts.plugins ?? [],
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

// One instance per server process, built on first use so that `next build`
// can import the route without a database or SMTP settings.
const globalForAuth = globalThis as typeof globalThis & { __abacusAuth?: Auth };

export function getAuth(): Auth {
  if (!globalForAuth.__abacusAuth) {
    globalForAuth.__abacusAuth = createAuth({
      db: getDb(),
      mailer: createMailer(),
      openSignUp: signUpPolicy().openSignUp,
      plugins: [nextCookies()],
      rateLimit: true,
      clientIpHeader: process.env.ABACUS_CLIENT_IP_HEADER || undefined,
    });
  }
  return globalForAuth.__abacusAuth;
}
