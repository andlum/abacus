"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useHydrated } from "./action-form";
import { bankLinkTokenAction, connectBankAction, relinkBankAction } from "./actions";
import { toast } from "./toast";

// Plaid's sign-in window (https://plaid.com/docs/link/web/). Its script has
// to come from Plaid's own address, not from this app. The site sets no
// script or frame rules beyond frame-ancestors (next.config.ts), so nothing
// needs widening for it.
const LINK_SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

type Handler = { open: () => void; destroy: () => void };
type PlaidGlobal = {
  create: (config: {
    token: string;
    onSuccess: (publicToken: string, metadata: { institution?: { name?: string } | null }) => void;
    onExit: (error: { display_message?: string | null } | null) => void;
  }) => Handler;
};

function loadPlaid(): Promise<PlaidGlobal> {
  const ready = () => (window as unknown as { Plaid?: PlaidGlobal }).Plaid;
  return new Promise((resolve, reject) => {
    const have = ready();
    if (have) return resolve(have);
    let script = document.querySelector<HTMLScriptElement>(`script[src="${LINK_SCRIPT}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = LINK_SCRIPT;
      script.async = true;
      document.head.append(script);
    }
    script.addEventListener("load", () => {
      const loaded = ready();
      if (loaded) resolve(loaded);
      else reject(new Error("Plaid did not load"));
    });
    script.addEventListener("error", () => {
      script.remove();
      reject(new Error("Plaid did not load"));
    });
  });
}

// Opens Plaid's window. With `connectionId` it opens in update mode, for
// signing in again to a bank that is already connected.
export function ConnectBankButton({ connectionId, children }: { connectionId?: string; children: ReactNode }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const [plaid, token] = await Promise.all([loadPlaid(), bankLinkTokenAction(connectionId)]);
      if (!token.linkToken) throw new Error(token.error ?? "could not start");
      const handler = plaid.create({
        token: token.linkToken,
        onSuccess: async (publicToken, metadata) => {
          const answer = connectionId ? await relinkBankAction(connectionId) : await connectBankAction(publicToken, metadata.institution?.name ?? "");
          handler.destroy();
          setBusy(false);
          if (answer.error) return setError(`${connectionId ? "Not signed in" : "Not connected"}: ${answer.error}.`);
          toast(connectionId ? "Signed in again" : "Bank connected");
          router.refresh();
        },
        onExit: (exit) => {
          handler.destroy();
          setBusy(false);
          if (exit) setError(exit.display_message || "Plaid could not connect that bank. Try again.");
        },
      });
      handler.open();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error && e.message !== "Plaid did not load" && e.message !== "could not start" ? e.message : "Could not open Plaid. Check your connection and try again.");
    }
  }

  return (
    <span className="grid gap-2">
      <span>
        <button type="button" onClick={() => void start()} disabled={!hydrated || busy}>
          {busy ? "Opening…" : children}
        </button>
      </span>
      {error && (
        <span role="alert" className="error">
          {error}
        </span>
      )}
    </span>
  );
}
