import Link from "next/link";
import { shortDate } from "@abacus/core/dates";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Balance } from "@/lib/balance";
import type { getOwedBack } from "@/lib/owed-back";
import type { requireHousehold } from "@/lib/session";
import { Money } from "./ui";

type Ctx = Awaited<ReturnType<typeof requireHousehold>>;
type OwedBack = NonNullable<Awaited<ReturnType<typeof getOwedBack>>>;

type BalanceCardProps = {
  ctx: Ctx;
  balance: Balance;
  owedBack: OwedBack | null;
  // How many expenses are left out until someone sorts them out.
  notCounted: number;
};

// Who owes whom and, folded away, how the number adds up, with a way to the
// payments in the Ledger. A payment is recorded on its own page, from the
// Record payment button in the header.
export function BalanceCard({ ctx, balance, owedBack, notCounted }: BalanceCardProps) {
  const { members, today } = ctx;
  const nameOf = new Map(members.map((m) => [m.id, m.displayName]));

  return (
    <Card id="balance" aria-label="Balance" role="region" className="scroll-mt-20">
      <CardHeader>
        <CardDescription>Balance</CardDescription>
        {balance.owes.length === 0 ? (
          <CardTitle className="headline font-serif text-4xl leading-tight">You are all square.</CardTitle>
        ) : (
          balance.owes.map((o) => (
            <CardTitle className="headline font-serif text-4xl leading-tight" key={`${o.from}:${o.to}`}>
              {nameOf.get(o.from)} owes {nameOf.get(o.to)} <Money cents={o.amountCents} />
            </CardTitle>
          ))
        )}
        {notCounted > 0 && (
          <p className="note">
            Not counted yet: {notCounted === 1 ? "1 expense" : `${notCounted} expenses`} waiting in To do.
          </p>
        )}
        {owedBack?.members.some((m) => m.personalPaidCents > 0) && (
          <p className="note">
            Costs paid from a personal account are not counted here; the business owes them back.{" "}
            <Link href="/paid-personally">See what is owed</Link>
          </p>
        )}
      </CardHeader>
      <CardContent>
        <details>
          <summary>How the balance adds up</summary>
          {balance.entries.length === 0 ? (
            <p>Nothing yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>What</th>
                  {members.map((m) => (
                    <th className="num" key={m.id}>
                      {m.displayName}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {balance.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap">{shortDate(entry.date, today)}</td>
                    <td>
                      {entry.kind === "settlement" ? `Payment${entry.description ? `: ${entry.description}` : ""}` : entry.description}
                    </td>
                    {members.map((m) => (
                      <td className="num" key={m.id}>
                        <Money cents={entry.effect[m.id] ?? 0} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={2}>Position (plus: is owed; minus: owes)</th>
                  {members.map((m) => (
                    <th className="num" key={m.id}>
                      <Money cents={balance.net[m.id] ?? 0} />
                    </th>
                  ))}
                </tr>
              </tfoot>
            </table>
          )}

          <p>
            <Link href="#ledger">See payments in the Ledger</Link>
          </p>
        </details>
      </CardContent>
    </Card>
  );
}
