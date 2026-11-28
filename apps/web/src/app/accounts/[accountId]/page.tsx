import Link from "next/link";
import { notFound } from "next/navigation";
import { UserError } from "@abacus/core/errors";
import { bankRuntime } from "@/lib/bank-link";
import { cardAccount } from "@/lib/card-review";
import { requireHousehold } from "@/lib/session";
import { ActionForm } from "../../action-form";
import { setAccountKindAction, setBankShareAllAction } from "../../actions";
import { BankRelink, ToSortCard } from "../../home-bank";
import { LinkButton, Shell } from "../../ui";
import { setCardModeAction } from "../actions";
import { cardName, modeText, paymentText } from "../card-text";

export const dynamic = "force-dynamic";

export default async function CardPage({ params }: { params: Promise<{ accountId: string }> }) {
  if (!bankRuntime()) notFound();
  const { accountId } = await params;
  const ctx = await requireHousehold();
  const { me, db, today, home } = ctx;
  const business = home.kind === "business";
  let card;
  try {
    card = await cardAccount(db, me, accountId);
  } catch (e) {
    if (e instanceof UserError) notFound();
    throw e;
  }
  const shared = !business && card.cardMode === "shared";
  // A business group's card is reviewed only once its owner says whose it is.
  const canReview = !card.shareAll && (!business || card.kind !== null);

  return (
    <Shell {...ctx} title={cardName(card)} actions={canReview && <LinkButton href={`/accounts/${card.id}/review`}>Review transactions</LinkButton>}>
      <p className="note mt-0">
        <Link href="/accounts">All accounts</Link> · {card.institutionName} · {modeText(card, business)}
      </p>
      <BankRelink ctx={ctx} />

      {business ? (
        <section aria-labelledby="kind" className="mt-6">
          <h2 id="kind">Whose card is this?</h2>
          <p className="note">
            A business card is the business&rsquo;s own: its purchases are the business&rsquo;s unless you untick them in a review. A personal card is your
            own: nothing on it is the business&rsquo;s unless you pick it, and what you pick is a cost the business owes you back.
            {card.kind === null && " Say which before you review this card."}
          </p>
          <ActionForm action={setAccountKindAction} done="Saved" resetOnError>
            <input type="hidden" name="accountId" value={card.id} />
            <div className="row">
              <label className="check">
                <input type="radio" name="kind" value="business" defaultChecked={card.kind === "business"} required /> Business card
              </label>
              <label className="check">
                <input type="radio" name="kind" value="personal" defaultChecked={card.kind === "personal"} required /> Personal card
              </label>
              <button>Save</button>
            </div>
          </ActionForm>
          <p className="note">This is fixed once anything is paid from the card. To change it after that, archive the account and add a new one.</p>
        </section>
      ) : (
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
      )}

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
          {business && (
            <p className="note">
              A payment to this card is not logged as a cost: its purchases are. A card payment logged before this changed was logged whole, in the category
              &ldquo;Card payment&rdquo;, and is still in the Ledger. Reviewing purchases from the same weeks logs that money again, so void the old payment if
              you do.
            </p>
          )}
        </section>
      )}
    </Shell>
  );
}
