"use client";

import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

type SidePanelProps = {
  // The button that opens the panel.
  trigger: ReactNode;
  title: string;
  description?: ReactNode;
  children: ReactNode;
};

// A panel that slides in from the right, over the page, for things that are
// not part of the day-to-day flow. Full width on a phone. Following a link
// inside it closes it, so the page it leads to is not left covered.
export function SidePanel({ trigger, title, description, children }: SidePanelProps) {
  const [open, setOpen] = useState(false);
  const closeOnLink = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a[href]")) setOpen(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger render={<Button variant="outline" size="sm" />}>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/30 transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          onClick={closeOnLink}
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col gap-4 overflow-y-auto border-l-2 border-edge bg-card p-5 text-sm text-card-foreground shadow-soft outline-none transition-transform duration-200 ease-out data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full sm:max-w-lg sm:p-6"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="grid gap-1">
              <Dialog.Title className="mt-0 mb-0 font-heading text-base leading-snug font-semibold">{title}</Dialog.Title>
              {description && <Dialog.Description className="mb-0 text-muted-foreground">{description}</Dialog.Description>}
            </div>
            <Dialog.Close render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
              <X />
            </Dialog.Close>
          </div>
          <div>{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
