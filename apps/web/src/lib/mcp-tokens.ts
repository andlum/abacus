// Tokens for agents. Each is tied to one member row, so it reaches that
// member's group and no other. A `read` token only reads. A `write` token can
// also add, edit and void expenses, at once, as its member. A `propose` token
// is from when an agent's writes waited for a person to confirm them; it only
// reads, since its owner agreed to proposals and not to writes. As with
// device tokens (api-tokens.ts), the token is shown
// once and only its SHA-256 is kept. The two kinds never stand in for each
// other: each looks only for its own prefix, in its own table.
import { and, count, desc, eq, getTableColumns, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { UserError } from "@abacus/core/errors";
import { isUuid } from "./ids.ts";
import { mcpToken, member, type McpToken, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { hashToken, newToken, tokenMember } from "./api-tokens.ts";
import { writeAudit } from "./audit.ts";

const TOKEN = /^abm_[A-Za-z0-9_-]{43}$/;
const MAX_NAME = 80;

// The most unrevoked agent tokens one person can have in a group.
export const MAX_LIVE_MCP_TOKENS = 10;

export type McpTokenListing = Omit<McpToken, "tokenHash">;

// Whether a token may add, edit and void expenses. Only `write`: an old
// `propose` token reads.
export const canWrite = (t: Pick<McpToken, "permission">) => t.permission === "write";

const { tokenHash: _hash, ...listed } = getTableColumns(mcpToken);

export async function createMcpToken(
  db: Db,
  actor: Member,
  input: { name: string; permission?: "read" | "write" },
): Promise<{ token: string; row: McpTokenListing }> {
  const label = input.name.trim();
  if (!label) throw new UserError("give the token a name, such as the agent it is for");
  if (label.length > MAX_NAME) throw new UserError(`that name is too long; keep it to ${MAX_NAME} characters or fewer`);
  const token = newToken("abm");
  const row = await db.transaction(async (tx) => {
    // One at a time per person, so two requests cannot both see room for one more.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"abacus.mcp-tokens." + actor.id}))`);
    const [live] = await tx
      .select({ n: count() })
      .from(mcpToken)
      .where(and(eq(mcpToken.memberId, actor.id), isNull(mcpToken.revokedAt)));
    if (live!.n >= MAX_LIVE_MCP_TOKENS) {
      throw new UserError(`you can have at most ${MAX_LIVE_MCP_TOKENS} agent tokens; revoke one you no longer use first`);
    }
    const [row] = await tx
      .insert(mcpToken)
      .values({
        memberId: actor.id,
        householdId: actor.householdId,
        name: label,
        permission: input.permission === "write" ? "write" : "read",
        tokenHash: hashToken(token),
      })
      .returning(listed);
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "mcp_token.created",
      entity: { type: "mcp_token", id: row!.id },
      detail: { permission: row!.permission },
    });
    return row!;
  });
  return { token, row };
}

// The member's own tokens in the group that row belongs to, newest first.
export async function listMcpTokens(db: Db, actor: Member): Promise<McpTokenListing[]> {
  return db
    .select(listed)
    .from(mcpToken)
    .where(and(eq(mcpToken.memberId, actor.id), eq(mcpToken.householdId, actor.householdId)))
    .orderBy(desc(mcpToken.createdAt));
}

// Only the token's owner can revoke it.
export async function revokeMcpToken(db: Db, actor: Member, tokenId: string): Promise<void> {
  if (!isUuid(tokenId)) throw new UserError("there is no such token");
  const mine = and(eq(mcpToken.id, tokenId), eq(mcpToken.memberId, actor.id), eq(mcpToken.householdId, actor.householdId));
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(mcpToken)
      .set({ revokedAt: new Date() })
      .where(and(mine, isNull(mcpToken.revokedAt)))
      .returning(listed);
    if (!row) {
      // Nothing changed: say whether the token is unknown or already revoked.
      const [known] = await tx.select({ id: mcpToken.id }).from(mcpToken).where(mine);
      throw new UserError(known ? "that token is already revoked" : "there is no such token");
    }
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "mcp_token.revoked",
      entity: { type: "mcp_token", id: tokenId },
      detail: { permission: row.permission },
    });
  });
}

// The member and token behind a bearer token, or null for any token that is
// unknown, malformed, revoked, or whose member is not in the token's group or
// has not joined it. Joined is either marker: an account linked by accepting
// an invitation or founding the group (both set), or `linked_at` alone, which
// is how the local sign-in stand-in marks it (e2e/reset-db.ts). A cancelled
// invitation never counts. Marks the token as used, at most once a minute.
export async function authenticateMcpToken(db: Db, bearer: string): Promise<{ member: Member; token: McpTokenListing } | null> {
  if (!TOKEN.test(bearer)) return null;
  const [found] = await db
    .select({ member, token: listed })
    .from(mcpToken)
    .innerJoin(member, tokenMember(mcpToken))
    .where(and(eq(mcpToken.tokenHash, hashToken(bearer)), isNull(mcpToken.revokedAt)));
  if (!found) return null;
  const now = new Date();
  const [touched] = await db
    .update(mcpToken)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(mcpToken.id, found.token.id),
        or(isNull(mcpToken.lastUsedAt), lt(mcpToken.lastUsedAt, new Date(now.getTime() - 60_000))),
      ),
    )
    .returning({ lastUsedAt: mcpToken.lastUsedAt });
  return { member: found.member, token: touched ? { ...found.token, lastUsedAt: touched.lastUsedAt } : found.token };
}
