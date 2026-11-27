// The /api/v1/accounts routes (card review), called as Next calls them, with
// a fake Plaid behind the bank.
import { randomBytes } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as card from "@/app/api/v1/accounts/[id]/route";
import * as pay from "@/app/api/v1/accounts/[id]/payments/route";
import * as past from "@/app/api/v1/accounts/[id]/payments/past/route";
import * as review from "@/app/api/v1/accounts/[id]/review/route";
import * as cards from "@/app/api/v1/accounts/route";
import { createApiToken } from "./api-tokens";
import { connectBank, syncConnection, type BankDeps } from "./bank";
import { createMcpToken } from "./mcp-tokens";
import { fakePlaid, payment, txn } from "./testing/fake-plaid";
import { schemaProblems } from "./testing/schema-check";
import { agree, createWorld, type World } from "./testing/world";
import { openapi } from "./openapi";

const runtime = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./bank-link", async (orig) => ({ ...(await orig<typeof import("./bank-link")>()), bankRuntime: () => runtime.current }));

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Schema = Record<string, unknown>;
const root = openapi as unknown as Schema;
const paths = openapi.paths as unknown as Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>>;

const FROM = "2027-03-01";
const NOW = new Date("2027-03-10T15:00:00Z");

let w: World;
let fake: ReturnType<typeof fakePlaid>;
let bank: BankDeps;
let cardId: string;
let alexToken: string;
let samToken: string;

beforeEach(async () => {
  vi.stubEnv("ABACUS_E2E", "1");
  vi.stubEnv("NODE_ENV", "test");
  w = await createWorld();
  (globalThis as { __abacusDb?: unknown }).__abacusDb = w.db;
  fake = fakePlaid();
  bank = { plaid: fake.plaid, key: randomBytes(32) };
  runtime.current = { ...bank, getKey: async () => null };
  await agree(w, FROM, { rules: [{ scope: "household", rule: { kind: "even" } }] });
  const made = await connectBank(w.db, bank, w.alex, { publicToken: "alex", institutionName: "First Platypus Bank" }, FROM, NOW);
  cardId = made.accounts.find((a) => a.lastFour === "1234")!.id;
  alexToken = (await createApiToken(w.db, w.alex, "phone")).token;
  samToken = (await createApiToken(w.db, w.sam, "phone")).token;
});

afterEach(() => {
  delete (globalThis as { __abacusDb?: unknown }).__abacusDb;
  vi.unstubAllEnvs();
});

// Calls a route; with `spec`, also checks the answer against the OpenAPI schema.
async function call(
  handler: unknown,
  opts: { token?: string | null; id?: string; query?: string; method?: string; body?: unknown; spec?: string } = {},
) {
  const token = opts.token === undefined ? alexToken : opts.token;
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const req = new Request(`http://test/api/v1${opts.query ? `?${opts.query}` : ""}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-abacus-today": "2027-03-10" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await (handler as Handler)(req, { params: Promise.resolve({ id: opts.id ?? cardId }) });
  const body = await res.json();
  if (opts.spec) {
    const schema = paths[opts.spec]![method.toLowerCase()]!.responses[String(res.status)]?.content?.["application/json"]?.schema;
    expect(schema, `${method} ${opts.spec} answered ${res.status}: ${JSON.stringify(body)}`).toBeDefined();
    expect(schemaProblems(body, schema!, root), `${method} ${opts.spec}`).toEqual([]);
  }
  return { status: res.status, body };
}

async function sharedPaid() {
  await call(card.PATCH, { method: "PATCH", body: { cardMode: "shared" } });
  fake.hold("alex", txn("t1", { amount: 100, date: "2027-03-02", merchant_name: "Grocer" }), txn("t2", { amount: 30, date: "2027-03-04", merchant_name: "Hardware" }));
  fake.on("alex", "", { added: [payment("p1", 1200, { date: "2027-03-08" })], next_cursor: "c1" });
  const [conn] = await w.db.query.bankConnection.findMany();
  await syncConnection(w.db, bank, conn!.id, NOW);
}

describe("cards", () => {
  it("lists your cards and none of another member's", async () => {
    const mine = await call(cards.GET, { spec: "/accounts" });
    expect(mine.status).toBe(200);
    expect(mine.body.accounts.map((a: { id: string }) => a.id)).toContain(cardId);
    expect(mine.body.accounts.find((a: { id: string }) => a.id === cardId)).toMatchObject({ lastFour: "1234", cardMode: "personal", latestPayment: null });
    expect((await call(cards.GET, { token: samToken })).body.accounts).toEqual([]);
  });

  it("changes a card's mode, and answers 400 for a mode that is not one", async () => {
    const res = await call(card.PATCH, { method: "PATCH", body: { cardMode: "shared" }, spec: "/accounts/{id}" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: cardId, cardMode: "shared", payments: [] });
    expect((await call(card.GET, { spec: "/accounts/{id}" })).body.cardMode).toBe("shared");
    const bad = await call(card.PATCH, { method: "PATCH", body: { cardMode: "both" }, spec: "/accounts/{id}" });
    expect(bad.status).toBe(400);
    expect((await call(card.PATCH, { method: "PATCH", body: {} })).status).toBe(400);
  });

  it("reads another member's card, or an id that is no card, as not found", async () => {
    for (const handler of [card.GET, review.GET]) {
      expect((await call(handler, { token: samToken })).status).toBe(404);
      expect((await call(handler, { id: "not-an-id" })).status).toBe(404);
    }
    expect((await call(card.PATCH, { token: samToken, method: "PATCH", body: { cardMode: "shared" } })).status).toBe(404);
    expect((await call(review.POST, { token: samToken, body: { items: [{ plaidTransactionId: "t1" }] } })).status).toBe(404);
    expect((await call(card.GET)).body.cardMode).toBe("personal");
  });
});

describe("a card's review", () => {
  it("shows the payment's purchases, then adds the picked ones out of it", async () => {
    await sharedPaid();
    const open = await call(review.GET, { spec: "/accounts/{id}/review" });
    expect(open.status).toBe(200);
    expect(open.body.to).toBe("2027-03-08");
    expect(open.body.lines.map((l: { plaidTransactionId: string }) => l.plaidTransactionId)).toEqual(["t2", "t1"]);

    const done = await call(review.POST, {
      query: `payment=${open.body.payment.id}`,
      body: { payment: open.body.payment.id, items: [{ plaidTransactionId: "t1", description: "Groceries", category: "groceries" }] },
    });
    expect(done.status).toBe(200);
    const schema = paths["/accounts/{id}/review"]!.post!.responses["200"]!.content!["application/json"]!.schema;
    expect(schemaProblems(done.body, schema, root)).toEqual([]);
    expect(done.body.expenses).toHaveLength(1);
    expect(done.body.expenses[0]).toMatchObject({ description: "Groceries", totalCents: 10000, category: "groceries", payerId: w.alex.id });
    expect(done.body.paymentExpense.totalCents).toBe(110000);

    const again = await call(review.GET, { query: `payment=${open.body.payment.id}` });
    expect(again.body.lines.find((l: { plaidTransactionId: string }) => l.plaidTransactionId === "t1").addedExpenseId).toBe(done.body.expenses[0].id);
  });

  it("refuses a review with no picks, or a bad date, with 400", async () => {
    await sharedPaid();
    expect((await call(review.POST, { body: { items: [] } })).status).toBe(400);
    expect((await call(review.POST, { body: {} })).status).toBe(400);
    expect((await call(review.GET, { query: "from=yesterday" })).status).toBe(400);
  });

  it("says so in words when this server has no bank set up", async () => {
    runtime.current = null;
    const res = await call(review.GET);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not set up/);
  });
});

describe("earlier payments", () => {
  const PAST = "/accounts/{id}/payments/past";
  const hold = () =>
    fake.hold("alex", txn("t1", { amount: 100, date: "2027-03-02", merchant_name: "Grocer" }), payment("p0", 1200, { date: "2027-03-08" }), txn("r1", { amount: -15, date: "2027-03-05" }));

  it("lists the unshared payments, shares one, and opens its review", async () => {
    await call(card.PATCH, { method: "PATCH", body: { cardMode: "shared" } });
    hold();
    const list = await call(past.GET, { spec: PAST });
    expect(list.status).toBe(200);
    expect(list.body.payments).toEqual([{ plaidTransactionId: "p0", date: "2027-03-08", amountCents: 120000, description: "Payment, thank you", paymentId: null }]);

    const done = await call(pay.POST, { body: { plaidTransactionId: "p0" }, spec: "/accounts/{id}/payments" });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ accountId: cardId, date: "2027-03-08", amountCents: 120000, mode: "shared", stillSharedCents: 120000 });
    expect((await call(past.GET)).body.payments).toEqual([]);
    const open = await call(review.GET, { query: `payment=${done.body.id}`, spec: "/accounts/{id}/review" });
    expect(open.body.payment.id).toBe(done.body.id);
    expect(open.body.lines.map((l: { plaidTransactionId: string; cardPayment: boolean }) => [l.plaidTransactionId, l.cardPayment])).toEqual([
      ["p0", true],
      ["r1", false],
      ["t1", false],
    ]);
    expect((await call(card.GET)).body.payments.map((p: { id: string }) => p.id)).toEqual([done.body.id]);
  });

  it("answers 400 for a personal card, a payment already shared, and what is not a payment", async () => {
    hold();
    expect((await call(past.GET)).status).toBe(400);
    expect((await call(pay.POST, { body: { plaidTransactionId: "p0" } })).status).toBe(400);
    await call(card.PATCH, { method: "PATCH", body: { cardMode: "shared" } });
    expect((await call(pay.POST, { body: { plaidTransactionId: "r1" } })).status).toBe(400);
    expect((await call(pay.POST, { body: {} })).status).toBe(400);
    expect((await call(pay.POST, { body: { plaidTransactionId: "p0" } })).status).toBe(200);
    const twice = await call(pay.POST, { body: { plaidTransactionId: "p0" } });
    expect(twice.status).toBe(400);
    expect(twice.body.error).toMatch(/already shared/);
  });

  it("reads another member's card as not found", async () => {
    await call(card.PATCH, { method: "PATCH", body: { cardMode: "shared" } });
    hold();
    expect((await call(past.GET, { token: samToken })).status).toBe(404);
    expect((await call(pay.POST, { token: samToken, body: { plaidTransactionId: "p0" } })).status).toBe(404);
    expect((await call(past.GET, { id: "not-an-id" })).status).toBe(404);
  });
});

describe("agent tokens", () => {
  it("are refused by every card route", async () => {
    const { token } = await createMcpToken(w.db, w.alex, { name: "agent", permission: "write" });
    expect((await call(cards.GET, { token })).status).toBe(401);
    expect((await call(card.GET, { token })).status).toBe(401);
    expect((await call(card.PATCH, { token, method: "PATCH", body: { cardMode: "shared" } })).status).toBe(401);
    expect((await call(review.GET, { token })).status).toBe(401);
    expect((await call(review.POST, { token, body: { items: [{ plaidTransactionId: "t1" }] } })).status).toBe(401);
    expect((await call(past.GET, { token })).status).toBe(401);
    expect((await call(pay.POST, { token, body: { plaidTransactionId: "p0" } })).status).toBe(401);
  });
});
