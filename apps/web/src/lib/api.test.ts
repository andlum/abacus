// The /api/v1 route handlers, called as Next calls them, against the test
// database.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as attention from "@/app/api/v1/attention/route";
import * as balance from "@/app/api/v1/balance/route";
import * as expense from "@/app/api/v1/expenses/[id]/route";
import * as expenseVoid from "@/app/api/v1/expenses/[id]/void/route";
import * as preview from "@/app/api/v1/expenses/preview/route";
import * as expenses from "@/app/api/v1/expenses/route";
import * as me from "@/app/api/v1/me/route";
import * as month from "@/app/api/v1/months/[month]/expenses/route";
import * as settlementOne from "@/app/api/v1/settlements/[id]/route";
import * as settlementVoid from "@/app/api/v1/settlements/[id]/void/route";
import * as settlements from "@/app/api/v1/settlements/route";
import { household, member } from "@/db/schema";
import { createApiToken, revokeApiToken } from "./api-tokens";
import { createWorld, type World } from "./testing/world";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

let w: World;
let alexToken: string;
let samToken: string;

beforeEach(async () => {
  w = await createWorld();
  (globalThis as { __abacusDb?: unknown }).__abacusDb = w.db;
  alexToken = (await createApiToken(w.db, w.alex, "phone")).token;
  samToken = (await createApiToken(w.db, w.sam, "phone")).token;
});

afterEach(() => {
  delete (globalThis as { __abacusDb?: unknown }).__abacusDb;
  vi.unstubAllEnvs();
});

async function call(
  handler: unknown,
  opts: { token?: string | null; params?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {},
) {
  const token = opts.token === undefined ? alexToken : opts.token;
  const req = new Request("http://test/api/v1", {
    method: opts.body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers },
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
  });
  const res = await (handler as Handler)(req, { params: Promise.resolve(opts.params ?? {}) });
  return { status: res.status, body: await res.json() };
}

describe("API sign-in", () => {
  it("answers 401 without a token, or with a revoked one", async () => {
    expect((await call(me.GET, { token: null })).status).toBe(401);
    expect((await call(me.GET, { token: "abk_nope" })).status).toBe(401);
    const { token, row } = await createApiToken(w.db, w.alex, "laptop");
    expect((await call(me.GET, { token })).status).toBe(200);
    await revokeApiToken(w.db, w.alex, row.id);
    expect((await call(me.GET, { token })).status).toBe(401);
  });

  it("acts as the token's member", async () => {
    const res = await call(me.GET, { token: samToken });
    expect(res.body.me.id).toBe(w.sam.id);
    expect(res.body.members.map((m: { id: string }) => m.id).sort()).toEqual([w.alex.id, w.sam.id].sort());
    expect(res.body.household.id).toBe(w.householdId);
  });

  it("lets the date be set by header only with the sign-in stand-in on", async () => {
    const headers = { "x-abacus-today": "2026-03-01" };
    expect((await call(me.GET, { headers })).body.today).not.toBe("2026-03-01");
    vi.stubEnv("ABACUS_E2E", "1");
    vi.stubEnv("NODE_ENV", "test");
    expect((await call(me.GET, { headers })).body.today).toBe("2026-03-01");
  });
});

describe("expenses", () => {
  const groceries = { date: "2026-01-15", description: "Groceries", category: "groceries", totalCents: 10001 };

  it("are created, split to the cent by the agreed rules, and read back", async () => {
    const made = await call(expenses.POST, { body: groceries });
    expect(made.status).toBe(201);
    expect(made.body.status).toBe("posted");
    expect(made.body.payerId).toBe(w.alex.id);
    const shares = Object.values(made.body.shares as Record<string, number>);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10001);

    const got = await call(expense.GET, { params: { id: made.body.id }, token: samToken });
    expect(got.body).toEqual(made.body);
    const listed = await call(month.GET, { params: { month: "2026-01" } });
    expect(listed.body.expenses.map((e: { id: string }) => e.id)).toEqual([made.body.id]);
  });

  it("take a split for one expense", async () => {
    const rule = { kind: "percent", bp: { [w.alex.id]: 7000, [w.sam.id]: 3000 } };
    const made = await call(expenses.POST, { body: { ...groceries, totalCents: 10000, rule } });
    expect(made.body.shares).toEqual({ [w.alex.id]: 7000, [w.sam.id]: 3000 });
  });

  it("are previewed without saving, the same as they save", async () => {
    const p = await call(preview.POST, { body: { totalCents: 10001, category: "groceries", date: "2026-01-15" } });
    expect(p.body.ok).toBe(true);
    const made = await call(expenses.POST, { body: groceries });
    expect(Object.values(p.body.shares).reduce((a: number, b) => a + (b as number), 0)).toBe(10001);
    expect((await call(month.GET, { params: { month: "2026-01" } })).body.expenses).toHaveLength(1);
    expect(made.status).toBe(201);
  });

  it("are refused with a reason for bad input", async () => {
    const bad = [
      { ...groceries, totalCents: 10.5 },
      { ...groceries, totalCents: "100" },
      { ...groceries, date: "January" },
      { ...groceries, date: "2999-01-01" },
      { ...groceries, description: undefined },
      { ...groceries, payerId: "not-a-member" },
      { ...groceries, rule: { kind: "percent", bp: { [w.alex.id]: 1 } } },
    ];
    for (const body of bad) {
      const res = await call(expenses.POST, { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toEqual(expect.any(String));
    }
    expect((await call(expenses.POST, { body: "not json" })).status).toBe(400);
    expect((await call(expenses.POST, { body: [1] })).status).toBe(400);
  });

  it("are voided, kept, and leave the balance", async () => {
    const made = await call(expenses.POST, { body: groceries });
    expect((await call(balance.GET)).body.net[w.alex.id]).toBeGreaterThan(0);
    const voided = await call(expenseVoid.POST, { params: { id: made.body.id }, body: {} });
    expect(voided.body.status).toBe("void");
    expect((await call(balance.GET)).body.net[w.alex.id]).toBe(0);
    expect((await call(expenseVoid.POST, { params: { id: made.body.id }, body: {} })).status).toBe(400);
  });

  it("answer 404 for an id or month that names nothing", async () => {
    expect((await call(expense.GET, { params: { id: "nope" } })).status).toBe(404);
    expect((await call(expenseVoid.POST, { params: { id: "nope" }, body: {} })).status).toBe(404);
    expect((await call(month.GET, { params: { month: "2026-13" } })).status).toBe(404);
  });

  it("from another household are not found", async () => {
    const made = await call(expenses.POST, { body: groceries });
    const [other] = await w.db.insert(household).values({ name: "Other" }).returning();
    const [stranger] = await w.db
      .insert(member)
      .values({ householdId: other!.id, email: "kim@example.com", displayName: "Kim", linkedAt: new Date() })
      .returning();
    const { token } = await createApiToken(w.db, stranger!, "phone");
    expect((await call(expense.GET, { params: { id: made.body.id }, token })).status).toBe(404);
    expect((await call(expenseVoid.POST, { params: { id: made.body.id }, token, body: {} })).status).toBe(400);
    expect((await call(month.GET, { params: { month: "2026-01" }, token })).body.expenses).toEqual([]);
  });
});

describe("balance, attention and settlements", () => {
  it("record a payment, show it in the balance, and void it", async () => {
    await call(expenses.POST, { body: { date: "2026-01-15", description: "Rent", totalCents: 200000 } });
    const before = await call(balance.GET);
    expect(before.body.owes).toEqual([{ from: w.sam.id, to: w.alex.id, amountCents: 100000 }]);

    const paid = await call(settlements.POST, {
      token: samToken,
      body: { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents: 100000, date: "2026-01-20" },
    });
    expect(paid.status).toBe(201);
    expect((await call(balance.GET)).body.owes).toEqual([]);
    expect((await call(settlements.GET)).body.settlements).toHaveLength(1);

    const voided = await call(settlementVoid.POST, { params: { id: paid.body.id }, body: {} });
    expect(voided.body.status).toBe("void");
    expect((await call(balance.GET)).body.owes).toHaveLength(1);
  });

  it("edit a payment: the old one is voided and the new one points back at it", async () => {
    const paid = await call(settlements.POST, {
      body: { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents: 10000, date: "2026-01-20" },
    });
    expect(paid.body.supersedesId).toBeNull();
    const edit = { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents: 5000, date: "2026-01-21", note: "cash" };
    const edited = await call(settlementOne.PUT, { params: { id: paid.body.id }, body: edit });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ ...edit, status: "recorded", supersedesId: paid.body.id });
    expect(edited.body.id).not.toBe(paid.body.id);
    const list = (await call(settlements.GET)).body.settlements;
    expect(list.find((s: { id: string }) => s.id === paid.body.id)).toMatchObject({ status: "void", supersedesId: null });

    // The old one, and the new one once voided, are refused as the web refuses them.
    const again = await call(settlementOne.PUT, { params: { id: paid.body.id }, body: edit });
    expect(again).toEqual({ status: 400, body: { error: "that payment was already replaced or voided; nothing was changed" } });
    await call(settlementVoid.POST, { params: { id: edited.body.id }, body: {} });
    expect((await call(settlementOne.PUT, { params: { id: edited.body.id }, body: edit })).status).toBe(400);
    expect((await call(settlementOne.PUT, { params: { id: "nope" }, body: edit })).status).toBe(404);
  });

  it("refuse an edit of another household's payment", async () => {
    const paid = await call(settlements.POST, {
      body: { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents: 10000, date: "2026-01-20" },
    });
    const [other] = await w.db.insert(household).values({ name: "Other" }).returning();
    const [stranger] = await w.db
      .insert(member)
      .values({ householdId: other!.id, email: "kim@example.com", displayName: "Kim", linkedAt: new Date() })
      .returning();
    const { token } = await createApiToken(w.db, stranger!, "phone");
    const res = await call(settlementOne.PUT, {
      token,
      params: { id: paid.body.id },
      body: { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents: 5000, date: "2026-01-21" },
    });
    expect(res.status).toBe(400);
    expect((await call(settlementVoid.POST, { token, params: { id: paid.body.id }, body: {} })).status).toBe(400);
    expect((await call(settlements.GET)).body.settlements).toMatchObject([{ id: paid.body.id, status: "recorded" }]);
  });

  it("refuse a payment to someone outside the household", async () => {
    const res = await call(settlements.POST, {
      body: { fromMemberId: w.alex.id, toMemberId: "someone", amountCents: 100 },
    });
    expect(res.status).toBe(400);
  });

  it("list what needs attention", async () => {
    const res = await call(attention.GET);
    expect(res.body).toMatchObject({ needsAmount: [], unassigned: [], count: 0 });
  });
});
