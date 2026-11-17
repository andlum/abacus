// Plaid, the service that signs in to a bank and reads its card
// transactions. Spoken to with plain fetch: every call is a JSON POST to
// https://{sandbox|production}.plaid.com/<path>. Only the calls Clementine needs
// are here, behind `PlaidApi`, which bank.ts takes as an argument so tests
// pass an in-memory fake.
//
// Nothing here logs. A failure throws a PlaidError carrying Plaid's error
// code and request id only: never a token, the secret, or a response body.
import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { parseEncryptionKey } from "./secret-box.ts";

export const PLAID_ENVS = ["sandbox", "production"] as const;
export type PlaidEnv = (typeof PLAID_ENVS)[number];

export type BankConfig = { clientId: string; secret: string; env: PlaidEnv; key: Buffer };

type Env = Record<string, string | undefined>;

// Everything connecting a bank needs, or null when anything is missing:
// self-hosters bring their own Plaid keys, and without them the Connect
// button is hidden. PLAID_ENV defaults to sandbox, never to production; any
// other value turns the feature off rather than guess.
export function bankConfig(env: Env = process.env): BankConfig | null {
  const clientId = env.PLAID_CLIENT_ID?.trim();
  const secret = env.PLAID_SECRET?.trim();
  const plaidEnv = env.PLAID_ENV?.trim() || "sandbox";
  const key = parseEncryptionKey(env.ABACUS_ENCRYPTION_KEY);
  if (!clientId || !secret || !key || !(PLAID_ENVS as readonly string[]).includes(plaidEnv)) return null;
  return { clientId, secret, env: plaidEnv as PlaidEnv, key };
}

export function bankConfigured(env: Env = process.env): boolean {
  return bankConfig(env) !== null;
}

// What /transactions/sync returns for one transaction, as Plaid names it.
// Only the fields Clementine reads.
export type PlaidTransaction = {
  transaction_id: string;
  account_id: string;
  // Positive is money out of the account; negative is money in.
  amount: number;
  iso_currency_code: string | null;
  // The posted date for a posted transaction.
  date: string;
  pending: boolean;
  merchant_name?: string | null;
  name?: string | null;
};

export type PlaidSyncPage = {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string; account_id?: string }[];
  next_cursor: string;
  has_more: boolean;
};

export type PlaidAccount = {
  account_id: string;
  name: string;
  official_name?: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
};

// A public key Plaid signs webhooks with, as /webhook_verification_key/get
// returns it.
export type PlaidWebhookKey = {
  alg: string;
  crv: string;
  kid: string;
  kty: string;
  use?: string;
  x: string;
  y: string;
  created_at?: number;
  expired_at?: number | null;
};

export interface PlaidApi {
  // A token for Plaid's sign-in window. With `accessToken`, the window
  // opens in update mode to re-link that connection.
  createLinkToken(input: { clientUserId: string; webhook?: string; redirectUri?: string; accessToken?: string }): Promise<{ linkToken: string; expiration: string }>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  transactionsSync(input: { accessToken: string; cursor?: string; count?: number }): Promise<PlaidSyncPage>;
  getAccounts(accessToken: string): Promise<PlaidAccount[]>;
  removeItem(accessToken: string): Promise<void>;
  // The bank an Item belongs to, as Plaid says, not as a browser claims.
  // Null when Plaid does not name one.
  getInstitution(accessToken: string): Promise<{ institutionId: string; name: string } | null>;
  getWebhookVerificationKey(keyId: string): Promise<PlaidWebhookKey>;
  // Sandbox only: a public token without the sign-in window.
  sandboxPublicToken(input: { institutionId: string; username?: string; password?: string }): Promise<string>;
}

export class PlaidError extends Error {
  readonly path: string;
  readonly status: number;
  readonly code: string;
  readonly type: string;
  readonly requestId: string | null;
  constructor(path: string, status: number, code: string, type: string, requestId: string | null) {
    super(`Plaid ${path} failed: ${code}${requestId ? ` (request ${requestId})` : ""}`);
    this.name = "PlaidError";
    this.path = path;
    this.status = status;
    this.code = code;
    this.type = type;
    this.requestId = requestId;
  }
}

// Item errors Plaid documents as needing the person at the bank: sign in
// again, reset a password, finish setup, unlock the account, or grant access.
// Link's update mode repairs them. Rate limits, server errors and the rest
// are left for the next run.
export const RELINK_CODES: ReadonlySet<string> = new Set([
  "ITEM_LOGIN_REQUIRED",
  "PASSWORD_RESET_REQUIRED",
  "USER_SETUP_REQUIRED",
  "ITEM_LOCKED",
  "ACCESS_NOT_GRANTED",
  "INSUFFICIENT_CREDENTIALS",
  "INVALID_CREDENTIALS",
  "USER_PERMISSION_REVOKED",
]);

export const needsRelinkError = (e: unknown): boolean => e instanceof PlaidError && RELINK_CODES.has(e.code);

export const isPlaidError = (e: unknown, code?: string): e is PlaidError => e instanceof PlaidError && (code === undefined || e.code === code);

const CALL_TIMEOUT_MS = 15_000;

const HOSTS: Record<PlaidEnv, string> = { sandbox: "https://sandbox.plaid.com", production: "https://production.plaid.com" };

// Shown in Plaid's sign-in window; at most 30 characters.
const CLIENT_NAME = "Clementine";

export function plaidClient(config: Pick<BankConfig, "clientId" | "secret" | "env">, fetchImpl: typeof fetch = fetch): PlaidApi {
  const call = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetchImpl(`${HOSTS[config.env]}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PLAID-CLIENT-ID": config.clientId,
        "PLAID-SECRET": config.secret,
        "Plaid-Version": "2020-09-14",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    }).catch((e: unknown) => {
      // A call that hangs is a transient failure, never a reason to ask the
      // person to sign in again.
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new PlaidError(path, 0, "TIMEOUT", "NETWORK", null);
      throw e;
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const text = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : null);
      throw new PlaidError(path, response.status, text("error_code") ?? "UNKNOWN", text("error_type") ?? "UNKNOWN", text("request_id"));
    }
    return data as T;
  };

  return {
    async createLinkToken({ clientUserId, webhook, redirectUri, accessToken }) {
      const r = await call<{ link_token: string; expiration: string }>("/link/token/create", {
        client_name: CLIENT_NAME,
        language: "en",
        country_codes: ["US"],
        user: { client_user_id: clientUserId },
        // Update mode names the connection and asks for no products.
        // A new link offers only banks with credit cards, and only the cards.
        ...(accessToken
          ? { access_token: accessToken }
          : { products: ["transactions"], account_filters: { credit: { account_subtypes: ["credit card"] } } }),
        ...(webhook ? { webhook } : {}),
        ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      });
      return { linkToken: r.link_token, expiration: r.expiration };
    },
    async exchangePublicToken(publicToken) {
      const r = await call<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });
      return { accessToken: r.access_token, itemId: r.item_id };
    },
    async transactionsSync({ accessToken, cursor, count }) {
      return call<PlaidSyncPage>("/transactions/sync", {
        access_token: accessToken,
        ...(cursor ? { cursor } : {}),
        ...(count ? { count } : {}),
      });
    },
    async getAccounts(accessToken) {
      return (await call<{ accounts: PlaidAccount[] }>("/accounts/get", { access_token: accessToken })).accounts;
    },
    async removeItem(accessToken) {
      await call("/item/remove", { access_token: accessToken });
    },
    async getInstitution(accessToken) {
      const item = await call<{ item: { institution_id?: string | null } }>("/item/get", { access_token: accessToken });
      const institutionId = item.item.institution_id;
      if (!institutionId) return null;
      const r = await call<{ institution: { name?: string } }>("/institutions/get_by_id", { institution_id: institutionId, country_codes: ["US"] });
      return r.institution.name ? { institutionId, name: r.institution.name } : null;
    },
    async getWebhookVerificationKey(keyId) {
      return (await call<{ key: PlaidWebhookKey }>("/webhook_verification_key/get", { key_id: keyId })).key;
    },
    async sandboxPublicToken({ institutionId, username, password }) {
      const r = await call<{ public_token: string }>("/sandbox/public_token/create", {
        institution_id: institutionId,
        initial_products: ["transactions"],
        ...(username || password ? { options: { override_username: username, override_password: password } } : {}),
      });
      return r.public_token;
    },
  };
}

export type WebhookCheck = { ok: true; body: unknown } | { ok: false; reason: string };

// Checks that a webhook came from Plaid, as Plaid's verification page lays
// out: the Plaid-Verification header is a JWT signed with ES256 by the key
// its `kid` names; it was issued at most five minutes ago; and its
// `request_body_sha256` is the SHA-256 of the exact bytes received, compared
// in constant time. `getKey` fetches (and may cache) the key for a `kid`.
export async function verifyPlaidWebhook({
  rawBody,
  verificationHeader,
  getKey,
  now,
}: {
  rawBody: string | Uint8Array;
  verificationHeader: string | null | undefined;
  getKey: (kid: string) => Promise<PlaidWebhookKey | null>;
  now: Date;
}): Promise<WebhookCheck> {
  const parts = (verificationHeader ?? "").split(".");
  if (parts.length !== 3) return { ok: false, reason: "no signature" };
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson(headerPart);
  if (!header || header.alg !== "ES256") return { ok: false, reason: "not ES256" };
  if (typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "no key id" };

  let jwk: PlaidWebhookKey | null;
  try {
    jwk = await getKey(header.kid);
  } catch {
    return { ok: false, reason: "key not found" };
  }
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256") return { ok: false, reason: "key not found" };
  if (jwk.expired_at != null) return { ok: false, reason: "key expired" };
  let signed: boolean;
  try {
    const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: "jwk" });
    signed = verify("sha256", Buffer.from(`${headerPart}.${payloadPart}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signaturePart, "base64url"));
  } catch {
    signed = false;
  }
  if (!signed) return { ok: false, reason: "bad signature" };

  const claims = decodeJson(payloadPart);
  if (!claims || typeof claims.iat !== "number") return { ok: false, reason: "no issue time" };
  const age = now.getTime() / 1000 - claims.iat;
  if (age > 5 * 60 || age < -5 * 60) return { ok: false, reason: "stale" };

  if (typeof claims.request_body_sha256 !== "string") return { ok: false, reason: "no body hash" };
  const bytes = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const actual = Buffer.from(createHash("sha256").update(bytes).digest("hex"));
  const claimed = Buffer.from(claims.request_body_sha256);
  if (actual.length !== claimed.length || !timingSafeEqual(actual, claimed)) return { ok: false, reason: "body does not match" };

  try {
    return { ok: true, body: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return { ok: false, reason: "body is not JSON" };
  }
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const KEY_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_TTL_MS = 60 * 1000;
const MAX_KEYS = 100;
const FETCHES_PER_MINUTE = 10;

type CachedKey = { key: PlaidWebhookKey | null; until: number };

// Looks up webhook verification keys through `plaid`, remembering each by
// `kid` for an hour and an unknown or failed one for a minute. Anyone can
// post a webhook with any `kid`, so lookups for ids never seen verified are
// capped at ten a minute for the whole app: past that they answer "not
// found" without calling Plaid. A key that did verify is different: it is
// refreshed after the hour outside that cap (at most one try a minute per
// id), and if the refresh fails it keeps being served, so forged ids or a
// Plaid outage cannot lock out real webhooks. (`verifyPlaidWebhook` still
// refuses a key whose `expired_at` is set.) Forgotten entries are the
// unknown ones first; a verified key is never pushed out by them.
export function webhookKeyCache(plaid: Pick<PlaidApi, "getWebhookVerificationKey">, clock: () => number = Date.now) {
  const seen = new Map<string, CachedKey>();
  let windowStart = 0;
  let fetches = 0;
  const remember = (kid: string, entry: CachedKey, now: number) => {
    if (!seen.has(kid) && seen.size >= MAX_KEYS) {
      for (const [k, v] of seen) if (!v.key && v.until <= now) seen.delete(k);
      if (seen.size >= MAX_KEYS) for (const [k, v] of seen) if (!v.key) { seen.delete(k); break; }
      if (seen.size >= MAX_KEYS) return;
    }
    seen.set(kid, entry);
  };
  return async (kid: string): Promise<PlaidWebhookKey | null> => {
    const now = clock();
    const hit = seen.get(kid);
    if (hit && hit.until > now) return hit.key;
    if (!hit?.key) {
      if (now - windowStart >= 60_000) {
        windowStart = now;
        fetches = 0;
      }
      if (fetches >= FETCHES_PER_MINUTE) return null;
      fetches++;
    }
    let key: PlaidWebhookKey | null = null;
    try {
      key = await plaid.getWebhookVerificationKey(kid);
    } catch {
      key = null;
    }
    if (hit?.key && !key) {
      // Could not refresh: keep the verified key, try again in a minute.
      seen.set(kid, { key: hit.key, until: now + UNKNOWN_TTL_MS });
      return hit.key;
    }
    remember(kid, { key, until: now + (key ? KEY_TTL_MS : UNKNOWN_TTL_MS) }, now);
    return key;
  };
}
