import { redirect } from "next/navigation";
import { requireHousehold } from "@/lib/session";

export const dynamic = "force-dynamic";

// The month page moved into the Ledger on Home, with this month picked.
export default async function ThisMonth() {
  const { today } = await requireHousehold();
  redirect(`/?month=${today.slice(0, 7)}`);
}
