// Agents only read now, but expenses they proposed before stay in the table
// as `proposed` or `rejected`. Those rows never counted and still must not.
import { beforeEach, describe, expect, it } from "vitest";
import { listAttention } from "./attention";
import { getBalance } from "./balance";
import { listByStatus, listMonth } from "./expenses";
import { createWorld, legacyProposal, type World } from "./testing/world";
import { exportCsv } from "./transfer";

let w: World;
beforeEach(async () => {
  w = await createWorld();
});

describe("an expense an agent proposed before agents could only read", () => {
  it("counts for nothing, waiting or turned down: not in the balance, the month, the export or the to-do lists", async () => {
    await legacyProposal(w, { date: "2026-11-10", description: "Printer paper", totalCents: 4000 });
    await legacyProposal(w, { date: "2026-11-11", description: "Toner", totalCents: 6000 }, "rejected");
    expect(await getBalance(w.db, w.householdId)).toMatchObject({ owes: [] });
    expect(await listMonth(w.db, w.householdId, "2026-11")).toEqual([]);
    const csv = await exportCsv(w.db, w.householdId, "2026-01-01", "2026-12-31");
    expect(csv).not.toMatch(/Printer paper|Toner/);
    for (const status of ["posted", "unassigned", "needs_amount"] as const) {
      expect(await listByStatus(w.db, w.householdId, status)).toEqual([]);
    }
    expect(await listAttention(w.db, w.householdId, "2026-11-30")).toMatchObject({ needsAmount: [], unassigned: [], count: 0 });
  });
});
