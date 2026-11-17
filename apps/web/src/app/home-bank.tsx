import Link from "next/link";
import { shortDate } from "@abacus/core/dates";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { billSuggestions, listToSort } from "@/lib/bank";
import { listTies } from "@/lib/bank-match";
import { bankRuntime, listConnections, listSetAside } from "@/lib/bank-link";
import type { requireHousehold } from "@/lib/session";
import { ActionForm } from "./action-form";
import { addFromBankAction, matchBillAction, notThisPurchaseAction, restoreBankAction, setAsideBankAction } from "./actions";
import { RelinkNotice } from "./bank-notice";
import { CategorySelect, Money, shortName } from "./ui";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;

// Purchases that arrived from a connected bank and wait for their owner to
// say what they are. Nothing at all when the server has no Plaid keys or the
// member has no bank connected.
export async function BankToSort({ ctx }: { ctx: Ctx }) {
  if (!bankRuntime()) return null;
  const { db, me, categories, today } = ctx;
  const connections = await listConnections(db, me);
  if (connections.length === 0) return null;
  const [waiting, setAside] = await Promise.all([listToSort(db, me), listSetAside(db, me)]);
  const bills = await billSuggestions(db, me, waiting);
  const ties = await listTies(db, me, today);

  return (
    <>
      <RelinkNotice connections={connections} />
      <Card id="to-sort" aria-label="To sort" role="region" className="scroll-mt-20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">To sort {waiting.length > 0 && <Badge>{waiting.length}</Badge>}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="note mt-0">Only you see these. Add one to share it with the group, or set it aside.</p>
          {waiting.length === 0 && <p className="note my-0">Nothing waiting from your bank.</p>}
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
          {ties.length > 0 && (
            <details className="mt-4">
              <summary>Matched to recurring costs ({ties.length})</summary>
              <ul className="list-none divide-y divide-border/70 pl-0 space-y-0">
                {ties.map((t) => (
                  <li key={t.transactionId} className="py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {t.description}, {shortDate(t.date, today)}, <Money cents={t.amountCents} />, matched to <Link href={`/expenses/${t.expenseId}`}>{t.costName}</Link>
                      </span>
                      <ActionForm action={notThisPurchaseAction} done="Back in To sort" className="row">
                        <input type="hidden" name="transactionId" value={t.transactionId} />
                        <button className="quiet">Not this purchase</button>
                      </ActionForm>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
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
