"use client";

import { Check } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

// A short confirmation at the bottom of the screen: "Invite sent". It is for
// things that worked; a refusal stays next to the form that caused it.
type Toast = { id: number; message: string };

const SHOWN_MS = 4000;
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: Toast[]) {
  toasts = next;
  for (const l of listeners) l();
}

export function toast(message: string) {
  // One at a time: a new message replaces the one on screen.
  set([{ id: nextId++, message }]);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const none: Toast[] = [];

export function Toaster() {
  const shown = useSyncExternalStore(
    subscribe,
    () => toasts,
    () => none,
  );
  const current = shown[0];
  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => set(toasts.filter((t) => t.id !== current.id)), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [current]);

  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="toaster"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
    >
      {current && (
        <div
          key={current.id}
          className="pointer-events-auto flex max-w-sm animate-in items-center gap-2 rounded-full bg-foreground py-2.5 pr-5 pl-4 text-sm font-medium text-background shadow-float duration-300 slide-in-from-bottom-4"
        >
          <Check aria-hidden className="size-4 shrink-0 opacity-80" />
          {current.message}
        </div>
      )}
    </div>
  );
}
