// The /api/mcp route handler, called as Next calls it, against the test
// database. Requests are written out by hand, as an MCP client sends them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mcp from "@/app/api/mcp/route";
import * as me from "@/app/api/v1/me/route";
import { eq } from "drizzle-orm";
import { auditLog, category, expense, household, mcpToken, member } from "@/db/schema";
import { recentActivity } from "./activity";
import { entityActivity } from "./entity-activity";
import { addAccount } from "./accounts";
import { createApiToken } from "./api-tokens";
import { createExpense } from "./expenses";
import { createMcpToken, revokeMcpToken } from "./mcp-tokens";
import { MCP_CALLS_PER_MINUTE, resetMcpRateLimit } from "./mcp";
import { createTemplate } from "./templates";
import { agree, createWorld, legacyProposal, type World } from "./testing/world";

let w: World;
let token: string;
let tokenId: string;

beforeEach(async () => {
  w = await createWorld();
  // Alex has joined with an account.
  w.alex = (await w.db.update(member).set({ authUserId: "auth-alex" }).where(eq(member.id, w.alex.id)).returning())[0]!;
  (globalThis as { __abacusDb?: unknown }).__abacusDb = w.db;
  ({ token, row: { id: tokenId } } = await createMcpToken(w.db, w.alex, { name: "Household agent" }));
  resetMcpRateLimit();
});

afterEach(() => {
  delete (globalThis as { __abacusDb?: unknown }).__abacusDb;
  vi.restoreAllMocks();
});

const LEGACY = "2025-11-25";
const MODERN = "2026-07-28";
let nextId = 1;

// A 2025-era message: no envelope, as Claude Code and most clients send today.
async function post(body: unknown, opts: { token?: string | null; headers?: Record<string, string> } = {}) {
  const t = opts.token === undefined ? token : opts.token;
  const req = new Request("http://test/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(t ? { authorization: `Bearer ${t}` } : {}),
      ...opts.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const res = await mcp.POST(req);
  const text = await res.text();
  return { res, status: res.status, text, json: text ? JSON.parse(text) : null };
}

const rpc = (method: string, params?: object) => ({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) });

async function callTool(name: string, args: object = {}, opts: { token?: string; headers?: Record<string, string> } = {}) {
  const { status, json, text } = await post(rpc("tools/call", { name, arguments: args }), {
    ...opts,
    headers: { "mcp-protocol-version": LEGACY, ...opts.headers },
  });
  expect(status).toBe(200);
  return { result: json.result as { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: any }, text };
}

async function read(name: string, args: object = {}, opts: { token?: string; headers?: Record<string, string> } = {}) {
  const { result } = await callTool(name, args, opts);
  expect(result.isError ?? false, result.content[0]?.text).toBe(false);
  return JSON.parse(result.content[0]!.text);
}

const dinner = (over: object = {}) =>
  createExpense(w.db, w.householdId, {
    kind: "manual",
    actor: w.alex,
    date: "2026-10-10",
    description: "Dinner",
    category: "dining",
    totalCents: 9000,
    payerId: w.alex.id,
    today: "2026-10-31",
    ...over,
  });

const READ_TOOLS = ["get_context", "list_expenses", "get_balance", "list_attention", "preview_split"];
const WRITE_TOOLS = ["add_expense", "edit_expense", "void_expense"];

// A token made with the old propose permission, before agents could only read.
async function oldProposeToken(name: string) {
  const made = await createMcpToken(w.db, w.alex, { name });
  await w.db.update(mcpToken).set({ permission: "propose" }).where(eq(mcpToken.id, made.row.id));
  return made;
}

describe("signing in to /api/mcp", () => {
  const refused = async (t: string | null) => {
    const { res, status, json } = await post(rpc("tools/list"), { token: t });
    expect(status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(json).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } });
  };

  it("answers 401 with no token, a made-up one, a device token or a revoked one, and says nothing about why", async () => {
    await refused(null);
    await refused("abm_" + "x".repeat(43));
    await refused((await createApiToken(w.db, w.alex, "phone")).token);
    await revokeMcpToken(w.db, w.alex, tokenId);
    await refused(token);
  });

  it("sets no cookies and no CORS headers", async () => {
    const { res } = await post(rpc("tools/list"), { headers: { origin: "https://elsewhere.example.com" } });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect([...res.headers.keys()].filter((k) => k.startsWith("access-control"))).toEqual([]);
  });

  it("is not accepted at /api/v1, nor a device token here", async () => {
    const res = await me.GET(new Request("http://test/api/v1/me", { headers: { authorization: `Bearer ${token}` } }), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(401);
  });

  it("answers GET and DELETE with 405", async () => {
    expect((await mcp.GET()).status).toBe(405);
    expect((await mcp.DELETE()).status).toBe(405);
  });

  it("allows a set number of calls a minute per token, then 429 with Retry-After", async () => {
    for (let i = 0; i < MCP_CALLS_PER_MINUTE; i++) expect((await post(rpc("ping"))).status).toBe(200);
    const { res, status, json } = await post(rpc("ping"));
    expect(status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(json.error.message).toMatch(/too many/i);
    // Another token has its own count.
    const other = await createMcpToken(w.db, w.alex, { name: "Second" });
    expect((await post(rpc("ping"), { token: other.token })).status).toBe(200);
  });
});

describe("the protocol", () => {
  it("answers initialize in JSON, without a session, offering tools only", async () => {
    const { res, status, json } = await post(
      rpc("initialize", { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "test", version: "1" } }),
    );
    expect(status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(json.result.protocolVersion).toBe(LEGACY);
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.serverInfo.name).toBe("abacus");
  });

  it("accepts the initialized notification with 202", async () => {
    const { status } = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(status).toBe(202);
  });

  it("lists the five read tools and nothing else, even to a token made with the old propose permission", async () => {
    const names = async (t: string) => (await post(rpc("tools/list"), { token: t })).json.result.tools.map((x: { name: string }) => x.name).sort();
    const proposer = await oldProposeToken("Bookkeeper");
    expect(await names(token)).toEqual([...READ_TOOLS].sort());
    expect(await names(proposer.token)).toEqual([...READ_TOOLS].sort());
  });

  it("describes every tool for an agent reading it cold", async () => {
    const { json } = await post(rpc("tools/list"));
    for (const t of json.result.tools) {
      expect(t.description.length, t.name).toBeGreaterThan(80);
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("serves the 2026-07-28 revision too, with its metadata in every request", async () => {
    const body = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "get_context",
        arguments: {},
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };
    const { status, json, res } = await post(body, {
      headers: { "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": "get_context" },
    });
    expect(status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(JSON.parse(json.result.content[0].text).you.displayName).toBe(w.alex.displayName);
  });

  it("answers a body that is not JSON with a parse error, and an unknown method with method-not-found", async () => {
    const bad = await post("{not json");
    expect(bad.json.error.code).toBe(-32700);
    const unknown = await post(rpc("resources/list"), { headers: { "mcp-protocol-version": LEGACY } });
    expect(unknown.json.error.code).toBe(-32601);
  });

  it("refuses a batch, which would let many calls through as one, before any tool runs", async () => {
    const balance = await import("./balance");
    const ran = vi.spyOn(balance, "getBalance");
    const call = () => rpc("tools/call", { name: "get_balance", arguments: {} });
    const { status, json } = await post([call(), call()], { headers: { "mcp-protocol-version": LEGACY } });
    expect(status).toBe(400);
    expect(json).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: expect.stringMatching(/batch.*one message per request/i) } });
    expect(ran).not.toHaveBeenCalled();
  });

  it("refuses a body over 1 MB with 413, by its Content-Length or by the bytes sent", async () => {
    const { MAX_MCP_BODY_BYTES } = await import("./mcp");
    expect(MAX_MCP_BODY_BYTES).toBe(1024 * 1024);
    const claimed = await post(rpc("ping"), { headers: { "content-length": String(MAX_MCP_BODY_BYTES + 1) } });
    expect(claimed.status).toBe(413);
    expect(claimed.json.error.message).toMatch(/too large/i);
    // No Content-Length: a stream is counted as it is read.
    const big = JSON.stringify({ ...rpc("ping"), params: { pad: "x".repeat(MAX_MCP_BODY_BYTES) } });
    const bytes = new TextEncoder().encode(big);
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 64 * 1024) c.enqueue(bytes.slice(i, i + 64 * 1024));
        c.close();
      },
    });
    const req = new Request("http://test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await mcp.POST(req);
    expect(res.status).toBe(413);
    // A small body is read as usual.
    expect((await post(rpc("ping"))).status).toBe(200);
  });

  it("answers a 2025-era POST without an Accept header with 406 and a JSON-RPC error", async () => {
    const req = new Request("http://test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(rpc("tools/list")),
    });
    const res = await mcp.POST(req);
    expect(res.status).toBe(406);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000, message: expect.stringMatching(/accept/i) } });
  });
});

describe("the read tools", () => {
  it("get_context names the group, who the token acts for, the members, categories and rules", async () => {
    await agree(w, "2026-10-01", { rules: [{ scope: "household", rule: { kind: "percent", bp: { [w.alex.id]: 6000, [w.sam.id]: 4000 } } }] });
    const ctx = await read("get_context");
    expect(ctx.group).toMatchObject({ kind: "household" });
    expect(ctx.you).toEqual({ id: w.alex.id, displayName: w.alex.displayName });
    expect(ctx.token).toEqual({ name: "Household agent" });
    expect(ctx.note).toMatch(/only read/);
    expect(ctx.members.map((m: { id: string }) => m.id).sort()).toEqual([w.alex.id, w.sam.id].sort());
    expect(ctx.categories.some((c: { slug: string }) => c.slug === "dining")).toBe(true);
    expect(ctx.rules).toEqual([
      expect.objectContaining({ scope: "household", effectiveFrom: "2026-10-01", rule: { kind: "percent", bp: { [w.alex.id]: 6000, [w.sam.id]: 4000 } } }),
    ]);
    expect(ctx.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ctx.accounts).toEqual([]);
  });

  it("get_context lists the group's accounts, and list_expenses says which one paid", async () => {
    const card = await addAccount(w.db, w.alex, { name: "Joint card", lastFour: "4242" });
    const ctx = await read("get_context");
    expect(ctx.accounts).toEqual([{ id: card.id, name: "Joint card", kind: null, archived: false }]);
    const paid = await dinner({ accountId: card.id });
    await dinner({ description: "Lunch" });
    const month = await read("list_expenses", { month: "2026-10" });
    expect(month.expenses).toEqual([
      expect.objectContaining({ id: paid.id, accountId: card.id, account: { name: "Joint card", kind: null } }),
      expect.objectContaining({ description: "Lunch", accountId: null, account: null }),
    ]);
  });

  it("list_expenses gives a month's or a range's expenses with their shares in cents", async () => {
    const a = await dinner();
    await dinner({ date: "2026-09-30", description: "Lunch" });
    const month = await read("list_expenses", { month: "2026-10" });
    expect(month.expenses).toEqual([expect.objectContaining({ id: a.id, totalCents: 9000, shares: { [w.alex.id]: 4500, [w.sam.id]: 4500 } })]);
    expect(month).toMatchObject({ from: "2026-10-01", to: "2026-10-31", count: 1 });
    const range = await read("list_expenses", { from: "2026-09-30", to: "2026-10-10" });
    expect(range.expenses.map((e: { description: string }) => e.description)).toEqual(["Lunch", "Dinner"]);
  });

  it("get_balance says who owes whom", async () => {
    await dinner();
    const b = await read("get_balance");
    expect(b.owes).toEqual([{ from: w.sam.id, to: w.alex.id, amountCents: 4500 }]);
    expect(b.net).toEqual({ [w.alex.id]: 4500, [w.sam.id]: -4500 });
    expect(b.entries).toHaveLength(1);
    expect(b).not.toHaveProperty("owedBack");
  });

  it("post recurring costs that have fallen due before reading, as the app does, and only once", async () => {
    vi.stubEnv("ABACUS_E2E", "1");
    vi.stubEnv("NODE_ENV", "test");
    const on = { headers: { "x-abacus-today": "2026-10-15" } };
    await createTemplate(w.db, w.alex, { name: "Rent", category: "housing", amountCents: 200000, cadence: "monthly", dayOfMonth: 1, payerId: w.alex.id, startDate: "2026-10-01" });
    expect(await w.db.select().from(expense)).toEqual([]);

    const b = await read("get_balance", {}, on);
    expect(b.net).toEqual({ [w.alex.id]: 100000, [w.sam.id]: -100000 });
    const listed = await read("list_expenses", { month: "2026-10" }, on);
    expect(listed.expenses).toEqual([expect.objectContaining({ description: "Rent", date: "2026-10-01", totalCents: 200000 })]);
    await read("list_attention", {}, on);
    expect(await w.db.select().from(expense)).toHaveLength(1);
    vi.unstubAllEnvs();
  });

  it("list_attention lists what needs an amount or a split", async () => {
    const a = await read("list_attention");
    expect(a).toMatchObject({ needsAmount: [], unassigned: [], count: 0 });
  });

  it("preview_split gives the shares the server would post, and saves nothing", async () => {
    const p = await read("preview_split", { totalCents: 10001, date: "2026-10-10", category: "dining" });
    expect(p.ok).toBe(true);
    expect(Object.values(p.shares).reduce((s: number, v) => s + (v as number), 0)).toBe(10001);
    expect(await w.db.select().from(expense)).toEqual([]);
  });

  it("write no audit entries when nothing has fallen due", async () => {
    const { auditLog } = await import("@/db/schema");
    const before = (await w.db.select().from(auditLog)).length;
    for (const name of READ_TOOLS) await callTool(name, name === "preview_split" ? { totalCents: 100 } : name === "list_expenses" ? { month: "2026-10" } : {});
    expect((await w.db.select().from(auditLog)).length).toBe(before);
  });
});

describe("what an agent is not shown", () => {
  it("leaves old proposed and rejected expenses out of the expenses, the balance and the attention list", async () => {
    const p1 = await legacyProposal(w, { date: "2026-10-10", description: "Waiting", totalCents: 7000 });
    const p2 = await legacyProposal(w, { date: "2026-10-11", description: "Refused", totalCents: 8000 }, "rejected");
    const all = JSON.stringify([
      await read("list_expenses", { month: "2026-10" }),
      await read("get_balance"),
      await read("list_attention"),
    ]);
    for (const id of [p1.id, p2.id]) expect(all).not.toContain(id);
    expect(all).not.toMatch(/Waiting|Refused|7000|8000/);
  });

  it("never shows an income, even when the group splits by income", async () => {
    // Round, distinctive figures so a leak is easy to spot in the JSON.
    await agree(w, "2026-10-01", { incomes: { alex: 9_123_400, sam: 6_543_200 }, rules: [{ scope: "household", rule: { kind: "income_proportional" } }] });
    await dinner();
    const proposer = await oldProposeToken("Bookkeeper");
    const outputs: string[] = [];
    for (const t of [token, proposer.token]) {
      outputs.push((await post(rpc("tools/list"), { token: t })).text);
      outputs.push((await callTool("get_context", {}, { token: t })).text);
      outputs.push((await callTool("list_expenses", { month: "2026-10" }, { token: t })).text);
      outputs.push((await callTool("get_balance", {}, { token: t })).text);
      outputs.push((await callTool("list_attention", {}, { token: t })).text);
      outputs.push((await callTool("preview_split", { totalCents: 10000, date: "2026-10-10" }, { token: t })).text);
    }
    const all = outputs.join("\n");
    expect(all).toContain("income_proportional");
    for (const income of [9_123_400, 6_543_200, 91_234, 65_432]) expect(all).not.toContain(String(income));
    expect(all).not.toMatch(/annualCents|incomeIds|"income"/);
  });

  it("does not show a group to a token made in another group, though the same person is in both", async () => {
    await dinner();
    const [biz] = await w.db.insert(household).values({ name: "Studio", kind: "business" }).returning();
    const [inBusiness] = await w.db
      .insert(member)
      .values({ householdId: biz!.id, email: w.alex.email, displayName: "Alex", authUserId: w.alex.authUserId, linkedAt: new Date() })
      .returning();
    const bizToken = (await createMcpToken(w.db, inBusiness!, { name: "Business agent" })).token;
    const ctx = await read("get_context", {}, { token: bizToken });
    expect(ctx.group).toMatchObject({ name: "Studio", kind: "business" });
    expect((await read("list_expenses", { month: "2026-10" }, { token: bizToken })).expenses).toEqual([]);
    const bizBalance = await read("get_balance", {}, { token: bizToken });
    expect(bizBalance.entries).toEqual([]);
    expect(bizBalance.owedBack).toEqual({
      members: [{ memberId: inBusiness!.id, personalPaidCents: 0, repaidCents: 0, owedCents: 0 }],
      untaggedCount: 0,
      untaggedCents: 0,
    });
    expect((await read("list_expenses", { month: "2026-10" })).expenses).toHaveLength(1);
  });
});

describe("a group the token does not reach", () => {
  it("cannot be named in preview_split, and its people and categories are not shown", async () => {
    const [biz] = await w.db.insert(household).values({ name: "Studio", kind: "business" }).returning();
    const [stranger] = await w.db
      .insert(member)
      .values({ householdId: biz!.id, email: "jordan@example.com", displayName: "Jordan Stranger", linkedAt: new Date() })
      .returning();
    await w.db.insert(category).values({ householdId: biz!.id, slug: "studio_rent", label: "Studio rent" });
    for (const args of [{ payerId: stranger!.id }, { category: "studio_rent" }]) {
      const { result, text } = await callTool("preview_split", { totalCents: 10000, date: "2026-10-10", ...args });
      expect(result.isError, text).toBe(true);
      expect(text).not.toMatch(/Studio|Jordan|jordan@/);
    }
  });
});

describe("arguments an agent gets wrong", () => {
  const toolError = async (name: string, args: object, message: RegExp) => {
    const { result } = await callTool(name, args);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(message);
  };

  it("are answered with a tool error the agent can read", async () => {
    await toolError("list_expenses", {}, /month, or from and to/);
    await toolError("list_expenses", { month: "October" }, /month/);
    await toolError("list_expenses", { from: "2026-12-01", to: "2026-01-01" }, /before/);
    await toolError("list_expenses", { from: "2025-01-01", to: "2026-06-01" }, /366 days/);
    await toolError("preview_split", { totalCents: 12.5 }, /totalCents/);
    await toolError("preview_split", { totalCents: 100, payerId: "00000000-0000-4000-8000-000000000000" }, /payer/);
    await toolError("preview_split", { totalCents: 100, category: "no such thing" }, /categor/);
    await toolError("get_context", { householdId: w.householdId }, /householdId|unrecognized/i);
  });

  it("are refused when a range holds too many expenses to return", async () => {
    const { MAX_LISTED_EXPENSES } = await import("./mcp-tools");
    const rows = Array.from({ length: MAX_LISTED_EXPENSES + 1 }, (_, i) => ({
      householdId: w.householdId,
      date: "2026-10-10",
      description: `Row ${i}`,
      category: "other",
      totalCents: 100,
      payerId: w.alex.id,
      status: "void" as const,
      source: "manual" as const,
    }));
    await w.db.insert(expense).values(rows);
    await toolError("list_expenses", { month: "2026-10" }, /more than \d+ expenses/);
  });

  it("hide an unexpected failure behind a general message, and log it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const balance = await import("./balance");
    vi.spyOn(balance, "getBalance").mockRejectedValueOnce(new Error("connection string postgres://secret"));
    const { result } = await callTool("get_balance");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toContain("secret");
    expect(logged).toHaveBeenCalled();
  });
});

describe("a token that can write", () => {
  let writer: string;
  let writerId: string;
  beforeEach(async () => {
    ({ token: writer, row: { id: writerId } } = await createMcpToken(w.db, w.alex, { name: "Bookkeeper", permission: "write" }));
  });

  const write = async (name: string, args: object, t = writer) => {
    const { result } = await callTool(name, args, { token: t });
    expect(result.isError ?? false, result.content[0]?.text).toBe(false);
    return JSON.parse(result.content[0]!.text);
  };
  const refusal = async (name: string, args: object, t = writer) => {
    const { result } = await callTool(name, args, { token: t });
    expect(result.isError).toBe(true);
    return result.content[0]!.text;
  };
  const groceries = { description: "Groceries", totalCents: 10000, category: "groceries", payerId: "", date: "2026-10-10" };
  const noProposals = async () =>
    expect((await w.db.select().from(expense)).filter((e) => e.status === "proposed" || e.status === "rejected")).toEqual([]);

  it("sees the write tools besides the read ones, each saying it writes", async () => {
    const { json } = await post(rpc("tools/list"), { token: writer });
    const tools = json.result.tools as { name: string; description: string; annotations: { readOnlyHint: boolean } }[];
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    for (const t of tools.filter((x) => WRITE_TOOLS.includes(x.name))) {
      expect(t.annotations.readOnlyHint, t.name).toBe(false);
      expect(t.description.length, t.name).toBeGreaterThan(80);
    }
    expect((await read("get_context", {}, { token: writer })).note).toMatch(/add, edit and void/);
  });

  it("adds an expense that counts at once, split by the server, recorded as Alex's agent", async () => {
    const { expense: added } = await write("add_expense", { ...groceries, payerId: w.alex.id });
    expect(added).toMatchObject({ status: "posted", source: "agent", totalCents: 10000, shares: { [w.alex.id]: 5000, [w.sam.id]: 5000 } });
    expect((await read("get_balance")).net).toEqual({ [w.alex.id]: 5000, [w.sam.id]: -5000 });

    const [entry] = await w.db.select().from(auditLog).where(eq(auditLog.entityId, added.id));
    expect(entry).toMatchObject({ action: "expense.posted", actorKind: "member", actorMemberId: w.alex.id, actorTokenId: writerId });
    const names = new Map([[w.alex.id, "Alex"], [w.sam.id, "Sam"]]);
    const [home] = await recentActivity(w.db, w.householdId, names, 5);
    expect(home).toMatchObject({ who: "Alex's agent", text: "Added Groceries", cents: 10000 });
    const onPage = await entityActivity(w.db, w.householdId, w.alex, { type: "expense", id: added.id });
    expect(onPage.map((e) => e.text)).toEqual(["Alex's agent added this expense"]);
    await noProposals();
  });

  it("edits by superseding and voids, as the web does, keeping what was not given", async () => {
    const { expense: added } = await write("add_expense", { ...groceries, payerId: w.alex.id });
    const { replaced, expense: edited } = await write("edit_expense", { expenseId: added.id, totalCents: 12000 });
    expect(replaced).toBe(added.id);
    expect(edited).toMatchObject({ supersedesId: added.id, description: "Groceries", category: "groceries", payerId: w.alex.id, date: "2026-10-10", source: "agent" });
    expect(edited.shares).toEqual({ [w.alex.id]: 6000, [w.sam.id]: 6000 });
    const [old] = await w.db.select().from(expense).where(eq(expense.id, added.id));
    expect(old!.status).toBe("superseded");

    const { expense: voided } = await write("void_expense", { expenseId: edited.id });
    expect(voided.status).toBe("void");
    expect((await read("get_balance")).net).toEqual({ [w.alex.id]: 0, [w.sam.id]: 0 });
    const trail = await w.db.select().from(auditLog).where(eq(auditLog.actorTokenId, writerId)).orderBy(auditLog.id);
    expect(trail.map((e) => e.action)).toEqual(["expense.posted", "expense.posted", "expense.voided"]);
    await noProposals();
  });

  it("is refused as the web refuses, in words the agent can read", async () => {
    const { expense: added } = await write("add_expense", { ...groceries, payerId: w.alex.id });
    expect(await refusal("add_expense", { ...groceries, payerId: w.alex.id, category: "no such thing" })).toMatch(/category/);
    expect(await refusal("add_expense", { ...groceries, payerId: w.alex.id, date: "2999-01-01" })).toMatch(/later than today/);
    expect(await refusal("add_expense", { ...groceries, payerId: w.alex.id, date: "10/10/2026" })).toMatch(/date/);
    expect(await refusal("add_expense", { ...groceries, payerId: "00000000-0000-4000-8000-000000000000" })).toMatch(/payerId/);
    expect(await refusal("add_expense", { ...groceries, payerId: w.alex.id, shares: { [w.alex.id]: 10000 } })).toMatch(/shares|unrecognized/i);
    await write("void_expense", { expenseId: added.id });
    expect(await refusal("void_expense", { expenseId: added.id })).toMatch(/void; nothing was changed/);
    expect(await refusal("edit_expense", { expenseId: added.id, totalCents: 500 })).toMatch(/void; nothing was changed/);
    expect(await refusal("edit_expense", { expenseId: "not-an-id" })).toMatch(/does not exist/);
  });

  it("adds a retried call once, and says the second time that it was already added", async () => {
    const call = { ...groceries, payerId: w.alex.id };
    const first = await write("add_expense", call);
    const again = await write("add_expense", call);
    expect(first.alreadyAdded).toBeUndefined();
    expect(again).toMatchObject({ alreadyAdded: true, expense: { id: first.expense.id } });
    expect(await w.db.select().from(expense)).toHaveLength(1);
    expect((await read("get_balance")).net).toEqual({ [w.alex.id]: 5000, [w.sam.id]: -5000 });
  });

  it("adds it again when the amount differs, another token sends it, or two minutes have passed", async () => {
    const call = { ...groceries, payerId: w.alex.id };
    await write("add_expense", call);
    expect((await write("add_expense", { ...call, totalCents: 10001 })).alreadyAdded).toBeUndefined();
    const other = await createMcpToken(w.db, w.alex, { name: "Receipts agent", permission: "write" });
    expect((await write("add_expense", call, other.token)).alreadyAdded).toBeUndefined();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 3 * 60_000);
      expect((await write("add_expense", call)).alreadyAdded).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(await w.db.select().from(expense)).toHaveLength(4);
  });

  it("refuses an amount that is not a positive whole number of cents, or absurdly large", async () => {
    for (const totalCents of [0, -10000, 100.5, 1e20]) {
      expect(await refusal("add_expense", { ...groceries, payerId: w.alex.id, totalCents }), String(totalCents)).toMatch(/totalCents/);
    }
    expect(await w.db.select().from(expense)).toEqual([]);
  });

  it("is refused once revoked", async () => {
    await revokeMcpToken(w.db, w.alex, writerId);
    const { status } = await post(rpc("tools/call", { name: "add_expense", arguments: { ...groceries, payerId: w.alex.id } }), {
      token: writer,
      headers: { "mcp-protocol-version": LEGACY },
    });
    expect(status).toBe(401);
    expect(await w.db.select().from(expense)).toEqual([]);
  });

  it("cannot use another group's account or category", async () => {
    const [biz] = await w.db.insert(household).values({ name: "Studio", kind: "business" }).returning();
    const [inBusiness] = await w.db
      .insert(member)
      .values({ householdId: biz!.id, email: w.alex.email, displayName: "Alex", authUserId: w.alex.authUserId, linkedAt: new Date() })
      .returning();
    await w.db.insert(category).values({ householdId: biz!.id, slug: "studio_rent", label: "Studio rent" });
    const card = await addAccount(w.db, inBusiness!, { name: "Studio card", kind: "business" });
    expect(await refusal("add_expense", { ...groceries, payerId: w.alex.id, accountId: card.id })).toMatch(/account/);
    expect(await refusal("add_expense", { ...groceries, payerId: w.alex.id, category: "studio_rent" })).toMatch(/category/);
    expect(await w.db.select().from(expense)).toEqual([]);
  });

  it("cannot edit or void an expense in another group, even one its own member is in", async () => {
    const [biz] = await w.db.insert(household).values({ name: "Studio", kind: "business" }).returning();
    const [inBusiness] = await w.db
      .insert(member)
      .values({ householdId: biz!.id, email: w.alex.email, displayName: "Alex", authUserId: w.alex.authUserId, linkedAt: new Date() })
      .returning();
    await w.db.insert(category).values({ householdId: biz!.id, slug: "studio_rent", label: "Studio rent" });
    const theirs = await createExpense(w.db, biz!.id, {
      kind: "manual", actor: inBusiness!, date: "2026-10-10", description: "Studio rent", category: "studio_rent", totalCents: 10000, payerId: inBusiness!.id, today: "2026-10-31",
    });
    expect(await refusal("edit_expense", { expenseId: theirs.id, totalCents: 1 })).toMatch(/does not exist/);
    expect(await refusal("void_expense", { expenseId: theirs.id })).toMatch(/does not exist/);
    const [still] = await w.db.select().from(expense).where(eq(expense.id, theirs.id));
    expect(still!.status).toBe("posted");
  });
});

describe("a token that only reads", () => {
  it("does not see the write tools and is refused if it calls one, as is an old propose token", async () => {
    const proposer = await oldProposeToken("Bookkeeper");
    for (const t of [token, proposer.token]) {
      const listed = (await post(rpc("tools/list"), { token: t })).json.result.tools.map((x: { name: string }) => x.name);
      for (const name of WRITE_TOOLS) expect(listed).not.toContain(name);
      const { json } = await post(rpc("tools/call", { name: "add_expense", arguments: { description: "Groceries", totalCents: 10000, category: "groceries", payerId: w.alex.id } }), {
        token: t,
        headers: { "mcp-protocol-version": LEGACY },
      });
      expect(json.error ?? json.result?.isError).toBeTruthy();
    }
    expect(await w.db.select().from(expense)).toEqual([]);
  });

  it("is refused a write tool on the current transport too", async () => {
    const body = {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "add_expense",
        arguments: { description: "Groceries", totalCents: 10000, category: "groceries", payerId: w.alex.id },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    };
    const { json } = await post(body, { headers: { "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": "add_expense" } });
    expect(json.error ?? json.result?.isError).toBeTruthy();
    expect(await w.db.select().from(expense)).toEqual([]);
  });
});
