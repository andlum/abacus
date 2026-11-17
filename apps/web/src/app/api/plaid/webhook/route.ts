import { getDb } from "@/db/client";
import { bankRuntime, handlePlaidWebhookRequest } from "@/lib/bank-link";

export const dynamic = "force-dynamic";

// Plaid's webhooks. Not part of /api/v1: it is Plaid that calls this, with a
// signature instead of a sign-in or a token (src/proxy.ts lets it through).
export async function POST(req: Request) {
  return handlePlaidWebhookRequest(req, { db: getDb(), runtime: bankRuntime() });
}
