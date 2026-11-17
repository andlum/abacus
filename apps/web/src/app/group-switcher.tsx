"use client";

import { Check, ChevronsUpDown, Plus, Star } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { GroupChoice } from "@/lib/groups";
import { cn } from "@/lib/utils";
import { setDefaultGroupAction, switchGroupAction } from "./groups/actions";

const KIND_LABELS = { household: "Household", business: "Business" } as const;

// The current group's name, in the header. Clicking it lists every group the
// person is in, to switch to or to mark as the one they land in, and ends
// with a way to add another.
export function GroupSwitcher({ groups, currentId }: { groups: GroupChoice[]; currentId: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = groups.find((g) => g.id === currentId);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={root} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Group: ${current?.name ?? ""}. Switch group`}
        onClick={() => setOpen(!open)}
        className="flex max-w-full items-center gap-1 rounded-full px-2.5 py-1 font-semibold tracking-tight hover:bg-accent"
      >
        <span className="truncate">{current?.name}</span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute top-full left-0 z-20 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-border/70 bg-popover p-1.5 text-sm text-popover-foreground shadow-float">
          <ul aria-label="Your groups">
            {groups.map((g) => (
              <li key={g.id} className="flex items-center gap-1">
                <form action={switchGroupAction} className="min-w-0 flex-1">
                  <input type="hidden" name="groupId" value={g.id} />
                  <button
                    type="submit"
                    aria-current={g.id === currentId ? "true" : undefined}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-accent"
                  >
                    <Check aria-hidden className={cn("size-4 shrink-0", g.id !== currentId && "invisible")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{g.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {KIND_LABELS[g.kind]}
                        {g.isDefault && " · default"}
                      </span>
                    </span>
                  </button>
                </form>
                {groups.length > 1 && (
                  <form action={setDefaultGroupAction}>
                    <input type="hidden" name="groupId" value={g.id} />
                    <button
                      type="submit"
                      disabled={g.isDefault}
                      aria-label={g.isDefault ? `${g.name} is your default group` : `Make ${g.name} your default group`}
                      title={g.isDefault ? "Your default group" : "Make this your default group"}
                      className="grid size-9 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:text-primary"
                    >
                      <Star aria-hidden className={cn("size-4", g.isDefault && "fill-current")} />
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
          <div className="my-1 border-t" />
          <Link
            href="/groups/new"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-lg px-2 py-2 font-medium hover:bg-accent"
          >
            <Plus aria-hidden className="size-4 shrink-0" />
            Add a group
          </Link>
        </div>
      )}
    </div>
  );
}
