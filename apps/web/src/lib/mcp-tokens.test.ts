import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, household, mcpToken, member } from "@/db/schema";
import { createApiToken, memberForToken } from "./api-tokens";
import {
  authenticateMcpToken,
  createMcpToken,
  listMcpTokens,
  MAX_LIVE_MCP_TOKENS,
  revokeMcpToken,
} from "./mcp-tokens";
import { createWorld, type World } from "./testing/world";

let w: World;
beforeEach(async () => {
  w = await createWorld();
  // Alex has signed in with an account; Sam's row has none linked yet.
  w.alex = (await w.db.update(member).set({ authUserId: "auth-alex" }).where(eq(member.id, w.alex.id)).returning())[0]!;
});

const reader = { name: "Receipts agent" };

// Alex's row in a second group, a business.
async function alexInBusiness() {
  const [biz] = await w.db.insert(household).values({ name: "Corner Bakery", kind: "business" }).returning();
  const [row] = await w.db
    .insert(member)
    .values({ householdId: biz!.id, email: w.alex.email, displayName: "Alex", authUserId: w.alex.authUserId, linkedAt: new Date() })
    .returning();
  return row!;
}

describe("agent tokens", () => {
  it("are shown once as abm_ and 43 characters, and stored only as a hash", async () => {
    const { token, row } = await createMcpToken(w.db, w.alex, reader);
    expect(token).toMatch(/^abm_[A-Za-z0-9_-]{43}$/);
    expect(row).toMatchObject({ name: "Receipts agent", permission: "read", memberId: w.alex.id, householdId: w.householdId });
    const [stored] = await w.db.select().from(mcpToken);
    expect(stored!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token.slice(4));
  });

  it("need a name of 80 characters or fewer", async () => {
    await expect(createMcpToken(w.db, w.alex, { ...reader, name: "  " })).rejects.toThrow(/name/);
    await createMcpToken(w.db, w.alex, { ...reader, name: "x".repeat(80) });
    await expect(createMcpToken(w.db, w.alex, { ...reader, name: "x".repeat(81) })).rejects.toThrow("keep it to 80 characters or fewer");
  });

  it(`are capped at ${MAX_LIVE_MCP_TOKENS} live per person, and a revoked one frees a place`, async () => {
    const made = await Promise.all(
      Array.from({ length: MAX_LIVE_MCP_TOKENS }, (_, i) => createMcpToken(w.db, w.alex, { ...reader, name: `agent ${i}` })),
    );
    await expect(createMcpToken(w.db, w.alex, reader)).rejects.toThrow(/at most/);
    // Sam has a cap of his own.
    await createMcpToken(w.db, w.sam, reader);
    await revokeMcpToken(w.db, w.alex, made[0]!.row.id);
    await createMcpToken(w.db, w.alex, reader);
  });

  it("are listed for their owner in this group only, revoked ones too, never with the hash", async () => {
    const mine = await createMcpToken(w.db, w.alex, reader);
    await createMcpToken(w.db, w.sam, { ...reader, name: "Sam's agent" });
    const business = await alexInBusiness();
    await createMcpToken(w.db, business, { ...reader, name: "Bakery agent" });
    await revokeMcpToken(w.db, w.alex, mine.row.id);

    const listed = await listMcpTokens(w.db, w.alex);
    expect(listed.map((t) => t.name)).toEqual(["Receipts agent"]);
    expect(listed[0]!.revokedAt).not.toBeNull();
    expect(listed[0]).not.toHaveProperty("tokenHash");
    expect((await listMcpTokens(w.db, business)).map((t) => t.name)).toEqual(["Bakery agent"]);
  });

  it("can be revoked by their owner only, once", async () => {
    const { token, row } = await createMcpToken(w.db, w.alex, reader);
    await expect(revokeMcpToken(w.db, w.sam, row.id)).rejects.toThrow(/no such token/);
    await expect(revokeMcpToken(w.db, w.alex, "not-an-id")).rejects.toThrow(/no such token/);
    expect(await authenticateMcpToken(w.db, token)).not.toBeNull();
    await revokeMcpToken(w.db, w.alex, row.id);
    await expect(revokeMcpToken(w.db, w.alex, row.id)).rejects.toThrow(/already/);
  });
});

describe("authenticateMcpToken", () => {
  it("finds the member and token, and records when it was last used", async () => {
    const { token, row } = await createMcpToken(w.db, w.alex, { name: "Bookkeeper" });
    expect(row.lastUsedAt).toBeNull();
    const found = await authenticateMcpToken(w.db, token);
    expect(found?.member.id).toBe(w.alex.id);
    expect(found?.token).toMatchObject({ id: row.id, permission: "read", householdId: w.householdId });
    const [listed] = await listMcpTokens(w.db, w.alex);
    expect(listed!.lastUsedAt).not.toBeNull();
  });

  it("still accepts a propose token made before agents could only read", async () => {
    const { token, row } = await createMcpToken(w.db, w.alex, reader);
    await w.db.update(mcpToken).set({ permission: "propose" }).where(eq(mcpToken.id, row.id));
    expect((await authenticateMcpToken(w.db, token))?.token).toMatchObject({ id: row.id, permission: "propose" });
  });

  it("is made read-only unless write is asked for", async () => {
    expect((await createMcpToken(w.db, w.alex, { name: "Reader" })).row.permission).toBe("read");
    const { token, row } = await createMcpToken(w.db, w.alex, { name: "Bookkeeper", permission: "write" });
    expect(row.permission).toBe("write");
    expect((await authenticateMcpToken(w.db, token))?.token.permission).toBe("write");
  });

  it("can be stored as write, and the database refuses a made-up permission", async () => {
    const { row } = await createMcpToken(w.db, w.alex, reader);
    await w.db.update(mcpToken).set({ permission: "write" }).where(eq(mcpToken.id, row.id));
    await expect(w.db.update(mcpToken).set({ permission: "admin" as "write" }).where(eq(mcpToken.id, row.id))).rejects.toThrow();
    const [stored] = await w.db.select().from(mcpToken).where(eq(mcpToken.id, row.id));
    expect(stored!.permission).toBe("write");
  });

  it("writes when it was last used at most once a minute", async () => {
    const { token } = await createMcpToken(w.db, w.alex, reader);
    await authenticateMcpToken(w.db, token);
    const [first] = await listMcpTokens(w.db, w.alex);
    await new Promise((r) => setTimeout(r, 5));
    await authenticateMcpToken(w.db, token);
    const [second] = await listMcpTokens(w.db, w.alex);
    expect(second!.lastUsedAt).toEqual(first!.lastUsedAt);
  });

  it("accepts a member joined under the local sign-in stand-in, which marks linked_at and no account", async () => {
    // createWorld marks Sam joined as e2e/reset-db.ts does: linked_at only.
    expect(w.sam).toMatchObject({ authUserId: null, linkedAt: expect.any(Date) });
    const { token } = await createMcpToken(w.db, w.sam, reader);
    expect((await authenticateMcpToken(w.db, token))?.member.id).toBe(w.sam.id);
  });

  it("refuses a token whose member has never joined", async () => {
    const { token } = await createMcpToken(w.db, w.sam, reader);
    await w.db.update(member).set({ linkedAt: null }).where(eq(member.id, w.sam.id));
    expect(await authenticateMcpToken(w.db, token)).toBeNull();
  });

  it("refuses a token whose member's invitation was cancelled, however the row is marked", async () => {
    const { token } = await createMcpToken(w.db, w.alex, reader);
    const { token: samToken } = await createMcpToken(w.db, w.sam, reader);
    await w.db.update(member).set({ inviteCancelledAt: new Date() });
    expect(await authenticateMcpToken(w.db, token)).toBeNull();
    expect(await authenticateMcpToken(w.db, samToken)).toBeNull();
  });

  it("refuses a revoked, unknown, malformed or empty token", async () => {
    const { token, row } = await createMcpToken(w.db, w.alex, reader);
    expect(await authenticateMcpToken(w.db, "abm_" + "x".repeat(43))).toBeNull();
    expect(await authenticateMcpToken(w.db, "garbage")).toBeNull();
    expect(await authenticateMcpToken(w.db, "")).toBeNull();
    await revokeMcpToken(w.db, w.alex, row.id);
    expect(await authenticateMcpToken(w.db, token)).toBeNull();
  });

  it("refuses a device token, and the device path refuses an agent token", async () => {
    const device = await createApiToken(w.db, w.alex, "phone");
    const agent = await createMcpToken(w.db, w.alex, reader);
    expect(await authenticateMcpToken(w.db, device.token)).toBeNull();
    expect(await memberForToken(w.db, agent.token)).toBeNull();
    // Even with the other prefix, the hash names no row in the other table.
    expect(await authenticateMcpToken(w.db, "abm_" + device.token.slice(4))).toBeNull();
    expect(await memberForToken(w.db, "abk_" + agent.token.slice(4))).toBeNull();
  });
});

describe("audit", () => {
  it("records making and revoking a token, with its permission and never the token", async () => {
    const { token, row } = await createMcpToken(w.db, w.alex, { name: "Bookkeeper" });
    await revokeMcpToken(w.db, w.alex, row.id);
    const entries = await w.db.select().from(auditLog).where(eq(auditLog.entityType, "mcp_token"));
    expect(entries.map((e) => [e.action, e.actorMemberId, e.entityId, e.detail])).toEqual([
      ["mcp_token.created", w.alex.id, row.id, { permission: "read" }],
      ["mcp_token.revoked", w.alex.id, row.id, { permission: "read" }],
    ]);
    expect(JSON.stringify(entries)).not.toContain(token);
  });

});
