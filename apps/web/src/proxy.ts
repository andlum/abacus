import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { devAuthEnabled } from "@/lib/dev-auth";

// Signed-out visitors can reach only the sign-in pages, Better Auth's own
// endpoints, the health check, the API, the MCP endpoint, Plaid's webhook and the
// home-screen manifest (browsers fetch it without cookies). The API and the MCP endpoint
// check their own bearer tokens (src/lib/api.ts, src/lib/mcp.ts); the webhook
// checks Plaid's signature (src/lib/bank-link.ts).
const PUBLIC = [
  /^\/sign-in(\/|$)/,
  /^\/api\/auth\//,
  /^\/api\/health$/,
  /^\/api\/v1(\/|$)/,
  /^\/api\/mcp$/,
  /^\/api\/plaid\/webhook$/,
  /^\/manifest\.webmanifest$/,
];

// Only the cookie's presence is checked here, which is all a proxy can do
// cheaply. Every page then calls requireMember(), which reads the real
// session; a forged cookie gets a redirect there instead of a page.
export default function proxy(request: NextRequest) {
  // With the sign-in stand-in on, pages check the member cookie themselves.
  if (devAuthEnabled()) return NextResponse.next();
  if (PUBLIC.some((re) => re.test(request.nextUrl.pathname))) return NextResponse.next();
  if (!getSessionCookie(request)) return NextResponse.redirect(new URL("/sign-in", request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:ico|png|svg|jpg|jpeg|gif|webp|css|js|map|txt|woff2?)).*)", "/(api|trpc)(.*)"],
};
