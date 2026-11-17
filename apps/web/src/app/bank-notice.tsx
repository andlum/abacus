import type { ConnectionView } from "@/lib/bank-link";
import { ConnectBankButton } from "./bank-link-button";

// A bank that wants its owner to sign in again. Until they do, nothing new
// arrives from it.
export function RelinkNotice({ connections }: { connections: ConnectionView[] }) {
  const stuck = connections.filter((c) => c.status === "needs_relink");
  if (stuck.length === 0) return null;
  return (
    <div role="alert" className="grid gap-3 rounded-xl border border-border/70 bg-card p-4 shadow-soft" data-slot="relink-notice">
      {stuck.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center justify-between gap-3">
          <p className="my-0 min-w-0 grow basis-64 text-sm">
            <strong>{c.institutionName}</strong> needs you to sign in again. New purchases stop arriving until you do.
          </p>
          <ConnectBankButton connectionId={c.id}>Sign in again</ConnectBankButton>
        </div>
      ))}
    </div>
  );
}
