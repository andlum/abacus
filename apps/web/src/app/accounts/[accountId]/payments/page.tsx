import Link from "next/link";
import { notFound } from "next/navigation";
import { UserError } from "@abacus/core/errors";
import { formatCents } from "@abacus/core/money";
import { shortDate } from "@abacus/core/dates";
import { bankRuntime } from "@/lib/bank-link";
import { cardAccount, findPastPayments, PAST_PAYMENT_DAYS } from "@/lib/card-review";
import { requireHousehold } from "@/lib/session";
import { ActionForm } from "../../../action-form";
import { BankRelink } from "../../../home-bank";
import { LinkButton, Shell } from "../../../ui";
import { sharePastPaymentAction } from "../../actions";
import { cardName } from "../../card-text";

export const dynamic = "force-dynamic";

// Payments to a shared card that were never shared: read from the bank now,
// only because its owner asked.
export default async function EarlierPaymentsPage({ params }: { params: Promise<{ accountId: string }> }) {
  const bank = bankRuntime();
  if (!bank) notFound();
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

  let found;
  try {
    found = await findPastPayments(db, bank, me, accountId, new Date());
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    return (
      <Shell {...ctx} title="Earlier payments">
        <BankRelink ctx={ctx} />
        <p role="alert" className="text-destructive">
          {e.message[0]!.toUpperCase() + e.message.slice(1)}.
        </p>
        <p>
          <LinkButton href={`/accounts/${accountId}`} variant="outline" size="sm">
            Back to the card
          </LinkButton>
        </p>
      </Shell>
    );
  }

  return (
    <Shell {...ctx} title={`Earlier payments, ${cardName(card)}`}>
      <p className="note mt-0">
        <Link href={`/accounts/${card.id}`}>Back to the card</Link>
      </p>
      <BankRelink ctx={ctx} />
      <p className="note">
        Payments to this card from the last {PAST_PAYMENT_DAYS} days that are not shared yet. Sharing one makes it a shared expense you paid, split the
        usual way, then opens its review so you can take purchases out of it.
      </p>
      {found.length === 0 ? (
        <p className="note">No unshared payment in the last {PAST_PAYMENT_DAYS} days.</p>
      ) : (
        <ul className="list-none divide-y divide-border/70 pl-0 space-y-0">
          {found.map((p) => (
            <li key={p.plaidTransactionId} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {shortDate(p.date, today)}, {formatCents(p.amountCents)}
                {p.paymentId ? ", made while the card was personal" : ""}
              </span>
              <ActionForm action={sharePastPaymentAction}>
                <input type="hidden" name="accountId" value={card.id} />
                <input type="hidden" name="plaidTransactionId" value={p.plaidTransactionId} />
                <button>Share and review</button>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
