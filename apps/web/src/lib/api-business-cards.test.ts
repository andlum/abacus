// The card routes in a business group: whose card it is, and the review as
// pick, label, log. Called as Next calls them, with a fake Plaid behind.
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as card from "@/app/api/v1/accounts/[id]/route";
import * as review from "@/app/api/v1/accounts/[id]/review/route";
import * as expenses from "@/app/api/v1/expenses/route";
import * as meRoute from "@/app/api/v1/me/route";
import { household, member, type Member } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import type { Db } from "@/db/types";
import { createApiToken } from "./api-tokens";
import { connectBank, type BankDeps } from "./bank";
import { seedCategories } from "./categories";
import { openapi } from "./openapi";
import { fakePlaid, txn } from "./testing/fake-plaid";
import { schemaProblems } from "./testing/schema-check";

const runtime = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("./bank-link", async (orig) => ({ ...(await orig<typeof import("./bank-link")>()), bankRuntime: () => runtime.current }));

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Schema = Record<string, unknown>;
const root = openapi as unknown as Schema;
const paths = openapi.paths as unknown as Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema: Schema }> }> }>>;

const FROM = "2027-03-01";
const NOW = new Date("2027-03-10T15:00:00Z");

let db: Db;
let fake: ReturnType<typeof fakePlaid>;
let alex: Member;
let cardId: string;
let token: string;

// Alex's one-person business with a card connected and not marked yet.
beforeEach(async () => {
  vi.stubEnv("ABACUS_E2E", "1");
  vi.stubEnv("NODE_ENV", "test");
  db = await createTestDb();
  (globalThis as { __abacusDb?: unknown }).__abacusDb = db;
  fake = fakePlaid();
  const bank: BankDeps = { plaid: fake.plaid, key: randomBytes(32) };
  runtime.current = { ...bank, getKey: async () => null };
  const [biz] = await db.insert(household).values({ name: "Alex Studio", kind: "business", timezone: "America/New_York" }).returning();
  await seedCategories(db, biz!.id, "business");
  [alex] = (await db.insert(member).values({ householdId: biz!.id, email: "alex@example.com", displayName: "Alex", linkedAt: new Date() }).returning()) as [Member];
  const made = await connectBank(db, bank, alex, { publicToken: "alex", institutionName: "First Platypus Bank" }, FROM, NOW);
  cardId = made.accounts.find((a) => a.lastFour === "1234")!.id;
  token = (await createApiToken(db, alex, "phone")).token;
  fake.hold("alex", txn("t1", { amount: 100, date: "2027-03-02", merchant_name: "Cloud Host" }), txn("t2", { amount: 30, date: "2027-03-04", merchant_name: "Corner Cafe" }));
});

afterEach(() => {
  delete (globalThis as { __abacusDb?: unknown }).__abacusDb;
  vi.unstubAllEnvs();
});

// Calls a route; with `spec`, also checks the answer against the OpenAPI schema.
async function call(handler: unknown, opts: { query?: string; method?: string; body?: unknown; spec?: string } = {}) {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const req = new Request(`http://test/api/v1${opts.query ? `?${opts.query}` : ""}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "x-abacus-today": "2027-03-10" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await (handler as Handler)(req, { params: Promise.resolve({ id: cardId }) });
  const body = await res.json();
  if (opts.spec) {
    const schema = paths[opts.spec]![method.toLowerCase()]!.responses[String(res.status)]?.content?.["application/json"]?.schema;
    expect(schema, `${method} ${opts.spec} answered ${res.status}: ${JSON.stringify(body)}`).toBeDefined();
    expect(schemaProblems(body, schema!, root), `${method} ${opts.spec}`).toEqual([]);
  }
  return { status: res.status, body };
}

describe("a business group's card", () => {
  it("cannot be reviewed until its owner says whose it is", async () => {
    const closed = await call(review.GET, { spec: "/accounts/{id}/review" });
    expect(closed.status).toBe(400);
    expect((await call(review.POST, { body: { items: [{ plaidTransactionId: "t1" }] } })).status).toBe(400);

    const marked = await call(card.PATCH, { method: "PATCH", body: { kind: "business" }, spec: "/accounts/{id}" });
    expect(marked.status).toBe(200);
    expect(marked.body).toMatchObject({ id: cardId, kind: "business" });

    const open = await call(review.GET, { spec: "/accounts/{id}/review" });
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({ groupKind: "business", splits: false, account: { kind: "business" } });
    expect(open.body.lines.map((l: { picked: boolean }) => l.picked)).toEqual([true, true]);
  });

  it("takes a kind and not a card mode, and refuses a kind that is not one", async () => {
    expect((await call(card.PATCH, { method: "PATCH", body: { cardMode: "shared" }, spec: "/accounts/{id}" })).status).toBe(400);
    expect((await call(card.PATCH, { method: "PATCH", body: { kind: "both" }, spec: "/accounts/{id}" })).status).toBe(400);
    expect((await call(card.PATCH, { method: "PATCH", body: {} })).status).toBe(400);
    expect((await call(card.GET, { spec: "/accounts/{id}" })).body.kind).toBeNull();
  });

  it("logs a picked purchase with its vendor, note and business use, and reads them back", async () => {
    await call(card.PATCH, { method: "PATCH", body: { kind: "personal" } });
    const none = await call(review.GET);
    expect(none.body.lines.map((l: { picked: boolean }) => l.picked)).toEqual([false, false]);

    const refused = await call(review.POST, { body: { items: [{ plaidTransactionId: "t1", category: "software", businessUseBp: 5000 }] } });
    expect(refused.status).toBe(400);

    const done = await call(review.POST, {
      body: { items: [{ plaidTransactionId: "t1", category: "software", note: "Hosting for a client", businessUseBp: 5000, useBasis: "Half is the studio site" }] },
      spec: "/accounts/{id}/review",
    });
    expect(done.status).toBe(200);
    expect(done.body.paymentExpense).toBeNull();
    expect(done.body.expenses[0]).toMatchObject({
      totalCents: 10000,
      category: "software",
      vendor: "Cloud Host",
      note: "Hosting for a client",
      businessUseBp: 5000,
      useBasis: "Half is the studio site",
      payerId: alex.id,
    });

    const list = await call(expenses.GET, { spec: "/expenses" });
    expect(list.body.expenses[0]).toMatchObject({ vendor: "Cloud Host", businessUseBp: 5000 });
  });

  it("lists each category with its tax line", async () => {
    const me = await call(meRoute.GET, { spec: "/me" });
    expect(me.status).toBe(200);
    const meals = me.body.categories.find((c: { slug: string }) => c.slug === "meals");
    expect(meals).toMatchObject({ taxLine: "24b", halfDeductible: true });
    expect(me.body.categories.find((c: { slug: string }) => c.slug === "other")).toMatchObject({ taxLine: null, halfDeductible: false });
  });
});
