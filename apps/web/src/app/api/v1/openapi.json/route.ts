import { openapi } from "@/lib/openapi";

export const dynamic = "force-static";

// Public, so a client generator can fetch it without a token.
export function GET() {
  return Response.json(openapi);
}
