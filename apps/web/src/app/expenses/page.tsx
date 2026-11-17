import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;

// The Ledger is on Home now. An old link keeps its filters.
export default async function LedgerPage({ searchParams }: { searchParams: Promise<Params> }) {
  const raw = await searchParams;
  const query = new URLSearchParams(Object.entries(raw).flatMap(([k, v]) => [v].flat().flatMap((x) => (x === undefined ? [] : [[k, x]]))));
  const text = query.toString();
  redirect(text ? `/?${text}` : "/");
}
