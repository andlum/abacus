import { route } from "@/lib/api";
import { listCardAccounts } from "@/lib/card-review";

export const dynamic = "force-dynamic";

// The cards the caller connected.
export const GET = route(async ({ db, me }) => ({ accounts: await listCardAccounts(db, me) }));
