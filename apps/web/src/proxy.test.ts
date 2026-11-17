// Which paths a signed-out visitor reaches. The MCP endpoint is opened by its
// exact path only, so a route added beside it is not opened by accident.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import proxy from "./proxy";

afterEach(() => vi.unstubAllEnvs());

const signedOut = (path: string) => {
  vi.stubEnv("ABACUS_E2E", "");
  const res = proxy(new NextRequest(`http://test${path}`));
  return res.headers.get("location") ? "redirected" : "open";
};

describe("the proxy, for a signed-out visitor", () => {
  it("opens /api/mcp and /api/v1, and nothing that only starts like them", () => {
    expect(signedOut("/api/mcp")).toBe("open");
    expect(signedOut("/api/v1/me")).toBe("open");
    expect(signedOut("/api/mcpx")).toBe("redirected");
    expect(signedOut("/api/mcp/x")).toBe("redirected");
    expect(signedOut("/api/v1x")).toBe("redirected");
    expect(signedOut("/settings")).toBe("redirected");
  });
});
