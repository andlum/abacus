import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, bankConnection, bankTransaction, household, member, type Member } from "@/db/schema";
import { connectBank, dismissBankTransaction, syncConnection, type BankDeps } from "./bank";
import {
  applyPlaidWebhook,
  bankRuntime,
  finishRelink,
  handlePlaidWebhookRequest,
  listConnections,
  listSetAside,
  requireBank,
  startLink,
  webhookUrl,
  type BankRuntime,
} from "./bank-link";
import { seedCategories } from "./categories";
import type { PlaidWebhookKey } from "./plaid";
import { fakePlaid, txn } from "./testing/fake-plaid";
import { createWorld, type World } from "./testing/world";

const NOW = new Date("2027-03-10T15:00:00Z");
const FROM = "2027-03-01";

let w: World;
let fake: ReturnType<typeof fakePlaid>;
let bank: BankDeps;

beforeEach(async () => {
  w = await createWorld();
  fake = fakePlaid();
  bank = { plaid: fake.plaid, key: randomBytes(32) };
});

const connect = (who: Member = w.alex, token = "alex") =>
  connectBank(w.db, bank, who, { publicToken: token, institutionName: "First Platypus Bank" }, FROM, NOW);
const row = async (id: string) => (await w.db.select().from(bankConnection).where(eq(bankConnection.id, id)))[0]!;
const actions = async () => (await w.db.select().from(auditLog)).map((a) => a.action);

async function jo(): Promise<Member> {
  const [h] = await w.db.insert(household).values({ name: "Jo's place", timezone: "America/New_York" }).returning();
  await seedCategories(w.db, h!.id, "household");
  const [m] = await w.db.insert(member).values({ householdId: h!.id, email: "jo@example.com", displayName: "Jo", linkedAt: new Date() }).returning();
  return m!;
}

describe("webhookUrl", () => {
  it("is the app's public https address, and nothing without one", () => {
    expect(webhookUrl({ BETTER_AUTH_URL: "https://abacus.example.com/" })).toBe("https://abacus.example.com/api/plaid/webhook");
    expect(webhookUrl({ BETTER_AUTH_URL: "http://localhost:3000" })).toBeUndefined();
    expect(webhookUrl({})).toBeUndefined();
  });
});

describe("bankRuntime", () => {
  it("is null without Plaid keys, and shared between calls with them", () => {
    expect(bankRuntime({})).toBeNull();
    const env = { PLAID_CLIENT_ID: "c", PLAID_SECRET: "s", ABACUS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
    expect(bankRuntime(env)).toBe(bankRuntime(env));
  });

  it("is refused with a plain message when it is not set up", () => {
    expect(() => requireBank(null)).toThrow(/not set up on this server/);
    const env = { PLAID_CLIENT_ID: "c", PLAID_SECRET: "s", ABACUS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
    expect(requireBank(bankRuntime(env))).toBe(bankRuntime(env));
  });
});

describe("startLink", () => {
  it("asks for a new connection with the member's id and nothing else about them", async () => {
    await startLink(w.db, bank, w.alex, { webhook: "https://abacus.example.com/api/plaid/webhook" });
    expect(fake.linkCalls).toEqual([{ clientUserId: w.alex.id, webhook: "https://abacus.example.com/api/plaid/webhook" }]);
    expect(JSON.stringify(fake.linkCalls)).not.toContain("alex@");
  });

  it("opens update mode for the owner's own connection only", async () => {
    const { connection } = await connect();
    await startLink(w.db, bank, w.alex, { connectionId: connection.id });
    expect(fake.linkCalls[0]).toEqual({ clientUserId: w.alex.id, accessToken: "access-alex" });
    await expect(startLink(w.db, bank, w.sam, { connectionId: connection.id })).rejects.toThrow(/only the person who connected/);
    await expect(startLink(w.db, bank, await jo(), { connectionId: connection.id })).rejects.toThrow(/only the person who connected/);
    await expect(startLink(w.db, bank, w.alex, { connectionId: "nope" })).rejects.toThrow(/only the person who connected/);
  });
});

describe("finishRelink", () => {
  it("sets the connection ok, syncs, and is the owner's alone", async () => {
    const { connection } = await connect();
    fake.failNext("alex", "ITEM_LOGIN_REQUIRED");
    await syncConnection(w.db, bank, connection.id, NOW);
    expect((await row(connection.id)).status).toBe("needs_relink");

    await expect(finishRelink(w.db, bank, w.sam, connection.id, NOW)).rejects.toThrow(/only the person who connected/);
    expect((await row(connection.id)).status).toBe("needs_relink");

    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1" });
    await finishRelink(w.db, bank, w.alex, connection.id, NOW);
    expect(await row(connection.id)).toMatchObject({ status: "ok", cursor: "c1" });
    expect((await actions()).filter((a) => a === "bank_connection.reconnected")).toHaveLength(1);
  });

  it("keeps the connection ok when the sync after it fails", async () => {
    const { connection } = await connect();
    fake.failNext("alex", "ITEM_LOGIN_REQUIRED");
    await syncConnection(w.db, bank, connection.id, NOW);
    fake.failNext("alex", "INTERNAL_SERVER_ERROR");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await finishRelink(w.db, bank, w.alex, connection.id, NOW);
    quiet.mockRestore();
    expect((await row(connection.id)).status).toBe("ok");
  });
});

describe("what the screens list", () => {
  it("shows a member only their own connections and set-aside transactions, never the token", async () => {
    const a = await connect();
    // Waiting rows put in directly: a purchase on a card that does not share
    // everything is no longer stored by the sync.
    for (const id of ["t1", "t2"]) {
      await w.db.insert(bankTransaction).values({
        householdId: w.householdId,
        connectionId: a.connection.id,
        accountId: a.accounts[0]!.id,
        plaidTransactionId: id,
        date: "2027-03-05",
        amountCents: 2000,
        description: "Corner Shop",
      });
    }
    const [t1] = await w.db.select().from(bankTransaction).where(eq(bankTransaction.plaidTransactionId, "t1"));
    await dismissBankTransaction(w.db, w.alex, t1!.id);

    const mine = await listConnections(w.db, w.alex);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ institutionName: "Test Bank", status: "ok" });
    expect(mine[0]!.accounts.map((x) => x.name)).toEqual(["Everyday Card", "Travel Card"]);
    expect(JSON.stringify(mine)).not.toContain("access");
    expect(await listConnections(w.db, w.sam)).toEqual([]);
    expect(await listConnections(w.db, await jo())).toEqual([]);

    expect((await listSetAside(w.db, w.alex)).map((t) => t.plaidTransactionId)).toEqual(["t1"]);
    expect(await listSetAside(w.db, w.sam)).toEqual([]);
    expect(await listSetAside(w.db, await jo())).toEqual([]);
  });
});

describe("Plaid webhooks", () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...(pair.publicKey.export({ format: "jwk" }) as { x: string; y: string }), kty: "EC", crv: "P-256", alg: "ES256", kid: "kid-1" } as PlaidWebhookKey;
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const header = (raw: string, iat = NOW.getTime() / 1000) => {
    const signing = `${b64({ alg: "ES256", kid: "kid-1", typ: "JWT" })}.${b64({ iat, request_body_sha256: createHash("sha256").update(raw).digest("hex") })}`;
    return `${signing}.${sign("sha256", Buffer.from(signing), { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  let runtime: BankRuntime;
  beforeEach(() => {
    runtime = { ...bank, getKey: async (kid) => (kid === "kid-1" ? jwk : null) };
  });

  const send = (body: unknown, opts: { signedBody?: string; headers?: Record<string, string> } = {}) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    return handlePlaidWebhookRequest(
      new Request("http://test/api/plaid/webhook", {
        method: "POST",
        body: raw,
        headers: { "plaid-verification": header(opts.signedBody ?? raw), ...opts.headers },
      }),
      { db: w.db, runtime, now: NOW },
    );
  };

  it("syncs the connection a good SYNC_UPDATES_AVAILABLE names", async () => {
    const { connection } = await connect();
    fake.on("alex", "", { added: [txn("t1")], next_cursor: "c1" });
    const res = await send({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-alex" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect((await row(connection.id)).cursor).toBe("c1");
  });

  it("marks needs_relink for a login error and for revoked permission, but not for a pending disconnect or expiry", async () => {
    const { connection } = await connect();
    const item_id = "item-alex";
    expect((await send({ webhook_type: "ITEM", webhook_code: "ERROR", item_id, error: { error_code: "ITEM_LOGIN_REQUIRED" } })).status).toBe(200);
    expect((await row(connection.id)).status).toBe("needs_relink");
    await w.db.update(bankConnection).set({ status: "ok" });
    await send({ webhook_type: "ITEM", webhook_code: "USER_PERMISSION_REVOKED", item_id });
    expect((await row(connection.id)).status).toBe("needs_relink");
    // These only warn of a later failure; marking now would clear itself on
    // the next good sync and the notice would flicker.
    await w.db.update(bankConnection).set({ status: "ok" });
    for (const code of ["PENDING_DISCONNECT", "PENDING_EXPIRATION"]) {
      expect((await send({ webhook_type: "ITEM", webhook_code: code, item_id })).status).toBe(200);
    }
    expect((await row(connection.id)).status).toBe("ok");
  });

  it("leaves a connection alone for an error that is not the login, and for kinds it does not know", async () => {
    const { connection } = await connect();
    const item_id = "item-alex";
    for (const body of [
      { webhook_type: "ITEM", webhook_code: "ERROR", item_id, error: { error_code: "INTERNAL_SERVER_ERROR" } },
      { webhook_type: "ITEM", webhook_code: "NEW_ACCOUNTS_AVAILABLE", item_id },
      { webhook_type: "TRANSACTIONS", webhook_code: "INITIAL_UPDATE", item_id },
      { webhook_type: "HOLDINGS", webhook_code: "DEFAULT_UPDATE", item_id },
      { hello: "there" },
    ]) {
      expect((await send(body)).status).toBe(200);
    }
    expect(await row(connection.id)).toMatchObject({ status: "ok", cursor: null });
  });

  it("answers 200 and does nothing for an item it does not have, or one already removed", async () => {
    expect((await send({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-nobody" })).status).toBe(200);
    const { connection } = await connect();
    await w.db.update(bankConnection).set({ removedAt: NOW, accessToken: null }).where(eq(bankConnection.id, connection.id));
    fake.syncCalls.length = 0;
    expect((await send({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-alex" })).status).toBe(200);
    expect(fake.syncCalls).toEqual([]);
  });

  it("answers 401 with no body to a bad signature, and does nothing", async () => {
    await connect();
    fake.syncCalls.length = 0;
    const body = { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-alex" };
    const cases = [
      await send(body, { signedBody: "something else" }),
      await send(body, { headers: { "plaid-verification": "nope" } }),
      await send(body, { headers: { "plaid-verification": header("x").replace(/.$/, "A") } }),
      await handlePlaidWebhookRequest(new Request("http://test/x", { method: "POST", body: JSON.stringify(body) }), { db: w.db, runtime, now: NOW }),
    ];
    for (const res of cases) {
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("");
    }
    expect(fake.syncCalls).toEqual([]);
  });

  it("checks the exact bytes sent, not the JSON they mean", async () => {
    await connect();
    const raw = '{"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE","item_id":"item-alex"}';
    const spaced = JSON.stringify(JSON.parse(raw), null, 4);
    expect((await send(spaced, { signedBody: raw })).status).toBe(401);
    expect((await send(raw)).status).toBe(200);
  });

  it("is off, with no detail, when Plaid is not set up; and refuses an enormous body", async () => {
    const off = await handlePlaidWebhookRequest(new Request("http://test/x", { method: "POST", body: "{}" }), { db: w.db, runtime: null, now: NOW });
    expect(off.status).toBe(404);
    const big = await handlePlaidWebhookRequest(new Request("http://test/x", { method: "POST", body: "{}", headers: { "content-length": "5000000" } }), {
      db: w.db,
      runtime,
      now: NOW,
    });
    expect(big.status).toBe(413);
  });

  it("refuses before reading the body when the header is missing or not a JWT, or the length is too big", async () => {
    let pulled = 0;
    const stream = (chunks: number) =>
      new ReadableStream<Uint8Array>({
        pull(c) {
          if (pulled >= chunks) return c.close();
          pulled++;
          c.enqueue(new Uint8Array(100_000));
        },
      });
    const post = (body: ReadableStream<Uint8Array>, headers: Record<string, string>) =>
      handlePlaidWebhookRequest(new Request("http://test/x", { method: "POST", body, headers, duplex: "half" } as RequestInit), { db: w.db, runtime, now: NOW });
    expect((await post(stream(3), {})).status).toBe(401);
    expect((await post(stream(3), { "plaid-verification": "not a jwt" })).status).toBe(401);
    expect(pulled).toBeLessThanOrEqual(2); // only what the stream prefetches itself
    // No length header: reading stops at the limit instead of taking it all.
    const res = await post(stream(1000), { "plaid-verification": header("x") });
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(20);
  });

  it("answers 500, without saying why, when a good webhook's sync fails", async () => {
    await connect();
    fake.failNext("alex", "INTERNAL_SERVER_ERROR");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await send({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-alex" });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("");
    expect(JSON.stringify(quiet.mock.calls)).not.toContain("access-alex");
    quiet.mockRestore();
  });

  it("applyPlaidWebhook ignores a body that is not an object", async () => {
    expect(await applyPlaidWebhook(w.db, bank, null, NOW)).toBe("ignored");
    expect(await applyPlaidWebhook(w.db, bank, [], NOW)).toBe("ignored");
  });
});
