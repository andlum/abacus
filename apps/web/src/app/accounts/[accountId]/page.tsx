import Link from "next/link";
import { notFound } from "next/navigation";
import { UserError } from "@abacus/core/errors";
import { bankRuntime } from "@/lib/bank-link";
import { cardAccount } from "@/lib/card-review";
import { requireHousehold } from "@/lib/session";
import { ActionForm } from "../../action-form";
import { setBankShareAllAction } from "../../actions";
import { BankRelink, ToSortCard } from "../../home-bank";
import { LinkButton, Shell } from "../../ui";
import { setCardModeAction } from "../actions";
import { cardName, modeText, paymentText } from "../card-text";

export const dynamic = "force-dynamic";

export default async function CardPage({ params }: { params: Promise<{ accountId: string }> }) {
  if (!bankRuntime()) notFound();
  const { accountId } = await params;
  const ctx = await requireHousehold();
  const { me, db, today } = ctx;
  let card;
  try {
    card = await cardAccount(db, me, accountId);
  } catch (e) {
    if (e instanceof UserError) notFound();
    throw e;
  }
  const shared = card.cardMode === "shared";

  return (
    <Shell {...ctx} title={cardName(card)} actions={!card.shareAll && <LinkButton href={`/accounts/${card.id}/review`}>Review transactions</LinkButton>}>
      <p className="note mt-0">
        <Link href="/accounts">All accounts</Link> · {card.institutionName} · {modeText(card)}
      </p>
      <BankRelink ctx={ctx} />

      <section aria-labelledby="mode" className="mt-6">
        <h2 id="mode">Shared or personal</h2>
        <p className="note">
          A shared card&rsquo;s payments are split with the group, and you take purchases out of a payment when you review it. On a personal card nothing is
          shared unless you pick it. Payments that come in from now on follow your choice. Earlier ones can be shared from this page once the card is shared.
        </p>
        <ActionForm action={setCardModeAction} done="Saved" resetOnError>
          <input type="hidden" name="accountId" value={card.id} />
          <div className="row">
            <label className="check">
              <input type="radio" name="mode" value="shared" defaultChecked={shared} /> Shared card
            </label>
            <label className="check">
              <input type="radio" name="mode" value="personal" defaultChecked={!shared} /> Personal card
            </label>
            <button>Save</button>
          </div>
        </ActionForm>
      </section>

      {card.shareAll ? (
        <section aria-labelledby="share-all" className="mt-6">
          <h2 id="share-all">This card shares every purchase</h2>
          <p className="note">
            Each purchase that comes in is added to the ledger as a shared expense by itself, so there is nothing to review. Turn that off to review this
            card&rsquo;s purchases by hand. Money coming in still waits below for you to set aside.
          </p>
          <ActionForm action={setBankShareAllAction} done="Back to sorting by hand">
            <input type="hidden" name="accountId" value={card.id} />
            <input type="hidden" name="on" value="0" />
            <button>Turn off sharing every purchase</button>
          </ActionForm>
          <div className="mt-4">
            <ToSortCard ctx={ctx} accountId={card.id} />
          </div>
        </section>
      ) : shared ? (
        <section aria-labelledby="payments" className="mt-6">
          <h2 id="payments">Payments</h2>
          <p className="note mt-0">
            <Link href={`/accounts/${card.id}/payments`}>Find earlier payments</Link> to share one that is not listed here.
          </p>
          {card.payments.length === 0 ? (
            <p className="note">No payment to this card is listed yet. Each new one appears here as it is paid.</p>
          ) : (
            <ul className="list-none divide-y divide-border/70 pl-0 space-y-0">
              {card.payments.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{paymentText(p, today)}</span>
                  {p.mode === "shared" && (
                    <LinkButton href={`/accounts/${card.id}/review?${new URLSearchParams({ payment: p.id })}`} variant="outline" size="sm">
                      Review transactions
                    </LinkButton>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section aria-labelledby="reviewed" className="mt-6">
          <h2 id="reviewed">Reviewed</h2>
          <p className="note">
            {card.reviewedThrough ? `Reviewed to ${card.reviewedThrough}.` : "Not reviewed yet."} Review reads the card&rsquo;s purchases from your bank and
            lets you pick the ones to add.
          </p>
        </section>
      )}
    </Shell>
  );
}
