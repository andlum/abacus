import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { member } from "../db/schema.ts";
import { gettingStarted } from "./getting-started.ts";
import { createTemplate } from "./templates.ts";
import { agree, createWorld, type World } from "./testing/world.ts";

let w: World;
beforeEach(async () => {
  w = await createWorld({ samJoined: false });
});

const steps = () => gettingStarted(w.db, w.alex);

describe("gettingStarted", () => {
  it("starts with every step open", async () => {
    expect(await steps()).toEqual({ partner: "Sam", partnerJoined: false, hasRecurring: false, hasRule: false, done: false });
  });

  it("counts the partner as joined once they have signed in", async () => {
    await w.db.update(member).set({ linkedAt: new Date() }).where(eq(member.id, w.sam.id));
    expect((await steps()).partnerJoined).toBe(true);
  });

  it("counts the partner as joined once they have done anything", async () => {
    await createTemplate(w.db, w.sam, {
      name: "Rent",
      category: "housing",
      amountCents: 200000,
      cadence: "monthly",
      dayOfMonth: 1,
      payerId: w.sam.id,
      startDate: "2027-03-01",
    });
    expect(await steps()).toMatchObject({ partnerJoined: true, hasRecurring: true });
  });

  it("is done once there is a recurring cost and an agreed rule", async () => {
    await w.db.update(member).set({ linkedAt: new Date() }).where(eq(member.id, w.sam.id));
    await createTemplate(w.db, w.alex, {
      name: "Rent",
      category: "housing",
      amountCents: 200000,
      cadence: "monthly",
      dayOfMonth: 1,
      payerId: w.alex.id,
      startDate: "2027-03-01",
    });
    await agree(w, "2027-03-01", { rules: [{ scope: "household", rule: { kind: "even" } }] });
    expect(await steps()).toMatchObject({ hasRule: true, done: true });
  });
});
