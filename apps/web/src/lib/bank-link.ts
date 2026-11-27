// The web side of connecting a bank: what the Settings and Home screens show,
// the link token for Plaid's sign-in window, re-linking, and Plaid's
// webhooks. The money and sorting rules are in bank.ts; this file only
// decides who may do what and what a webhook means.
//
// Nothing here returns or logs an access token, a public token, or a webhook
// body.
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { account, bankConnection, bankTransaction, type Account, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { UserError } from "@abacus/core/errors";
import { writeAudit } from "./audit.ts";
import { markNeedsRelink, syncConnection, type BankDeps, type ToSort } from "./bank.ts";
import { e2eBankRuntime } from "./e2e-plaid.ts";
import { isUuid } from "./ids.ts";
import { bankConfig, plaidClient, RELINK_CODES, verifyPlaidWebhook, webhookKeyCache, type PlaidWebhookKey } from "./plaid.ts";
import { openSecret } from "./secret-box.ts";

type Env = Record<string, string | undefined>;

// The runtime, or a refusal in plain words when this server has no Plaid keys.
export function requireBank(runtime: BankRuntime | null): BankRuntime {
  if (!runtime) throw new UserError("connecting a bank is not set up on this server");
  return runtime;
}

export type BankRuntime = BankDeps & { getKey: (kid: string) => Promise<PlaidWebhookKey | null> };

let memo: { id: string; runtime: BankRuntime } | null = null;

// Plaid, its key and the webhook key cache, from the environment; null when
// connecting a bank is not set up, so every screen can hide it. Kept between
// calls so the key cache is shared.
export function bankRuntime(env: Env = process.env): BankRuntime | null {
  // The browser tests' fake Plaid; null unless ABACUS_E2E and ABACUS_E2E_FAKE_PLAID are both on.
  const fake = e2eBankRuntime(env);
  if (fake) return fake;
  const config = bankConfig(env);
  if (!config) return null;
  const id = `${config.clientId}|${config.secret}|${config.env}|${config.key.toString("base64")}`;
  if (memo?.id !== id) {
    const plaid = plaidClient(config);
    memo = { id, runtime: { plaid, key: config.key, getKey: webhookKeyCache(plaid) } };
  }
  return memo.runtime;
}

// Where Plaid sends webhooks, only when the app knows a public https address
// (BETTER_AUTH_URL, the one the app already uses for its links). Plaid cannot
// reach a localhost address, so without one webhooks are left off and the
// daily sync picks up changes.
export function webhookUrl(env: Env = process.env): string | undefined {
  const base = env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "");
  return base?.startsWith("https://") ? `${base}/api/plaid/webhook` : undefined;
}

// ---- Link ------------------------------------------------------------------

// A token for Plaid's sign-in window. For a new connection, any member may.
// With `connectionId`, the window opens in update mode for that connection,
// and only its owner may. Plaid is told the member's id and nothing else
// about them.
export async function startLink(
  db: Db,
  bank: BankDeps,
  actor: Member,
  { connectionId, webhook }: { connectionId?: string; webhook?: string } = {},
): Promise<{ linkToken: string }> {
  let accessToken: string | undefined;
  if (connectionId !== undefined) {
    const connection = await ownConnection(db, actor, connectionId);
    accessToken = openSecret(connection.accessToken!, bank.key);
  }
  const { linkToken } = await bank.plaid.createLinkToken({ clientUserId: actor.id, ...(webhook ? { webhook } : {}), ...(accessToken ? { accessToken } : {}) });
  return { linkToken };
}

async function ownConnection(db: Db, actor: Member, connectionId: string) {
  const notYours = new UserError("only the person who connected that bank can do this");
  if (!isUuid(connectionId)) throw notYours;
  const [connection] = await db
    .select()
    .from(bankConnection)
    .where(and(eq(bankConnection.id, connectionId), eq(bankConnection.householdId, actor.householdId), eq(bankConnection.ownerId, actor.id)));
  if (!connection) throw notYours;
  if (connection.removedAt || !connection.accessToken) throw new UserError("that bank is no longer connected");
  return connection;
}

// After the owner signs in again: the connection is ok, and a sync reads
// what was missed. A sync that fails is left for the next run; the sign-in
// itself worked. Plaid's access token does not change in update mode, so
// there is nothing to exchange.
export async function finishRelink(db: Db, bank: BankDeps, actor: Member, connectionId: string, now: Date): Promise<void> {
  const connection = await ownConnection(db, actor, connectionId);
  await db.transaction(async (tx) => {
    const changed = await tx
      .update(bankConnection)
      .set({ status: "ok" })
      .where(and(eq(bankConnection.id, connection.id), eq(bankConnection.status, "needs_relink")))
      .returning({ id: bankConnection.id });
    if (changed.length > 0) {
      await writeAudit(tx, {
        householdId: actor.householdId,
        actor: { kind: "member", memberId: actor.id },
        action: "bank_connection.reconnected",
        entity: { type: "bank_connection", id: connection.id },
        detail: {},
      });
    }
  });
  try {
    await syncConnection(db, bank, connection.id, now);
  } catch (e) {
    console.error(`bank: sync after re-linking failed: ${e instanceof Error ? e.message : "unknown error"}`);
  }
}

// ---- What the screens show -------------------------------------------------

export type ConnectionView = {
  id: string;
  institutionName: string;
  status: "ok" | "needs_relink";
  lastSyncedAt: Date | null;
  accounts: Account[];
};

// The live connections `actor` made, with their cards, and nothing secret.
export async function listConnections(db: Db, actor: Member): Promise<ConnectionView[]> {
  const connections = await db
    .select({
      id: bankConnection.id,
      institutionName: bankConnection.institutionName,
      status: bankConnection.status,
      lastSyncedAt: bankConnection.lastSyncedAt,
    })
    .from(bankConnection)
    .where(and(eq(bankConnection.householdId, actor.householdId), eq(bankConnection.ownerId, actor.id), isNull(bankConnection.removedAt)))
    .orderBy(asc(bankConnection.createdAt));
  const cards = await db
    .select()
    .from(account)
    .where(and(eq(account.householdId, actor.householdId), isNull(account.archivedAt)))
    .orderBy(asc(account.name));
  return connections.map((c) => ({ ...c, accounts: cards.filter((a) => a.bankConnectionId === c.id) }));
}

// Money out and money in the actor set aside, newest first, from connections
// that are still live (a disconnected bank's cannot be restored).
export async function listSetAside(db: Db, actor: Member): Promise<ToSort[]> {
  const rows = await db
    .select({ t: bankTransaction, accountName: account.name, lastFour: account.lastFour, institutionName: bankConnection.institutionName })
    .from(bankTransaction)
    .innerJoin(bankConnection, eq(bankConnection.id, bankTransaction.connectionId))
    .innerJoin(account, eq(account.id, bankTransaction.accountId))
    .where(
      and(
        eq(bankTransaction.householdId, actor.householdId),
        eq(bankConnection.householdId, actor.householdId),
        eq(bankConnection.ownerId, actor.id),
        isNull(bankConnection.removedAt),
        eq(bankTransaction.state, "dismissed"),
      ),
    )
    .orderBy(desc(bankTransaction.date), asc(bankTransaction.plaidTransactionId))
    .limit(100);
  return rows.map((r) => ({ ...r.t, accountName: r.accountName, lastFour: r.lastFour, institutionName: r.institutionName }));
}

// ---- Webhooks --------------------------------------------------------------

export type WebhookOutcome = "synced" | "needs_relink" | "ignored";

// PENDING_EXPIRATION and PENDING_DISCONNECT are not here on purpose: they
// warn of a failure a week away, the next good sync would flip the mark
// back, and the notice would flicker. When the login does fail later, that
// error marks the connection. Plaid says update mode may not always be able
// to restore a revoked permission; if it cannot, linking again from
// Disconnect then Connect a bank is the way.
const RELINK_WEBHOOKS = new Set(["USER_PERMISSION_REVOKED"]);

// What a verified webhook means for the connection it names. Anything else,
// or an item we do not have, is ignored.
export async function applyPlaidWebhook(db: Db, bank: BankDeps, body: unknown, now: Date): Promise<WebhookOutcome> {
  if (!body || typeof body !== "object") return "ignored";
  const { webhook_type: type, webhook_code: code, item_id: itemId, error } = body as Record<string, unknown>;
  if (typeof itemId !== "string") return "ignored";
  const [connection] = await db
    .select({ id: bankConnection.id, householdId: bankConnection.householdId })
    .from(bankConnection)
    .where(and(eq(bankConnection.itemId, itemId), isNull(bankConnection.removedAt)));
  if (!connection) return "ignored";

  if (type === "TRANSACTIONS" && code === "SYNC_UPDATES_AVAILABLE") {
    await syncConnection(db, bank, connection.id, now);
    return "synced";
  }
  const errorCode = error && typeof error === "object" ? (error as Record<string, unknown>).error_code : undefined;
  const broken =
    type === "ITEM" && ((code === "ERROR" && typeof errorCode === "string" && RELINK_CODES.has(errorCode)) || (typeof code === "string" && RELINK_WEBHOOKS.has(code)));
  if (broken) {
    await markNeedsRelink(db, connection.householdId, connection.id);
    return "needs_relink";
  }
  return "ignored";
}

const MAX_WEBHOOK_BYTES = 1_000_000;

async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return new Uint8Array(Buffer.concat(parts));
}

// Plaid's webhook, as an HTTP request. Plaid's own docs do not say what to
// answer a webhook that fails verification; 401 with no body, so nothing is
// told to whoever sent it. A webhook that verifies but cannot be handled
// answers 500 so Plaid sends it again; the daily sync is the backstop.
export async function handlePlaidWebhookRequest(
  req: Request,
  { db, runtime, now = new Date() }: { db: Db; runtime: BankRuntime | null; now?: Date },
): Promise<Response> {
  if (!runtime) return new Response(null, { status: 404 });
  // Cheap checks before any body is read.
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_WEBHOOK_BYTES) return new Response(null, { status: 413 });
  const verification = req.headers.get("plaid-verification");
  if (!verification || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(verification)) return new Response(null, { status: 401 });
  // The bytes as received: the signature covers them exactly. Reading stops
  // at the limit, so a body with no length header is not buffered whole.
  const raw = await readLimited(req, MAX_WEBHOOK_BYTES);
  if (!raw) return new Response(null, { status: 413 });
  const check = await verifyPlaidWebhook({ rawBody: raw, verificationHeader: verification, getKey: runtime.getKey, now });
  if (!check.ok) return new Response(null, { status: 401 });
  try {
    await applyPlaidWebhook(db, runtime, check.body, now);
  } catch (e) {
    console.error(`bank: a webhook could not be handled: ${e instanceof Error ? e.name : "error"}`);
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
}
