import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bankConfig, bankConfigured, isPlaidError, needsRelinkError, PlaidError, plaidClient, verifyPlaidWebhook, webhookKeyCache, type PlaidWebhookKey } from "./plaid";

const key = randomBytes(32).toString("base64");
const full = { PLAID_CLIENT_ID: "client-1", PLAID_SECRET: "secret-1", ABACUS_ENCRYPTION_KEY: key };

describe("bank config", () => {
  it("is on only with an id, a secret and a 32-byte key", () => {
    expect(bankConfigured(full)).toBe(true);
    expect(bankConfigured({ ...full, PLAID_CLIENT_ID: "" })).toBe(false);
    expect(bankConfigured({ ...full, PLAID_SECRET: undefined })).toBe(false);
    expect(bankConfigured({ ...full, ABACUS_ENCRYPTION_KEY: undefined })).toBe(false);
    expect(bankConfigured({ ...full, ABACUS_ENCRYPTION_KEY: randomBytes(31).toString("base64") })).toBe(false);
  });

  it("defaults to sandbox, never production, and refuses an unknown environment", () => {
    expect(bankConfig(full)?.env).toBe("sandbox");
    expect(bankConfig({ ...full, PLAID_ENV: "production" })?.env).toBe("production");
    expect(bankConfig({ ...full, PLAID_ENV: "development" })).toBeNull();
  });
});

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function fakeFetch(reply: (path: string) => { status?: number; json: unknown }) {
  const sent: Sent[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const r = reply(new URL(url).pathname);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { sent, impl };
}

describe("plaid client", () => {
  it("posts JSON to the environment's host with the keys in headers", async () => {
    const f = fakeFetch(() => ({ json: { access_token: "access-sandbox-1", item_id: "item-1", request_id: "r1" } }));
    const plaid = plaidClient({ clientId: "client-1", secret: "secret-1", env: "sandbox" }, f.impl);
    expect(await plaid.exchangePublicToken("public-sandbox-1")).toEqual({ accessToken: "access-sandbox-1", itemId: "item-1" });
    expect(f.sent[0]!.url).toBe("https://sandbox.plaid.com/item/public_token/exchange");
    expect(f.sent[0]!.headers["PLAID-CLIENT-ID"]).toBe("client-1");
    expect(f.sent[0]!.headers["PLAID-SECRET"]).toBe("secret-1");
    expect(f.sent[0]!.body).toEqual({ public_token: "public-sandbox-1" });
  });

  it("asks for transactions on a new link, and for none in update mode", async () => {
    const f = fakeFetch(() => ({ json: { link_token: "link-1", expiration: "2026-11-14T04:00:00Z" } }));
    const plaid = plaidClient({ clientId: "c", secret: "s", env: "production" }, f.impl);
    await plaid.createLinkToken({ clientUserId: "m1" });
    await plaid.createLinkToken({ clientUserId: "m1", accessToken: "access-1" });
    expect(f.sent[0]!.url).toBe("https://production.plaid.com/link/token/create");
    expect(f.sent[0]!.body.products).toEqual(["transactions"]);
    expect(f.sent[0]!.body.account_filters).toEqual({ credit: { account_subtypes: ["credit card"] } });
    expect(f.sent[1]!.body.products).toBeUndefined();
    expect(f.sent[1]!.body.account_filters).toBeUndefined();
    expect(f.sent[1]!.body.access_token).toBe("access-1");
  });

  it("leaves the cursor out on the first sync", async () => {
    const f = fakeFetch(() => ({ json: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: false } }));
    const plaid = plaidClient({ clientId: "c", secret: "s", env: "sandbox" }, f.impl);
    await plaid.transactionsSync({ accessToken: "a" });
    await plaid.transactionsSync({ accessToken: "a", cursor: "c1" });
    expect(f.sent[0]!.body).toEqual({ access_token: "a" });
    expect(f.sent[1]!.body).toEqual({ access_token: "a", cursor: "c1" });
  });

  it("throws Plaid's code and request id, and nothing secret", async () => {
    const f = fakeFetch(() => ({
      status: 400,
      json: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "the login details changed", request_id: "req-9" },
    }));
    const plaid = plaidClient({ clientId: "c", secret: "secret-1", env: "sandbox" }, f.impl);
    const error = await plaid.getAccounts("access-sandbox-secret").catch((e: unknown) => e);
    expect(isPlaidError(error, "ITEM_LOGIN_REQUIRED")).toBe(true);
    const message = (error as Error).message;
    expect(message).toBe("Plaid /accounts/get failed: ITEM_LOGIN_REQUIRED (request req-9)");
    expect(message).not.toMatch(/secret|access-sandbox/);
  });
});

describe("webhook verification", () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...(pair.publicKey.export({ format: "jwk" }) as { x: string; y: string }), kty: "EC", crv: "P-256", alg: "ES256", kid: "kid-1" } as PlaidWebhookKey;
  const now = new Date("2026-11-14T12:00:00Z");
  const body = '{\n  "webhook_type": "TRANSACTIONS",\n  "webhook_code": "SYNC_UPDATES_AVAILABLE",\n  "item_id": "item-1"\n}';
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

  function jwt({ alg = "ES256", kid = "kid-1", iat = now.getTime() / 1000, of = body, privateKey = pair.privateKey }: { alg?: string; kid?: string; iat?: number; of?: string; privateKey?: KeyObject } = {}) {
    const signing = `${b64({ alg, kid, typ: "JWT" })}.${b64({ iat, request_body_sha256: createHash("sha256").update(of).digest("hex") })}`;
    const signature = sign("sha256", Buffer.from(signing), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return `${signing}.${signature.toString("base64url")}`;
  }
  const getKey = async (kid: string) => (kid === "kid-1" ? jwk : null);
  const check = (header: string, rawBody = body) => verifyPlaidWebhook({ rawBody, verificationHeader: header, getKey, now });

  it("accepts a good webhook and returns its body", async () => {
    expect(await check(jwt())).toEqual({ ok: true, body: JSON.parse(body) });
  });

  it("refuses a body other than the one signed, even the same JSON spaced differently", async () => {
    expect(await check(jwt(), body.replace("item-1", "item-2"))).toEqual({ ok: false, reason: "body does not match" });
    expect(await check(jwt(), JSON.stringify(JSON.parse(body)))).toEqual({ ok: false, reason: "body does not match" });
  });

  it("refuses one issued more than five minutes ago", async () => {
    expect(await check(jwt({ iat: now.getTime() / 1000 - 301 }))).toEqual({ ok: false, reason: "stale" });
    expect((await check(jwt({ iat: now.getTime() / 1000 - 299 }))).ok).toBe(true);
  });

  it("refuses any algorithm but ES256", async () => {
    expect(await check(jwt({ alg: "HS256" }))).toEqual({ ok: false, reason: "not ES256" });
    expect(await check(jwt({ alg: "none" }))).toEqual({ ok: false, reason: "not ES256" });
  });

  it("refuses a signature by another key, or a key it cannot find", async () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(await check(jwt({ privateKey: other.privateKey }))).toEqual({ ok: false, reason: "bad signature" });
    expect(await check(jwt({ kid: "kid-2" }))).toEqual({ ok: false, reason: "key not found" });
  });

  it("refuses a key Plaid has marked expired", async () => {
    const expired = async () => ({ ...jwk, expired_at: 1_800_000_000 });
    expect(await verifyPlaidWebhook({ rawBody: body, verificationHeader: jwt(), getKey: expired, now })).toEqual({ ok: false, reason: "key expired" });
  });

  it("looks up no key for a header that fails the cheap checks", async () => {
    let lookups = 0;
    const counting = async (kid: string) => (lookups++, getKey(kid));
    for (const header of ["a.b", jwt({ alg: "HS256" })]) await verifyPlaidWebhook({ rawBody: body, verificationHeader: header, getKey: counting, now });
    expect(lookups).toBe(0);
  });

  it("refuses a missing or broken header", async () => {
    expect((await verifyPlaidWebhook({ rawBody: body, verificationHeader: null, getKey, now })).ok).toBe(false);
    expect((await check("a.b")).ok).toBe(false);
  });
});

describe("webhook key cache", () => {
  const key = { alg: "ES256", crv: "P-256", kid: "kid-1", kty: "EC", x: "x", y: "y" } as PlaidWebhookKey;
  function setup() {
    let t = 0;
    const calls: string[] = [];
    const state = { down: false };
    const get = webhookKeyCache(
      {
        async getWebhookVerificationKey(kid) {
          calls.push(kid);
          if (state.down) throw new PlaidError("/webhook_verification_key/get", 503, "INTERNAL_SERVER_ERROR", "API_ERROR", null);
          if (kid !== "kid-1") throw new PlaidError("/webhook_verification_key/get", 400, "INVALID_WEBHOOK_VERIFICATION_KEY_ID", "INVALID_REQUEST", null);
          return key;
        },
      },
      () => t,
    );
    return { get, calls, state, at: (ms: number) => (t = ms) };
  }

  it("asks Plaid once for a known key, and again after an hour", async () => {
    const s = setup();
    expect(await s.get("kid-1")).toBe(key);
    expect(await s.get("kid-1")).toBe(key);
    expect(s.calls).toEqual(["kid-1"]);
    s.at(61 * 60 * 1000);
    await s.get("kid-1");
    expect(s.calls).toEqual(["kid-1", "kid-1"]);
  });

  it("remembers an unknown key for a minute", async () => {
    const s = setup();
    expect(await s.get("nope")).toBeNull();
    expect(await s.get("nope")).toBeNull();
    expect(s.calls).toEqual(["nope"]);
    s.at(61_000);
    await s.get("nope");
    expect(s.calls).toEqual(["nope", "nope"]);
  });

  it("stops calling Plaid after ten new lookups in a minute, whatever the ids", async () => {
    const s = setup();
    for (let i = 0; i < 50; i++) await s.get(`flood-${i}`);
    expect(s.calls).toHaveLength(10);
    // A key it already knows still answers, and the budget comes back.
    s.at(61_000);
    expect(await s.get("kid-1")).toBe(key);
  });

  it("keeps serving a verified key past the hour when Plaid cannot be asked", async () => {
    const s = setup();
    expect(await s.get("kid-1")).toBe(key);
    s.state.down = true;
    s.at(3 * 60 * 60 * 1000);
    expect(await s.get("kid-1")).toBe(key);
  });

  it("refreshes a known key even when forged ids have used up the budget", async () => {
    const s = setup();
    expect(await s.get("kid-1")).toBe(key);
    s.at(61 * 60 * 1000);
    for (let i = 0; i < 50; i++) await s.get(`flood-${i}`);
    expect(s.calls.filter((k) => k.startsWith("flood"))).toHaveLength(10);
    s.state.down = true;
    // Refresh is tried, fails, and the old key still answers; forged ids
    // did not stop the attempt or push the key out of memory.
    expect(await s.get("kid-1")).toBe(key);
    expect(s.calls.filter((k) => k === "kid-1")).toHaveLength(2);
    // The failed refresh is not retried on every request.
    await s.get("kid-1");
    expect(s.calls.filter((k) => k === "kid-1")).toHaveLength(2);
  });

  it("does not let many forged ids push a known key out of memory", async () => {
    const s = setup();
    await s.get("kid-1");
    for (let m = 0; m < 30; m++) {
      s.at(m * 61_000 + 1);
      for (let i = 0; i < 10; i++) await s.get(`flood-${m}-${i}`);
    }
    s.state.down = true;
    s.at(10 * 60 * 60 * 1000);
    expect(await s.get("kid-1")).toBe(key);
  });
});

describe("plaid client time limit", () => {
  it("gives every call a deadline, and reports a timeout as a transient error", async () => {
    let signal: AbortSignal | null | undefined;
    const impl = (async (_url: string, init: RequestInit) => {
      signal = init.signal;
      throw new DOMException("timed out", "TimeoutError");
    }) as unknown as typeof fetch;
    const plaid = plaidClient({ clientId: "c", secret: "s", env: "sandbox" }, impl);
    const err = await plaid.getAccounts("access-1").catch((e) => e);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(isPlaidError(err, "TIMEOUT")).toBe(true);
    expect(needsRelinkError(err)).toBe(false);
  });
});
