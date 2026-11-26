import Link from "next/link";
import type { Balance } from "@/lib/balance";
import type { getOwedBack } from "@/lib/owed-back";
import type { requireHousehold } from "@/lib/session";
import { Money } from "./ui";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;
type OwedBack = NonNullable<Awaited<ReturnType<typeof getOwedBack>>>;

type HomeBalanceProps = {
  ctx: Ctx;
  balance: Balance;
  owedBack: OwedBack | null;
  // How many expenses are left out until someone sorts them out.
  notCounted: number;
};

// Below 640px the sentence is the headline of a card. From 640px it is a
// detail in 16px beside the page title.
const line =
  "m-0 text-title tabular-nums lining-nums max-sm:font-serif max-sm:text-4xl max-sm:leading-tight max-sm:font-black max-sm:tracking-tight max-sm:text-balance sm:text-base sm:leading-snug sm:font-semibold";

// Who owes whom, one line per debt. How it adds up is the Ledger's job. A
// payment is recorded on its own page, from the Record payment button in the
// header.
export function HomeBalance({ ctx, balance, owedBack, notCounted }: HomeBalanceProps) {
  const nameOf = new Map(ctx.members.map((m) => [m.id, m.displayName]));

  return (
    <div
      id="balance"
      aria-label="Balance"
      role="region"
      className="flex scroll-mt-20 flex-col gap-1 max-sm:rounded-xl max-sm:border-2 max-sm:border-edge max-sm:bg-card max-sm:p-5 max-sm:shadow-soft sm:items-end sm:text-right"
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
        <span className="text-sm text-muted-foreground">Balance</span>
        <div className="flex flex-col">
          {balance.owes.length === 0 ? (
            <p data-balance-line className={line}>
              You are all square.
            </p>
          ) : (
            balance.owes.map((o) => (
              <p data-balance-line className={line} key={`${o.from}:${o.to}`}>
                {nameOf.get(o.from)} owes {nameOf.get(o.to)} <Money cents={o.amountCents} />
              </p>
            ))
          )}
        </div>
      </div>
      {notCounted > 0 && (
        <p className="note m-0">
          Not counted yet: {notCounted === 1 ? "1 expense" : `${notCounted} expenses`} waiting in To do.
        </p>
      )}
      {owedBack?.members.some((m) => m.personalPaidCents > 0) && (
        <p className="note m-0 sm:max-w-sm">
          Costs paid from a personal account are not counted here; the business owes them back.{" "}
          <Link href="/paid-personally">See what is owed</Link>
        </p>
      )}
    </div>
  );
}
