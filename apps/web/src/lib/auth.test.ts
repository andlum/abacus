import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authAccount, authSession, authUser } from "@/db/schema";
import { createTestDb, seedHousehold } from "@/db/test-db";
import type { Db } from "@/db/types";
import { createAuth, type Auth } from "./auth";
import type { Mail } from "./mail";
import { invitationsFor } from "./membership";

let db: Db;
let auth: Auth;
let outbox: Mail[];

const BASE = "http://abacus.test";

beforeEach(async () => {
  db = await createTestDb();
  await seedHousehold(db);
  outbox = [];
  auth = createAuth({
    db,
    mailer: async (mail) => {
      outbox.push(mail);
    },
    baseURL: BASE,
    secret: "test-secret-test-secret-test-secret-00",
  });
});

const signUp = (email: string) =>
  auth.api.signUpEmail({ body: { email, password: "correct horse battery", name: "whoever" } });

const signIn = (email: string) =>
  auth.api.signInEmail({ body: { email, password: "correct horse battery" }, asResponse: true });

// Follows the link in the last email the way a browser would.
async function openLastLink(cookie = ""): Promise<Response> {
  const url = outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0];
  return auth.handler(new Request(url, { redirect: "manual", headers: cookie ? { cookie } : {} }));
}

// Signs up through HTTP, as a browser does, so the sign-up cookie comes back.
async function signUpInBrowser(email: string) {
  const res = await auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: "correct horse battery", name: "whoever" }),
    }),
  );
  return {
    user: (await res.json()).user as { id: string },
    cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "),
  };
}

describe("sign-up", () => {
  it("creates an account for an invited email, keeps the submitted name, and emails a verification link", async () => {
    const res = await signUp("Alex@Example.com");

    expect(res.user).toMatchObject({ email: "alex@example.com", name: "whoever", emailVerified: false });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: "alex@example.com", subject: expect.stringMatching(/confirm/i) });
    expect(outbox[0]!.text).toContain(`${BASE}/api/auth/verify-email?token=`);
  });

  it("names the account after the member once the email is confirmed", async () => {
    const { user, cookie } = await signUpInBrowser("alex@example.com");
    await openLastLink(cookie);
    const [row] = await db.select().from(authUser).where(eq(authUser.id, user.id));
    expect(row?.name).toBe("Alex");
  });

  it("answers invited, uninvited and already-registered addresses identically, and sends and creates nothing for the last two", async () => {
    const send = (email: string) =>
      auth.handler(
        new Request(`${BASE}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE },
          body: JSON.stringify({ email, password: "correct horse battery", name: "x" }),
        }),
      );
    // Everything that may legitimately differ: the random id, the timestamps,
    // and the cookie's signature (its length is compared instead).
    const mask = (b: any) => ({
      ...b,
      user: { ...b.user, id: "ID", createdAt: "T", updatedAt: "T", email: "E" },
    });
    const shape = async (res: Response) => ({
      status: res.status,
      headers: [...res.headers.keys()].sort(),
      cookie: res.headers.getSetCookie().map((c) => c.replace(/=[^;]*/, (v) => `=${"*".repeat(v.length)}`)),
      body: mask(await res.json()),
    });

    const invited = await send("alex@example.com");
    const invitedShape = await shape(invited);
    // sam is invited too; sign him up, then try again so he is already registered.
    await send("sam@example.com");
    outbox.length = 0;
    const registered = await shape(await send("sam@example.com"));
    const stranger = await shape(await send("stranger@example.com"));

    expect(invitedShape.cookie).toHaveLength(1);
    expect(invitedShape.cookie[0]).toMatch(/^abacus-sign-up=/);
    expect(stranger).toEqual(invitedShape);
    expect(registered).toEqual(invitedShape);
    expect(invitedShape.body.user.name).toBe("x");
    expect(outbox).toHaveLength(0);
    expect(await db.select().from(authUser).where(eq(authUser.email, "stranger@example.com"))).toHaveLength(0);
  });
});

describe("sign-in", () => {
  it("is refused until the email is verified", async () => {
    await signUp("alex@example.com");
    const res = await signIn("alex@example.com");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });

  it("works once the emailed link has been opened, and then has an invitation waiting", async () => {
    const { user, cookie: browser } = await signUpInBrowser("alex@example.com");
    const verified = await openLastLink(browser);
    expect(verified.status).toBeGreaterThanOrEqual(300);
    expect(verified.status).toBeLessThan(400);

    const res = await signIn("alex@example.com");
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("better-auth.session_token=");

    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookie! }) });
    expect(session?.user).toMatchObject({ id: user.id, emailVerified: true });

    const [inv] = await invitationsFor(db, { authUserId: user.id, verifiedEmails: [session!.user.email] });
    expect(inv?.displayName).toBe("Alex");
  });
});

const post = (path: string, body: object, headers: Record<string, string> = {}) =>
  auth.handler(
    new Request(`${BASE}/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...headers },
      body: JSON.stringify(body),
    }),
  );

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

describe("an invited address that someone else signed up first", () => {
  const PASSWORD = "correct horse battery";

  const signUpFromBrowser = async (email: string) => {
    const res = await post("sign-up/email", { email, password: PASSWORD, name: "x" });
    return cookiesOf(res);
  };
  const verify = (cookie: string) => {
    const url = outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0];
    return auth.handler(new Request(url, { redirect: "manual", headers: cookie ? { cookie } : {} }));
  };
  const credential = async (email: string) => {
    const [u] = await db.select().from(authUser).where(eq(authUser.email, email));
    const rows = await db.select().from(authAccount).where(eq(authAccount.userId, u!.id));
    return { id: u!.id, accounts: rows.filter((a) => a.providerId === "credential") };
  };

  it("keeps the password when the link is opened in the browser that signed up", async () => {
    const raw = await post("sign-up/email", { email: "alex@example.com", password: PASSWORD, name: "x" });
    const header = raw.headers.getSetCookie().find((c) => c.startsWith("abacus-sign-up="))!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    const cookie = cookiesOf(raw);
    const res = await verify(cookie);
    expect(res.headers.get("location")).not.toContain("notice=");
    expect((await signIn("alex@example.com")).status).toBe(200);
  });

  it("drops the password when the link is opened anywhere else, keeping only the opener signed in", async () => {
    await signUpFromBrowser("alex@example.com");
    const res = await verify("");
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain("/sign-in?notice=set-password");

    const { id, accounts } = await credential("alex@example.com");
    expect(accounts).toHaveLength(0);
    expect((await signIn("alex@example.com")).status).toBe(401);

    // The person who opened the link is signed in.
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookiesOf(res) }) });
    expect(session?.user).toMatchObject({ id, emailVerified: true });
    expect(await db.select().from(authSession).where(eq(authSession.userId, id))).toHaveLength(1);
  });

  it("ignores a cookie that was made for another account", async () => {
    await signUpFromBrowser("alex@example.com");
    const sam = await signUpFromBrowser("sam@example.com");
    outbox.splice(0, outbox.length, outbox.find((m) => m.to === "alex@example.com")!);
    const res = await verify(sam);
    expect(res.headers.get("location")).toContain("notice=set-password");
  });

  it("lets the owner choose a password with the reset link afterwards", async () => {
    await signUpFromBrowser("alex@example.com");
    await verify("");
    outbox.length = 0;
    await post("request-password-reset", { email: "alex@example.com", redirectTo: "/sign-in" });
    const url = outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0];
    const token = (await auth.handler(new Request(url, { redirect: "manual" }))).headers.get("location")!.match(/token=([^&]+)/)![1]!;
    const reset = await post("reset-password", { newPassword: "a brand new password", token });
    expect(reset.status).toBe(200);

    const ok = await auth.api.signInEmail({ body: { email: "alex@example.com", password: "a brand new password" }, asResponse: true });
    expect(ok.status).toBe(200);
  });
});

describe("password reset", () => {
  it("signs out every session", async () => {
    const { cookie: browser } = await signUpInBrowser("alex@example.com");
    await openLastLink(browser);
    const first = cookiesOf(await signIn("alex@example.com"));
    expect(await auth.api.getSession({ headers: new Headers({ cookie: first }) })).not.toBeNull();

    outbox.length = 0;
    await post("request-password-reset", { email: "alex@example.com", redirectTo: "/sign-in" });
    const url = outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0];
    const token = (await auth.handler(new Request(url, { redirect: "manual" }))).headers.get("location")!.match(/token=([^&]+)/)![1]!;
    await post("reset-password", { newPassword: "a brand new password", token });

    expect(await auth.api.getSession({ headers: new Headers({ cookie: first }) })).toBeNull();
  });
});

describe("sign-in of an unverified account", () => {
  it("does not send a confirmation email by itself", async () => {
    await signUp("alex@example.com");
    outbox.length = 0;
    const res = await signIn("alex@example.com");
    expect(res.status).toBe(403);
    expect(outbox).toHaveLength(0);
  });
});

describe("sign-up without an invitation", () => {
  const build = (database: Db, openSignUp: boolean) =>
    createAuth({
      db: database,
      mailer: async (mail) => {
        outbox.push(mail);
      },
      baseURL: BASE,
      secret: "test-secret-test-secret-test-secret-00",
      openSignUp,
    });
  const join = (a: Auth, email: string) =>
    a.api.signUpEmail({ body: { email, password: "correct horse battery", name: "Jo" } });

  it("is allowed while no household exists, so the first person can set one up", async () => {
    const empty = await createTestDb();
    const res = await join(build(empty, false), "jo@example.com");

    expect(res.user).toMatchObject({ email: "jo@example.com", name: "Jo", emailVerified: false });
    expect(outbox).toHaveLength(1);
  });

  it("is allowed alongside existing households when sign-up is open", async () => {
    const res = await join(build(db, true), "jo@example.com");
    expect(res.user.email).toBe("jo@example.com");
  });

  it("still lets an invited person sign up when sign-up is open", async () => {
    const res = await join(build(db, true), "alex@example.com");
    expect(res.user.email).toBe("alex@example.com");
  });
});

describe("rate limiting", () => {
  // Better Auth keeps its counts in one store shared by every instance in the
  // process, so each test uses its own addresses.
  const build = (clientIpHeader?: string) =>
    createAuth({
      db,
      mailer: async (mail) => {
        outbox.push(mail);
      },
      baseURL: BASE,
      secret: "test-secret-test-secret-test-secret-00",
      rateLimit: true,
      clientIpHeader,
    });

  const post = (a: Auth, path: string, body: object, headers: Record<string, string>) =>
    a.handler(
      new Request(`${BASE}/api/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, ...headers },
        body: JSON.stringify(body),
      }),
    );

  const wrongPassword = (a: Auth, headers: Record<string, string>) =>
    post(a, "sign-in/email", { email: "alex@example.com", password: "wrong" }, headers);

  it("refuses sign-in after five tries a minute from one address, and leaves other addresses alone", async () => {
    const a = build("x-real-ip");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await wrongPassword(a, { "x-real-ip": "203.0.113.1" })).status);
    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses[5]).toBe(429);

    expect((await wrongPassword(a, { "x-real-ip": "203.0.113.2" })).status).not.toBe(429);
  });

  it("with a client address header set, a made-up x-forwarded-for does not reset the count", async () => {
    const a = build("fly-client-ip");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await wrongPassword(a, { "fly-client-ip": "203.0.113.10", "x-forwarded-for": `198.51.100.${i + 1}` })).status,
      );
    }
    expect(statuses[5]).toBe(429);
  });

  it("without it, a made-up x-forwarded-for does not reset the count", async () => {
    const a = build();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await wrongPassword(a, { "x-forwarded-for": `198.51.100.${i + 20}` })).status);
    expect(statuses[5]).toBe(429);
  });

  it("stops a burst of verification emails", async () => {
    const a = build("fly-client-ip");
    await a.api.signUpEmail({ body: { email: "alex@example.com", password: "correct horse battery", name: "x" } });
    outbox.length = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(
        (await post(a, "send-verification-email", { email: "alex@example.com" }, { "fly-client-ip": "203.0.113.30" })).status,
      );
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    expect(outbox).toHaveLength(3);
  });

  it("allows only three requests for a confirmation email an hour", async () => {
    const a = build("fly-client-ip");
    const rule = a.options.rateLimit?.customRules?.["/send-verification-email"];
    expect(rule).toEqual({ window: 3600, max: 3 });
  });
});
