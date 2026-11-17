import { notFound } from "next/navigation";
import { getBalance } from "@/lib/balance";
import { requireHousehold } from "@/lib/session";
import { recordPaymentAction } from "../../actions";
import { PaymentForm, payers } from "../../payment-form";
import { Money, Shell } from "../../ui";

export const metadata = { title: "Record a payment · Clementine" };
export const dynamic = "force-dynamic";

// Money one person gave another to settle up, recorded from anywhere in the
// app. It starts filled in with what is owed.
export default async function NewPaymentPage() {
  const ctx = await requireHousehold();
  const { me, db, members, today } = ctx;
  // A payment needs two people in the group today.
  if (payers(members, today).length < 2) notFound();
  const balance = await getBalance(db, me.householdId);
  const nameOf = new Map(members.map((m) => [m.id, m.displayName]));
  return (
    <Shell {...ctx} title="Record a payment">
      <p className="note">
        {balance.owes.length === 0
          ? "You are all square."
          : balance.owes.map((o, i) => (
              <span key={`${o.from}:${o.to}`}>
                {i > 0 && " · "}
                {nameOf.get(o.from)} owes {nameOf.get(o.to)} <Money cents={o.amountCents} />
              </span>
            ))}
      </p>
      <PaymentForm action={recordPaymentAction} me={me} members={members} balance={balance} today={today} className="panel" />
    </Shell>
  );
}
