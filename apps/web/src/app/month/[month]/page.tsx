import { redirect } from "next/navigation";
import { isMonth } from "@abacus/core/dates";

// The month page moved into the Ledger on Home, with the month picked.
export default async function Month({ params }: { params: Promise<{ month: string }> }) {
  const { month } = await params;
  redirect(isMonth(month) ? `/?month=${month}` : "/");
}
