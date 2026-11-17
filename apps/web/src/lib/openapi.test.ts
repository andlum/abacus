// The spec the phone client is generated from must describe the routes as
// they are: the same paths and methods, and answers of the shapes it states.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as attention from "@/app/api/v1/attention/route";
import * as balance from "@/app/api/v1/balance/route";
import * as expense from "@/app/api/v1/expenses/[id]/route";
import * as expenseVoid from "@/app/api/v1/expenses/[id]/void/route";
import * as preview from "@/app/api/v1/expenses/preview/route";
import * as expenses from "@/app/api/v1/expenses/route";
import * as me from "@/app/api/v1/me/route";
import * as month from "@/app/api/v1/months/[month]/expenses/route";
import * as spec from "@/app/api/v1/openapi.json/route";
import * as reimbursementVoid from "@/app/api/v1/reimbursements/[id]/void/route";
import * as reimbursements from "@/app/api/v1/reimbursements/route";
import * as settlementOne from "@/app/api/v1/settlements/[id]/route";
import * as settlementVoid from "@/app/api/v1/settlements/[id]/void/route";
import * as settlements from "@/app/api/v1/settlements/route";
import { household, member } from "@/db/schema";
import { addAccount, setAccountArchived } from "./accounts";
import { recordSettlement } from "./balance";
import { seedCategories } from "./categories";
import { createExpense } from "./expenses";
import { createApiToken } from "./api-tokens";
import { openapi } from "./openapi";
import { recordReimbursement } from "./owed-back";
import { createTemplate } from "./templates";
import { schemaProblems } from "./testing/schema-check";
import { createWorld, type World } from "./testing/world";

type Schema = Record<string, unknown>;
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
const root = openapi as unknown as Schema;
const paths = openapi.paths as unknown as Record<string, Record<string, Schema>>;

// Only /api/v1 is REST and described here. /api/mcp (src/lib/mcp.ts) speaks
// JSON-RPC to agents and is left out on purpose.
const API_DIR = join(__dirname, "../app/api/v1");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}

describe("the OpenAPI spec", () => {
  it("lists exactly the routes and methods that exist", () => {
    const fromFiles = routeFiles(API_DIR)
      .flatMap((file) => {
        const path = "/" + relative(API_DIR, file).replace(/\/?route\.ts$/, "").replace(/\[(\w+)\]/g, "{$1}");
        const methods = [...readFileSync(file, "utf8").matchAll(/export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE)\b/g)];
        return methods.map((m) => `${m[1]!.toLowerCase()} ${path}`);
      })
      .sort();
    const fromSpec = Object.entries(paths)
      .flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method} ${path}`))
      .sort();
    expect(fromSpec).toEqual(fromFiles);
  });

  it("names every operation once, for the generated client's method names", () => {
    const ids = Object.values(paths).flatMap((ops) => Object.values(ops).map((op) => op.operationId));
    expect(ids.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("points every $ref at a schema that exists", () => {
    const refs = [...JSON.stringify(openapi).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]!);
    const schemas = Object.keys(openapi.components.schemas);
    expect(refs.filter((r) => !schemas.includes(r))).toEqual([]);
  });

  it("is checked by a checker that does find problems", () => {
    const expense = { $ref: "#/components/schemas/Expense" };
    expect(schemaProblems({ id: "x" }, expense, root).length).toBeGreaterThan(5);
    const rule = { $ref: "#/components/schemas/Rule" };
    expect(schemaProblems({ kind: "even" }, rule, root)).toEqual([]);
    expect(schemaProblems({ kind: "thirds" }, rule, root)).not.toEqual([]);
    expect(schemaProblems({ kind: "even", extra: 1 }, rule, root)).not.toEqual([]);
  });

  it("is served without a token", async () => {
    const res = spec.GET();
    expect(res.status).toBe(200);
    expect((await res.json()).openapi).toBe("3.1.0");
  });
});

describe("every answer matches the spec", () => {
  let w: World;
  let token: string;

  beforeEach(async () => {
    w = await createWorld();
    (globalThis as { __abacusDb?: unknown }).__abacusDb = w.db;
    token = (await createApiToken(w.db, w.alex, "phone")).token;
  });
  afterEach(() => {
    delete (globalThis as { __abacusDb?: unknown }).__abacusDb;
  });

  // Calls the route and checks the request body against the spec's request
  // schema and the answer against the response schema for its status.
  async function check(
    handler: unknown,
    method: "get" | "post" | "put",
    path: string,
    opts: { params?: Record<string, string>; query?: string; body?: unknown; auth?: boolean } = {},
  ) {
    const op = paths[path]![method]!;
    if (opts.body !== undefined && op.requestBody) {
      const schema = (op.requestBody as { content: Record<string, { schema: Schema }> }).content["application/json"]!.schema;
      expect(schemaProblems(opts.body, schema, root), `${method} ${path} request`).toEqual([]);
    }
    const req = new Request(`http://test/${opts.query ? `?${opts.query}` : ""}`, {
      method: method.toUpperCase(),
      headers: opts.auth === false ? {} : { authorization: `Bearer ${token}` },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const res = await (handler as Handler)(req, { params: Promise.resolve(opts.params ?? {}) });
    const body = await res.json();
    const response = (op.responses as Record<string, { content?: Record<string, { schema: Schema }> }>)[String(res.status)];
    expect(response, `${method} ${path} answered ${res.status}, which the spec does not list: ${JSON.stringify(body)}`).toBeDefined();
    expect(schemaProblems(body, response!.content!["application/json"]!.schema, root), `${method} ${path} ${res.status}`).toEqual([]);
    return { status: res.status, body };
  }

  it("for a household with every kind of expense", async () => {
    // A bill whose amount varies: each month it falls due waits for one.
    await createTemplate(w.db, w.alex, {
      name: "Electric",
      category: "utilities",
      amountCents: null,
      cadence: "monthly",
      dayOfMonth: 1,
      monthOfYear: null,
      payerId: w.alex.id,
      startDate: "2026-01-01",
    });
    const rule = { kind: "fixed_plus_remainder", fixedCents: { [w.alex.id]: 1000 }, remainder: { kind: "even" } };
    const made = await check(expenses.POST, "post", "/expenses", {
      body: { description: "Groceries", totalCents: 10001, date: "2026-01-15", category: "groceries", rule },
    });
    expect(made.status).toBe(201);
    // Split by income with no incomes recorded: saved, but unassigned.
    const stuck = await check(expenses.POST, "post", "/expenses", {
      body: { description: "Dinner", totalCents: 5000, date: "2026-01-16", rule: { kind: "income_proportional" } },
    });
    expect(stuck.body.status).toBe("unassigned");

    const card = await addAccount(w.db, w.alex, { name: "Card", lastFour: "4242" });
    const charged = await check(expenses.POST, "post", "/expenses", {
      body: { description: "Design tool", totalCents: 1500, date: "2026-01-17", accountId: card.id },
    });
    expect(charged.body).toMatchObject({ accountId: card.id });
    const old = await addAccount(w.db, w.alex, { name: "Old card" });
    await setAccountArchived(w.db, w.alex, old.id, true);
    expect((await check(me.GET, "get", "/me")).body.accounts).toEqual([
      { id: card.id, name: "Card", lastFour: "4242", kind: null, archived: false },
      { id: old.id, name: "Old card", lastFour: null, kind: null, archived: true },
    ]);
    const refused = await check(expenses.POST, "post", "/expenses", {
      body: { description: "Design tool", totalCents: 1500, accountId: old.id },
    });
    expect(refused.status).toBe(400);
    const all = await check(expenses.GET, "get", "/expenses");
    expect(all.body).toMatchObject({ nextCursor: null });
    expect(all.body.expenses.map((e: { description: string }) => e.description)).toContain("Design tool");
    expect(all.body.count).toBe(all.body.expenses.length);
    const first = await check(expenses.GET, "get", "/expenses", { query: "limit=1" });
    expect(first.body.expenses).toHaveLength(1);
    const next = await check(expenses.GET, "get", "/expenses", { query: `limit=1&cursor=${first.body.nextCursor}` });
    expect(next.body.expenses[0].id).not.toBe(first.body.expenses[0].id);
    const found = await check(expenses.GET, "get", "/expenses", { query: `account=${card.id}&q=design&from=2026-01-01&limit=5` });
    expect(found.body).toMatchObject({ count: 1, totalCents: 1500, nextCursor: null });
    await check(balance.GET, "get", "/balance");
    const a = await check(attention.GET, "get", "/attention");
    expect(a.body.needsAmount.length).toBeGreaterThan(0);
    expect(a.body.unassigned.length).toBe(1);
    await check(month.GET, "get", "/months/{month}/expenses", { params: { month: "2026-01" } });
    await check(expense.GET, "get", "/expenses/{id}", { params: { id: made.body.id } });
    expect((await check(preview.POST, "post", "/expenses/preview", { body: { totalCents: 100 } })).body.ok).toBe(true);
    const notOk = await check(preview.POST, "post", "/expenses/preview", { body: { totalCents: 100, rule: { kind: "income_proportional" } } });
    expect(notOk.body.ok).toBe(false);
    await check(expenseVoid.POST, "post", "/expenses/{id}/void", { params: { id: made.body.id }, body: {} });

    const paid = await check(settlements.POST, "post", "/settlements", {
      body: { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents: 500, note: "cash" },
    });
    const edit = { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents: 400, date: "2026-01-20" };
    const edited = await check(settlementOne.PUT, "put", "/settlements/{id}", { params: { id: paid.body.id }, body: edit });
    expect(edited.body.supersedesId).toBe(paid.body.id);
    await check(settlements.GET, "get", "/settlements");
    expect((await check(settlementOne.PUT, "put", "/settlements/{id}", { params: { id: paid.body.id }, body: edit })).status).toBe(400);
    expect((await check(settlementOne.PUT, "put", "/settlements/{id}", { params: { id: "x" }, body: edit })).status).toBe(404);
    await check(settlementVoid.POST, "post", "/settlements/{id}/void", { params: { id: edited.body.id }, body: {} });
  });

  it("for a business, with what it owes back", async () => {
    expect((await check(balance.GET, "get", "/balance")).body).not.toHaveProperty("owedBack");
    const refusedHere = await check(reimbursements.POST, "post", "/reimbursements", { body: { memberId: w.alex.id, amountCents: 100 } });
    expect(refusedHere.status).toBe(400);

    const [biz] = await w.db.insert(household).values({ name: "Alex Studio", kind: "business" }).returning();
    await seedCategories(w.db, biz!.id, "business");
    const [alex] = await w.db
      .insert(member)
      .values({ householdId: biz!.id, email: "alex@example.com", displayName: "Alex", linkedAt: new Date() })
      .returning();
    token = (await createApiToken(w.db, alex!, "phone")).token;
    const visa = await addAccount(w.db, alex!, { name: "Visa", kind: "personal" });
    const amex = await addAccount(w.db, alex!, { name: "Amex", kind: "business" });
    await createExpense(w.db, biz!.id, {
      kind: "manual",
      actor: alex!,
      date: "2026-01-10",
      description: "Design tool",
      totalCents: 10000,
      payerId: alex!.id,
      accountId: visa.id,
      today: "2026-01-10",
    });
    const repaid = await check(reimbursements.POST, "post", "/reimbursements", {
      body: { memberId: alex!.id, amountCents: 6000, date: "2026-01-11", accountId: amex.id, note: "transfer" },
    });
    expect(repaid.status).toBe(201);
    expect(repaid.body).toMatchObject({ memberId: alex!.id, amountCents: 6000, accountId: amex.id, status: "recorded" });
    const b = await check(balance.GET, "get", "/balance");
    expect(b.body.owedBack).toEqual({
      members: [{ memberId: alex!.id, personalPaidCents: 10000, repaidCents: 6000, owedCents: 4000 }],
      untaggedCount: 0,
      untaggedCents: 0,
    });
    expect((await check(reimbursements.GET, "get", "/reimbursements")).body.reimbursements).toHaveLength(1);
    const voided = await check(reimbursementVoid.POST, "post", "/reimbursements/{id}/void", { params: { id: repaid.body.id }, body: {} });
    expect(voided.body.status).toBe("void");
    const again = await check(reimbursementVoid.POST, "post", "/reimbursements/{id}/void", { params: { id: repaid.body.id }, body: {} });
    expect(again.status).toBe(400);
    expect((await check(reimbursementVoid.POST, "post", "/reimbursements/{id}/void", { params: { id: "x" } })).status).toBe(404);
    // Unknown, another group's and already voided read alike, as for payments.
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await check(reimbursementVoid.POST, "post", "/reimbursements/{id}/void", { params: { id: unknown } })).status).toBe(400);
    expect((await check(settlementVoid.POST, "post", "/settlements/{id}/void", { params: { id: unknown } })).status).toBe(400);
    const [other] = await w.db.insert(household).values({ name: "Sam Studio", kind: "business" }).returning();
    const [otherSam] = await w.db
      .insert(member)
      .values({ householdId: other!.id, email: "sam@example.com", displayName: "Sam", linkedAt: new Date() })
      .returning();
    const theirs = await recordReimbursement(w.db, otherSam!, { memberId: otherSam!.id, amountCents: 100, date: "2026-01-11" }, "2026-01-11");
    expect((await check(reimbursementVoid.POST, "post", "/reimbursements/{id}/void", { params: { id: theirs.id } })).status).toBe(400);
    const householdPayment = await recordSettlement(w.db, w.alex, { fromMemberId: w.sam.id, toMemberId: w.alex.id, amountCents: 100, date: "2026-01-11" }, "2026-01-11");
    expect((await check(settlementVoid.POST, "post", "/settlements/{id}/void", { params: { id: householdPayment.id } })).status).toBe(400);
    const personal = await check(reimbursements.POST, "post", "/reimbursements", {
      body: { memberId: alex!.id, amountCents: 100, accountId: visa.id },
    });
    expect(personal.status).toBe(400);
  });

  it("for refusals", async () => {
    expect((await check(me.GET, "get", "/me", { auth: false })).status).toBe(401);
    expect((await check(expense.GET, "get", "/expenses/{id}", { params: { id: "x" } })).status).toBe(404);
    expect((await check(month.GET, "get", "/months/{month}/expenses", { params: { month: "x" } })).status).toBe(404);
    expect((await check(expenses.GET, "get", "/expenses", { query: "from=March" })).status).toBe(400);
    expect((await check(expenses.GET, "get", "/expenses", { query: "cursor=nope" })).status).toBe(400);
    expect((await check(expenses.GET, "get", "/expenses", { query: "status=proposed" })).status).toBe(400);
    expect((await check(expenses.GET, "get", "/expenses", { query: `q=${"x".repeat(101)}` })).status).toBe(400);
    const res = await check(settlements.POST, "post", "/settlements", {
      body: { fromMemberId: w.alex.id, toMemberId: w.alex.id, amountCents: 500 },
    });
    expect(res.status).toBe(400);
  });
});
