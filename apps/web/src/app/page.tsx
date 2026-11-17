import { CircleCheck, CircleDashed, Wallet } from "lucide-react";
import { listAttention } from "@/lib/attention";
import { getBalance } from "@/lib/balance";
import { gettingStarted } from "@/lib/getting-started";
import { postDue } from "@/lib/expenses";
import { getOwedBack } from "@/lib/owed-back";
import { requireHousehold } from "@/lib/session";
import { BalanceCard } from "./home-balance";
import { BankToSort } from "./home-bank";
import { ToDo } from "./home-todo";
import { LedgerView, type LedgerParams } from "./ledger-view";
import { SidePanel } from "./side-panel";
import { LinkButton, Shell } from "./ui";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<LedgerParams> }) {
  const ctx = await requireHousehold();
  const raw = await searchParams;
  const { me, db, members, today } = ctx;
  // Recurring costs that have reached their due date become expenses here.
  await postDue(db, me.householdId, today);

  const balance = await getBalance(db, me.householdId);
  // Null in a household: only a business owes its members for costs they
  // paid on a personal account.
  const owedBack = await getOwedBack(db, me.householdId);
  const attention = await listAttention(db, me.householdId, today);
  const start = await gettingStarted(db, me);
  // A group of one has nobody to wait for and no split to choose.
  const solo = members.length === 1;
  const steps = [
    {
      solo: false,
      done: start.partnerJoined,
      text: start.partnerJoined ? `${start.partner} has joined` : `${start.partner} has not joined yet`,
      hint: "They sign in with the email address the household was set up with, then accept the invitation.",
      href: null,
      action: null,
    },
    {
      solo: true,
      done: start.hasRecurring,
      text: "Add the costs that repeat",
      hint: "Rent, bills and subscriptions. Each is entered by itself on its due date.",
      href: "/expenses/new?kind=recurring",
      action: "Add a recurring cost",
    },
    {
      solo: false,
      done: start.hasRule,
      text: "Choose how to split",
      hint: "Until you add a rule, everything is split evenly. To split by income, record everyone\u2019s income in Settings first. Rules and incomes count as soon as they are saved.",
      href: "/settings#split",
      action: "Add a rule",
    },
  ].filter((s) => s.solo || !solo);

  const doneCount = steps.filter((s) => s.done).length;

  // Setup and what the business owes back are not part of every visit, so
  // they open beside the title instead of sitting in the page.
  const actions = (owedBack || !start.done) && (
    <>
      {owedBack && (
        <LinkButton href="/paid-personally" variant="outline" size="sm">
          <Wallet data-icon="inline-start" />
          Paid personally
        </LinkButton>
      )}
      {!start.done && (
        <SidePanel
          trigger={`Getting started \u00b7 ${doneCount} of ${steps.length}`}
          title="Getting started"
          description={`${doneCount} of ${steps.length} done. This goes away once they all are.`}
        >
          <ol className="list-none space-y-4 pl-0">
            {steps.map((s) => (
              <li key={s.text} className="flex flex-col gap-2">
                <span className="flex items-start gap-3">
                  {s.done ? (
                    <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="Done" />
                  ) : (
                    <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Not done" />
                  )}
                  <span className="grow">
                    <span className={s.done ? "text-muted-foreground line-through" : "font-medium"}>{s.text}</span>
                    {!s.done && <span className="block text-muted-foreground">{s.hint}</span>}
                  </span>
                </span>
                {!s.done && s.href && (
                  <LinkButton href={s.href} variant="outline" size="sm" className="ml-7 self-start">
                    {s.action}
                  </LinkButton>
                )}
              </li>
            ))}
          </ol>
        </SidePanel>
      )}
    </>
  );

  return (
    <Shell {...ctx} title="Home" actions={actions}>
      {/* The balance and, when there is anything to do, the to-do list beside it. */}
      <div className={attention.count > 0 ? "grid items-start gap-4 sm:grid-cols-2" : "grid gap-4"}>
        <BalanceCard ctx={ctx} balance={balance} owedBack={owedBack} notCounted={attention.count} />
        {attention.count > 0 && <ToDo ctx={ctx} attention={attention} />}
      </div>
      <div className="mt-4 flex flex-col gap-4 empty:hidden">
        <BankToSort ctx={ctx} />
      </div>

      <LedgerView ctx={ctx} raw={raw} />
    </Shell>
  );
}
