// Tokens for the API. The token itself is shown once, when it is made; the
// database keeps only its SHA-256, so a leaked database cannot be used to call
// the API.
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { UserError } from "@abacus/core/errors";
import { isUuid } from "./ids.ts";
import { apiToken, member, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";

const TOKEN = /^abk_[A-Za-z0-9_-]{43}$/;

// Shared with agent tokens (mcp-tokens.ts), which differ only by prefix.
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

export type ApiTokenListing = { id: string; name: string; createdAt: Date; revokedAt: Date | null };

export async function createApiToken(db: Db, actor: Member, name: string) {
  const label = name.trim();
  if (!label) throw new UserError("give the token a name, such as the device it is for");
  const token = newToken("abk");
  const row = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(apiToken)
      .values({ memberId: actor.id, householdId: actor.householdId, name: label, tokenHash: hashToken(token) })
      .returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "api_token.created",
      entity: { type: "api_token", id: row!.id },
      detail: { name: label },
    });
    return row!;
  });
  return { token, row };
}

// The join from a token to its member, for a member who is in the token's
// group now: joined, by an account linked on accepting an invitation or
// founding the group, or by `linked_at` alone, which is how the local
// sign-in stand-in marks it (e2e/reset-db.ts); and never with the invitation
// cancelled, and never once removed (removeMember). Checked on every request, so a token stops working the moment
// its member stops counting, whatever else happens to the token.
export const tokenMember = (t: { memberId: AnyPgColumn; householdId: AnyPgColumn }) =>
  and(
    eq(member.id, t.memberId),
    eq(member.householdId, t.householdId),
    or(isNotNull(member.authUserId), isNotNull(member.linkedAt)),
    isNull(member.inviteCancelledAt),
    isNull(member.removedAt),
  );

// The member a token acts for, or null for any token that is unknown,
// malformed or revoked, or whose member is no longer in its group.
export async function memberForToken(db: Db, token: string): Promise<Member | null> {
  if (!TOKEN.test(token)) return null;
  const [found] = await db
    .select({ member })
    .from(apiToken)
    .innerJoin(member, tokenMember(apiToken))
    .where(and(eq(apiToken.tokenHash, hashToken(token)), isNull(apiToken.revokedAt)));
  return found?.member ?? null;
}

export async function listApiTokens(db: Db, memberId: string): Promise<ApiTokenListing[]> {
  return db
    .select({ id: apiToken.id, name: apiToken.name, createdAt: apiToken.createdAt, revokedAt: apiToken.revokedAt })
    .from(apiToken)
    .where(eq(apiToken.memberId, memberId))
    .orderBy(desc(apiToken.createdAt));
}

// Only the token's owner can revoke it.
export async function revokeApiToken(db: Db, actor: Member, tokenId: string): Promise<void> {
  if (!isUuid(tokenId)) throw new UserError("there is no such token");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(apiToken)
      .where(and(eq(apiToken.id, tokenId), eq(apiToken.memberId, actor.id)));
    if (!row) throw new UserError("there is no such token");
    if (row.revokedAt) throw new UserError("that token is already revoked");
    await tx.update(apiToken).set({ revokedAt: new Date() }).where(eq(apiToken.id, tokenId));
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "api_token.revoked",
      entity: { type: "api_token", id: tokenId },
      detail: { name: row.name },
    });
  });
}
