import Link from "next/link";
import { notFound } from "next/navigation";
import { shortDate } from "@abacus/core/dates";
import { bankRuntime } from "@/lib/bank-link";
import { listCardAccounts } from "@/lib/card-review";
import { requireHousehold } from "@/lib/session";
import { LinkButton, Shell } from "../ui";
import { cardName, modeText, paymentText } from "./card-text";

export const dynamic = "force-dynamic";

// The cards the person connected. Nothing here asks Plaid for anything.
export default async function AccountsPage() {
  if (!bankRuntime()) notFound();
  const ctx = await requireHousehold();
  const { me, db, today } = ctx;
  const cards = await listCardAccounts(db, me);

  return (
    <Shell {...ctx} title="Accounts">
      {cards.length === 0 ? (
        <p className="note">
          No card is connected yet. Connect one in <Link href="/settings/accounts">Settings → Bank</Link>.
        </p>
      ) : (
        <>
          <p className="note">Your connected cards. Choose which purchases to split with the group from each.</p>
          <ul className="my-4 grid list-none gap-4 pl-0">
            {cards.map((c) => (
              <li key={c.id} className="grid gap-2 rounded-xl border border-border/70 bg-card p-4 shadow-soft">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/accounts/${c.id}`} className="font-medium [overflow-wrap:anywhere]">
                    {cardName(c)}
                  </Link>
                  {c.needsRelink && <span className="tag warn">needs signing in again</span>}
                </div>
                <p className="note my-0">
                  {c.institutionName} · {modeText(c)}
                  {c.cardMode === "shared"
                    ? ` · ${c.latestPayment ? `Last payment ${paymentText(c.latestPayment, today)}` : "No payment yet"}`
                    : ` · ${c.reviewedThrough ? `Reviewed to ${shortDate(c.reviewedThrough, today)}` : "Not reviewed yet"}`}
                </p>
                {c.shareAll && <p className="note my-0">Every purchase on this card is shared as it comes in.</p>}
                {!c.shareAll && (
                  <div>
                    <LinkButton href={`/accounts/${c.id}/review`} variant="outline" size="sm">
                      Review transactions
                    </LinkButton>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Shell>
  );
}
