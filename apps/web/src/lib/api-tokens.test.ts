import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apiToken, mcpToken, member } from "@/db/schema";
import { createApiToken, listApiTokens, memberForToken, revokeApiToken } from "./api-tokens";
import { recentAudit } from "./audit";
import { authenticateMcpToken, createMcpToken } from "./mcp-tokens";
import { cancelInvite } from "./membership";
import { createWorld, type World } from "./testing/world";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

describe("API tokens", () => {
  it("are shown once, stored only as a hash, and find their member", async () => {
    const { token, row } = await createApiToken(w.db, w.alex, "Alex's phone");
    expect(token).toMatch(/^abk_[A-Za-z0-9_-]{43}$/);
    const [stored] = await w.db.select().from(apiToken);
    expect(stored!.tokenHash).not.toContain(token.slice(4));
    expect(row.name).toBe("Alex's phone");
    expect((await memberForToken(w.db, token))?.id).toBe(w.alex.id);
  });

  it("find nobody for an unknown, malformed or empty token", async () => {
    await createApiToken(w.db, w.alex, "phone");
    expect(await memberForToken(w.db, "abk_" + "x".repeat(43))).toBeNull();
    expect(await memberForToken(w.db, "not a token")).toBeNull();
    expect(await memberForToken(w.db, "")).toBeNull();
  });

  it("need a name, so a person can tell their devices apart", async () => {
    await expect(createApiToken(w.db, w.alex, "  ")).rejects.toThrow(/name/);
  });

  it("stop working once revoked, and only their owner can revoke them", async () => {
    const { token, row } = await createApiToken(w.db, w.alex, "phone");
    await expect(revokeApiToken(w.db, w.sam, row.id)).rejects.toThrow();
    await revokeApiToken(w.db, w.alex, row.id);
    expect(await memberForToken(w.db, token)).toBeNull();
    // Kept, marked revoked, rather than deleted.
    const [listed] = await listApiTokens(w.db, w.alex.id);
    expect(listed!.revokedAt).not.toBeNull();
    await expect(revokeApiToken(w.db, w.alex, row.id)).rejects.toThrow(/already/);
  });

  it("are listed for their owner only", async () => {
    await createApiToken(w.db, w.alex, "phone");
    expect(await listApiTokens(w.db, w.sam.id)).toEqual([]);
    expect(await listApiTokens(w.db, w.alex.id)).toHaveLength(1);
  });

  it("write an audit entry when created and revoked, without the token", async () => {
    const { token, row } = await createApiToken(w.db, w.alex, "phone");
    await revokeApiToken(w.db, w.alex, row.id);
    const actions = (await recentAudit(w.db, w.householdId, 10)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["api_token.created", "api_token.revoked"]));
    const all = JSON.stringify(await recentAudit(w.db, w.householdId, 10));
    expect(all).not.toContain(token);
  });

  it("stop working for a member whose invitation was cancelled or who has not joined", async () => {
    const { token } = await createApiToken(w.db, w.sam, "Sam's phone");
    expect((await memberForToken(w.db, token))?.id).toBe(w.sam.id);
    await w.db.update(member).set({ inviteCancelledAt: new Date() }).where(eq(member.id, w.sam.id));
    expect(await memberForToken(w.db, token)).toBeNull();
    await w.db.update(member).set({ inviteCancelledAt: null, linkedAt: null }).where(eq(member.id, w.sam.id));
    expect(await memberForToken(w.db, token)).toBeNull();
  });
});

describe("cancelling an invitation", () => {
  it("revokes the person's device and agent tokens, keeping the rows, with an audit entry each", async () => {
    const device = await createApiToken(w.db, w.sam, "Sam's phone");
    const agent = await createMcpToken(w.db, w.sam, { name: "Receipts" });
    const alexPhone = await createApiToken(w.db, w.alex, "Alex's phone");
    await cancelInvite(w.db, w.alex, w.sam.id);
    expect(await memberForToken(w.db, device.token)).toBeNull();
    expect(await authenticateMcpToken(w.db, agent.token)).toBeNull();
    const [d] = await w.db.select().from(apiToken).where(eq(apiToken.id, device.row.id));
    const [a] = await w.db.select().from(mcpToken).where(eq(mcpToken.id, agent.row.id));
    expect(d!.revokedAt).not.toBeNull();
    expect(a!.revokedAt).not.toBeNull();
    // Only Sam's tokens.
    expect((await memberForToken(w.db, alexPhone.token))?.id).toBe(w.alex.id);
    const actions = (await recentAudit(w.db, w.householdId, 20)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["member.invite_cancelled", "api_token.revoked", "mcp_token.revoked"]));
  });
});
