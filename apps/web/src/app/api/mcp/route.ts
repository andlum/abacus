import { handleMcp } from "@/lib/mcp";

export const dynamic = "force-dynamic";

// The MCP endpoint for agent tokens (src/lib/mcp.ts). Deliberately outside
// /api/v1 and its OpenAPI spec: it speaks JSON-RPC, not REST.
export const POST = (req: Request) => handleMcp(req);

// No sessions and no server-to-client stream, so GET and DELETE have nothing to do.
const notAllowed = () =>
  Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed." } }, { status: 405, headers: { allow: "POST" } });
export const GET = notAllowed;
export const DELETE = notAllowed;
