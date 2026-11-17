import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { UserError } from "@abacus/core/errors";
import { expenseHistory } from "./expense-history";
import { getExpense, voidExpense } from "./expenses";
import { isMalformedInput, isUuid } from "./ids";
import { removeRule } from "./rules";
import { createWorld, type World } from "./testing/world";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

describe("ids from a URL or a form", () => {
  it("are UUIDs, in either case", () => {
    expect(isUuid(randomUUID())).toBe(true);
    expect(isUuid(randomUUID().toUpperCase())).toBe(true);
    expect(isUuid("not-an-id")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  // The pages under /expenses/[id] turn a UserError into not-found, and a
  // form shows it; a database error would be a 500.
  it.each(["not-an-id", randomUUID()])("that name nothing are a UserError from the page lookups: %s", async (id) => {
    await expect(getExpense(w.db, w.householdId, id)).rejects.toBeInstanceOf(UserError);
    await expect(expenseHistory(w.db, w.householdId, id)).rejects.toBeInstanceOf(UserError);
    await expect(removeRule(w.db, w.alex, id, "2026-10-01")).rejects.toBeInstanceOf(UserError);
    await expect(voidExpense(w.db, w.alex, id)).rejects.toBeInstanceOf(UserError);
  });

  it("that reach Postgres malformed are recognised, so a form or route can answer 400", async () => {
    const err = await w.db.execute(sql`select ${"not-an-id"}::uuid`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isMalformedInput(err)).toBe(true);
    expect(isMalformedInput(new UserError("no"))).toBe(false);
    expect(isMalformedInput(null)).toBe(false);
  });
});
