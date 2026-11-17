import { describe, expect, it, vi } from "vitest";
import { expense } from "@/db/schema";
import { postDue } from "./expenses";
import { createTemplate } from "./templates";
import { createWorld } from "./testing/world";

vi.mock("./bank-match", async (original) => ({
  ...(await original<typeof import("./bank-match")>()),
  tieWaitingPurchase: async () => {
    throw new Error("matching broke");
  },
}));

describe("a recurring cost when matching a card purchase fails", () => {
  it("is still posted, and the failure is logged without a bank description", async () => {
    const w = await createWorld();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await createTemplate(w.db, w.alex, { name: "Internet", amountCents: 8000, cadence: "monthly", dayOfMonth: 5, payerId: w.alex.id, startDate: "2027-03-01" });
    const posted = await postDue(w.db, w.householdId, "2027-03-20");
    expect(posted).toHaveLength(1);
    expect(await w.db.select().from(expense)).toHaveLength(1);
    expect(log.mock.calls.flat().join("\n")).toMatch(/matching a card purchase .* failed: Error/);
    log.mockRestore();
  });
});
