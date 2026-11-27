import Link from "next/link";
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
        Sign in to your bank through Plaid and its credit cards appear here as accounts (checking, savings and loans are left out). Choose in{" "}
        <Link href="/accounts">Accounts</Link> whether each card is shared or personal, then review its purchases there and pick the ones to split. Only you
        see them until you do. Clementine is shown a card&rsquo;s name and last four digits and its purchases, never your
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
                    {a.shareAll && (
                      <ActionForm action={setBankShareAllAction} done="Back to sorting by hand" className="row">
                        <input type="hidden" name="accountId" value={a.id} />
                        <input type="hidden" name="on" value="0" />
                        <span className="text-sm">Everything shared: on</span>
                        <button className="quiet">Turn off</button>
                      </ActionForm>
                    )}
                  </li>
                ))}
              </ul>
              {c.accounts.some((a) => a.shareAll) && (
                <p className="note my-0">
                  Everything shared, while on, makes each purchase on that card a shared expense by itself, split by {home.name}&rsquo;s rules for its
                  date. Turn it off to review the card&rsquo;s purchases by hand from Accounts.
                </p>
              )}
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
