"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

const LINKS = [
  ["/", "Home"],
  ["/recurring", "Recurring costs"],
  ["/activity", "Activity"],
  ["/settings", "Settings"],
] as const;

export function MainNav() {
  const path = usePathname();
  // On a phone the nav scrolls sideways; bring the current tab into view with
  // a neighbour showing on each side, so it is clear there is more.
  useEffect(() => {
    const on = document.querySelector<HTMLElement>('nav[aria-label="Main"] a[aria-current="page"]');
    const nav = on?.parentElement;
    if (!on || !nav || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({ left: on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2 });
  }, [path]);
  return (
    <>
      {LINKS.map(([href, label]) => {
        const on = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={on ? "page" : undefined}
            className={cn(
              "rounded-full px-3 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
              on && "bg-secondary text-secondary-foreground hover:text-secondary-foreground",
            )}
          >
            {label}
          </Link>
        );
      })}
    </>
  );
}
