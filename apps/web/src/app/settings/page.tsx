import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireHousehold } from "@/lib/session";
import { Shell } from "../ui";
import { SECTIONS } from "./sections";
import { OldAnchorRedirect } from "./settings-nav";

export const metadata = { title: "Settings · Clementine" };
export const dynamic = "force-dynamic";

// The parts of Settings, each a page of its own. A link that preselects
// what a new split rule covers (`cover`) goes on to People, where the rules are.
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ cover?: string }> }) {
  const { cover } = await searchParams;
  if (cover) redirect(`/settings/people?${new URLSearchParams({ cover })}`);
  const ctx = await requireHousehold();
  return (
    <Shell {...ctx} title="Settings">
      <OldAnchorRedirect />
      <ul aria-label="Settings" className="m-0 list-none divide-y divide-border/70 rounded-xl border border-border/70 bg-card p-0 shadow-soft">
        {SECTIONS.map((s) => (
          <li key={s.slug} className="m-0">
            <Link href={`/settings/${s.slug}`} className="flex items-center justify-between gap-3 px-4 py-3 text-foreground no-underline hover:bg-accent">
              <span className="min-w-0">
                <span className="block font-medium">{s.label}</span>
                <span className="block text-sm text-muted-foreground">{s.about}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
