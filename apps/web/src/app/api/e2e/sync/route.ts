import { getDb } from "@/db/client";
import { syncAllConnections } from "@/lib/bank";
import { e2eBankRuntime } from "@/lib/e2e-plaid";

export const dynamic = "force-dynamic";

// Browser tests only: runs the sync Plaid's webhook or the daily job would,
// against the fake Plaid. Not found anywhere else (src/lib/e2e-plaid.ts).
export async function POST() {
  const runtime = e2eBankRuntime();
  if (!runtime) return new Response(null, { status: 404 });
  return Response.json(await syncAllConnections(getDb(), runtime, new Date()));
}
