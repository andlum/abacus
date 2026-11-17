import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { household, member } from "@/db/schema";
import { createTestDb } from "@/db/test-db";
import type { Db } from "@/db/types";
import { recentAudit, writeAudit } from "./audit";

let db: Db;
let householdId: string;
let memberId: string;

beforeEach(async () => {
  db = await createTestDb();
  const [h] = await db.insert(household).values({ name: "Test household" }).returning();
  householdId = h!.id;
  const [m] = await db
    .insert(member)
    .values({ householdId, email: "a@example.com", displayName: "A" })
    .returning();
  memberId = m!.id;
});

describe("writeAudit", () => {
  it("records who did what to which entity", async () => {
    await writeAudit(db, {
      householdId,
      actor: { kind: "member", memberId },
      action: "account.added",
      entity: { type: "account", id: "42" },
      detail: { cents: 1250 },
    });

    const [entry] = await recentAudit(db, householdId, 10);
    expect(entry).toMatchObject({
      householdId,
      actorKind: "member",
      actorMemberId: memberId,
      action: "account.added",
      entityType: "account",
      entityId: "42",
      detail: { cents: 1250 },
    });
    expect(entry!.at).toBeInstanceOf(Date);
  });

  it("records system actions without a member", async () => {
    await writeAudit(db, { householdId, actor: { kind: "system" }, action: "household.provisioned" });

    const [entry] = await recentAudit(db, householdId, 10);
    expect(entry).toMatchObject({ actorKind: "system", actorMemberId: null, detail: {} });
  });
});

describe("recentAudit", () => {
  it("returns the newest entries first, limited, for one household only", async () => {
    const [other] = await db.insert(household).values({ name: "Other" }).returning();
    await writeAudit(db, { householdId, actor: { kind: "system" }, action: "expense.posted" });
    await writeAudit(db, { householdId, actor: { kind: "system" }, action: "expense.voided" });
    await writeAudit(db, { householdId, actor: { kind: "system" }, action: "settlement.recorded" });
    await writeAudit(db, { householdId: other!.id, actor: { kind: "system" }, action: "settlement.voided" });

    const entries = await recentAudit(db, householdId, 2);
    expect(entries.map((e) => e.action)).toEqual(["settlement.recorded", "expense.voided"]);
  });
});

describe("audit_log is append-only", () => {
  beforeEach(async () => {
    await writeAudit(db, { householdId, actor: { kind: "system" }, action: "household.provisioned" });
  });

  it("rejects UPDATE", async () => {
    await expect(db.execute(sql`update audit_log set action = 'rewritten'`)).rejects.toThrow();
  });

  it("rejects DELETE", async () => {
    await expect(db.execute(sql`delete from audit_log`)).rejects.toThrow();
  });

  it("rejects TRUNCATE", async () => {
    await expect(db.execute(sql`truncate audit_log`)).rejects.toThrow();
  });

  it("still holds the original row afterwards", async () => {
    await db.execute(sql`delete from audit_log`).catch(() => {});
    const entries = await recentAudit(db, householdId, 10);
    expect(entries.map((e) => e.action)).toEqual(["household.provisioned"]);
  });
});
