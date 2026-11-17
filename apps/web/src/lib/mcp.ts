// /api/mcp: the Model Context Protocol endpoint agents connect to with an
// `abm_` token (mcp-tokens.ts). Streamable HTTP without sessions: each POST
// carries one JSON-RPC message and is answered in JSON. Both protocol eras
// are served by the official SDK: the 2026-07-28 revision through
// createMcpHandler, and 2025-era clients (the `initialize` handshake) through
// a stateless transport, so today's clients connect too.
//
// The token is checked here, before the SDK sees the request, and decides
// the group and member for everything that follows. So is the body: at most
// MAX_MCP_BODY_BYTES, and one message, not a JSON-RPC batch, so the rate
// limit counts every call.
import { eq } from "drizzle-orm";
import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { isIsoDate, todayIn } from "@abacus/core/dates";
import { getDb } from "../db/client.ts";
import { household, member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { DEV_TODAY_HEADER } from "./api.ts";
import { devAuthEnabled } from "./dev-auth.ts";
import { authenticateMcpToken, canWrite } from "./mcp-tokens.ts";
import { registerReadTools, registerWriteTools, type McpContext } from "./mcp-tools.ts";
import { fixedWindow } from "./rate-limit.ts";

export const MCP_CALLS_PER_MINUTE = 60;
export const MAX_MCP_BODY_BYTES = 1024 * 1024;

let limit = fixedWindow({ limit: MCP_CALLS_PER_MINUTE, windowMs: 60_000 });

// For tests: start every token's count again.
export function resetMcpRateLimit() {
  limit = fixedWindow({ limit: MCP_CALLS_PER_MINUTE, windowMs: 60_000 });
}

const ABOUT =
  "Clementine keeps a group's shared expenses (a household or a small business). This token reaches one group " +
  "and acts for one member of it. Call get_context first. All money is in integer cents; dates are YYYY-MM-DD. " +
  "Never work out a split yourself: preview_split asks the server. ";
const READS = "Every tool reads; none adds, changes or voids anything. People do that in the Clementine app.";
const WRITES =
  "add_expense, edit_expense and void_expense take effect at once, as the member, and are recorded as done by " +
  "their agent. Write only what the person asked for, ask when a category or payer was not stated, and say what " +
  "was written and how it was split.";

// One JSON-RPC error, as the transport answers its own refusals.
const rpcError = (status: number, code: number, message: string, headers: Record<string, string> = {}) =>
  Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status, headers });

// The body as text, or null when it is over the limit: by Content-Length when
// the client sent one, and by the bytes actually read either way.
async function readBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > MAX_MCP_BODY_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MCP_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const isBatch = (text: string) => {
  try {
    return Array.isArray(JSON.parse(text));
  } catch {
    return false; // the SDK answers a body that is not JSON
  }
};

// The factory reads its context from authInfo, which this module sets after
// checking the token; the SDK passes it through untouched.
function serverFor({ authInfo }: { authInfo?: AuthInfo }): McpServer {
  const ctx = authInfo?.extra?.abacus as McpContext | undefined;
  if (!ctx) throw new Error("an MCP server was asked for without a signed-in token");
  const instructions = ABOUT + (canWrite(ctx.token) ? WRITES : READS);
  const server = new McpServer({ name: "abacus", version: "1.0.0" }, { capabilities: { tools: {} }, instructions });
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  return server;
}

const modern = createMcpHandler(serverFor, { legacy: "reject", responseMode: "json", onerror: (e) => console.error("mcp", e) });

export async function handleMcp(req: Request, db: Db = getDb()): Promise<Response> {
  if (req.method !== "POST") return rpcError(405, -32000, "Method not allowed.", { allow: "POST" });

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const found = bearer ? await authenticateMcpToken(db, bearer) : null;
  // Whether the token was missing, unknown, revoked or of the wrong kind is not said.
  if (!found) return rpcError(401, -32001, "Unauthorized", { "www-authenticate": "Bearer" });

  const allowed = limit(found.token.id);
  if (!allowed.ok) {
    return rpcError(429, -32000, "Too many requests; slow down and try again shortly.", {
      "retry-after": String(allowed.retryAfterSeconds),
    });
  }

  const text = await readBody(req);
  if (text === null) return rpcError(413, -32000, `Request body too large; the limit is ${MAX_MCP_BODY_BYTES} bytes.`);
  if (isBatch(text)) return rpcError(400, -32600, "Batches are not accepted; send one message per request.");
  // The body has been read, so the SDK gets a copy holding the same bytes.
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  req = new Request(req.url, { method: req.method, headers, body: text });

  const [home] = await db.select().from(household).where(eq(household.id, found.member.householdId));
  const members = await db.select().from(member).where(eq(member.householdId, found.member.householdId)).orderBy(member.id);
  const pretend = devAuthEnabled() ? req.headers.get(DEV_TODAY_HEADER) : null;
  const now = new Date();
  const today = pretend && isIsoDate(pretend) ? pretend : todayIn(home!.timezone, now);
  const ctx: McpContext = { db, me: found.member, token: found.token, home: home!, members, today, now };
  const authInfo: AuthInfo = { token: bearer, clientId: found.token.id, scopes: [found.token.permission], extra: { abacus: ctx } };

  if (await isLegacyRequest(req)) {
    // 2025-era clients: a fresh server and transport for this one request,
    // answering in JSON rather than an event stream.
    const server = serverFor({ authInfo });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req, { authInfo });
    } finally {
      await server.close();
    }
  }
  return modern.fetch(req, { authInfo });
}
