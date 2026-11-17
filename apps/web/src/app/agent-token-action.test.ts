// The Settings form's choice of what an agent token may do: only the ticked
// box, posting exactly "write", makes a token that can write.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld, type World } from "@/lib/testing/world";
import { listMcpTokens } from "@/lib/mcp-tokens";

let w: World;
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/session", () => ({ requireHousehold: async () => ({ me: w.alex, db: w.db }) }));

const { createAgentTokenAction } = await import("./actions");

beforeEach(async () => {
  w = await createWorld();
});

const make = async (permission?: string) => {
  const form = new FormData();
  form.set("name", "Bookkeeper");
  if (permission !== undefined) form.set("permission", permission);
  const state = await createAgentTokenAction({}, form);
  expect(state.error).toBeUndefined();
  return (await listMcpTokens(w.db, w.alex))[0]!.permission;
};

describe("createAgentTokenAction", () => {
  it("makes a write token only when the box posts write", async () => {
    expect(await make("write")).toBe("write");
  });

  it("makes a read token when the box is unticked or posts anything else", async () => {
    for (const posted of [undefined, "", "on", "WRITE", "propose", "admin"]) {
      w = await createWorld();
      expect(await make(posted), String(posted)).toBe("read");
    }
  });
});
