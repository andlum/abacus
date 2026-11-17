import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { requireHousehold } from "@/lib/session";
import { Shell } from "../ui";
import { SettingsNav } from "./settings-nav";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

// One part of Settings: the list of parts beside it from sm up, and on a
// phone a link back to that list.
export function SettingsFrame({ ctx, children }: { ctx: Ctx; children: ReactNode }) {
  return (
    <Shell {...ctx} title="Settings">
      <Link href="/settings" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground sm:hidden">
        <ChevronLeft className="size-4" aria-hidden />
        All settings
      </Link>
      <div className="grid gap-8 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <nav aria-label="Settings" className="self-start max-sm:hidden sm:sticky sm:top-20">
          <SettingsNav />
        </nav>
        <div className="min-w-0 [&>section:first-child>h2]:mt-0">{children}</div>
      </div>
    </Shell>
  );
}
