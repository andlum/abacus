import { bankRuntime, listConnections } from "@/lib/bank-link";
import type { requireHousehold } from "@/lib/session";
import { ActionForm } from "../action-form";
import { disconnectBankAction, setBankShareAllAction } from "../actions";
import { ConnectBankButton } from "../bank-link-button";
import { RelinkNotice } from "../bank-notice";
import { accountText } from "../ui";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

// Connect a bank, and the banks the member has connected. Nothing at all
// when this server has no Plaid keys.
export async function BankConnections({ me, db, home }: Ctx) {
  if (!bankRuntime()) return null;
  const connections = await listConnections(db, me);
  return (
    <div data-slot="bank-connections" className="mb-6">
      <h3>Connected banks</h3>
      <p className="note">
        Sign in to your bank through Plaid and its credit cards appear here as accounts (checking, savings and loans are left out). Their purchases, starting
        with the last 30 days, wait on Home for you to add or set aside; only you see them until you add one. Set aside any you already entered by
        hand, so it is not counted twice. Clementine is shown a card&rsquo;s name and last four digits and its purchases, never your
        bank password.
      </p>
      <RelinkNotice connections={connections} />
      {connections.length > 0 && (
        <ul className="my-4 grid list-none gap-4 pl-0">
          {connections.map((c) => (
            <li key={c.id} className="grid gap-3 rounded-xl border border-border/70 bg-card p-4 shadow-soft">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{c.institutionName}</strong>
                {c.status === "ok" ? <span className="tag ok">connected</span> : <span className="tag warn">needs signing in again</span>}
              </div>
              <ul className="grid list-none gap-3 pl-0">
                {c.accounts.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{accountText(a)}</span>
                    <ActionForm action={setBankShareAllAction} done={a.shareAll ? "Back to sorting by hand" : "Sharing everything on this card"} className="row">
                      <input type="hidden" name="accountId" value={a.id} />
                      <input type="hidden" name="on" value={a.shareAll ? "0" : "1"} />
                      <span className="text-sm">Everything shared: {a.shareAll ? "on" : "off"}</span>
                      <button className="quiet">{a.shareAll ? "Turn off" : "Turn on"}</button>
                    </ActionForm>
                  </li>
                ))}
              </ul>
              <p className="note my-0">
                Everything shared, when on, makes each purchase on that card a shared expense by itself, split by {home.name}&rsquo;s rules for its
                date. It applies to purchases that arrive after you turn it on.
              </p>
              <ActionForm
                action={disconnectBankAction}
                done="Disconnected"
                confirm={`Disconnect ${c.institutionName}? No new purchases will arrive, and anything waiting to be sorted is set aside. Its cards stay in Accounts and past expenses stay as they are. You can connect again later.`}
              >
                <input type="hidden" name="connectionId" value={c.id} />
                <button className="danger">Disconnect</button>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      <ConnectBankButton>Connect a bank</ConnectBankButton>
    </div>
  );
}
