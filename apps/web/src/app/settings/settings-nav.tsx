"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { OLD_ANCHORS, SECTIONS } from "./sections";

// The five parts of Settings, beside the page from sm up.
export function SettingsNav() {
  const path = usePathname();
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {SECTIONS.map((s) => {
        const href = `/settings/${s.slug}`;
        const on = path === href;
        return (
          <li key={s.slug} className="m-0">
            <Link
              href={href}
              aria-current={on ? "page" : undefined}
              className={cn(
                "block rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground no-underline transition-colors hover:text-foreground",
                on && "bg-secondary text-secondary-foreground hover:text-secondary-foreground",
              )}
            >
              {s.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

// Settings was one page with an anchor per part. A link or bookmark from
// then (/settings#income) goes on to the page that part is on now. The
// server never sees the anchor, so this happens in the browser.
export function OldAnchorRedirect() {
  const router = useRouter();
  useEffect(() => {
    const to = OLD_ANCHORS[window.location.hash.slice(1)];
    if (to) router.replace(to);
  }, [router]);
  return null;
}
