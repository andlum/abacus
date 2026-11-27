import { shortDate } from "@abacus/core/dates";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { billSuggestions, listToSort } from "@/lib/bank";
import { bankRuntime, listConnections, listSetAside } from "@/lib/bank-link";
import type { requireHousehold } from "@/lib/session";
import { ActionForm } from "./action-form";
import { addFromBankAction, matchBillAction, restoreBankAction, setAsideBankAction } from "./actions";
import { RelinkNotice } from "./bank-notice";
import { CategorySelect, Money, shortName } from "./ui";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

// A bank that wants its owner to sign in again. Nothing at all when the
// server has no Plaid keys or nothing is stuck.
export async function BankRelink({ ctx }: { ctx: Ctx }) {
  if (!bankRuntime()) return null;
  const connections = await listConnections(ctx.db, ctx.me);
  return <RelinkNotice connections={connections} />;
}

// Money in and out of one card that waits for its owner to say what it is.
// Only a card that shares every purchase has any now: review reads the other
// cards' purchases from the bank when asked. Nothing at all when the server
// has no Plaid keys.
export async function ToSortCard({ ctx, accountId }: { ctx: Ctx; accountId: string }) {
  if (!bankRuntime()) return null;
  const { db, me, categories, today } = ctx;
  const [allWaiting, allSetAside] = await Promise.all([listToSort(db, me), listSetAside(db, me)]);
  const waiting = allWaiting.filter((t) => t.accountId === accountId);
  const setAside = allSetAside.filter((t) => t.accountId === accountId);
  const bills = await billSuggestions(db, me, waiting);

  return (
    <>
      <Card id="to-sort" aria-label="To sort" role="region" className="scroll-mt-20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">To sort {waiting.length > 0 && <Badge>{waiting.length}</Badge>}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="note mt-0">Only you see these. Add one to share it with the group, or set it aside.</p>
          {waiting.length === 0 && <p className="note my-0">Nothing waiting.</p>}
          <ul className="list-none divide-y divide-border/70 pl-0 space-y-0">
            {waiting.map((t) => {
              const out = t.amountCents > 0;
              return (
                <li key={t.id} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      <strong>{t.description}</strong>, {shortDate(t.date, today)}
                    </span>
                    <span>
                      {out ? "Out " : "In "}
                      <Money cents={Math.abs(t.amountCents)} />
                    </span>
                  </div>
                  <p className="note my-1">
                    {t.institutionName}, {shortName(t.accountName)}
                    {t.lastFour ? ` ending ${t.lastFour}` : ""}
                  </p>
                  <div className="flex flex-wrap items-end gap-3">
                    {out && (
                      <ActionForm action={addFromBankAction} done="Added to expenses" className="row">
                        <input type="hidden" name="transactionId" value={t.id} />
                        <CategorySelect categories={categories} />
                        <button>Add</button>
                      </ActionForm>
                    )}
                    {(bills.get(t.id) ?? []).map((b) => (
                      <ActionForm key={b.expenseId} action={matchBillAction} done={`Saved as the amount of ${b.name}`} className="row">
                        <input type="hidden" name="transactionId" value={t.id} />
                        <input type="hidden" name="expenseId" value={b.expenseId} />
                        <button>This is {b.name}</button>
                      </ActionForm>
                    ))}
                    <ActionForm action={setAsideBankAction} done="Set aside" className="row">
                      <input type="hidden" name="transactionId" value={t.id} />
                      <button className="quiet">Set aside</button>
                    </ActionForm>
                  </div>
                  {!out && <p className="note my-1">Money coming in can only be set aside.</p>}
                </li>
              );
            })}
          </ul>
          {setAside.length > 0 && (
            <details className="mt-4">
              <summary>Set aside ({setAside.length})</summary>
              <ul className="list-none divide-y divide-border/70 pl-0 space-y-0">
                {setAside.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {t.description}, {shortDate(t.date, today)}, {t.amountCents > 0 ? "out" : "in"} <Money cents={Math.abs(t.amountCents)} />
                    </span>
                    <ActionForm action={restoreBankAction} done="Back in To sort" className="row">
                      <input type="hidden" name="transactionId" value={t.id} />
                      <button className="quiet">Restore</button>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>
    </>
  );
}
