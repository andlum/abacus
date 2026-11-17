import type { Member } from "@/db/schema";
import type { Balance } from "@/lib/balance";
import type { ActionState } from "@/lib/action";
import { countsOn } from "@/lib/members";
import { centsToDecimal } from "@abacus/core/money";
import { ActionForm } from "./action-form";

// The people who can be part of a payment: those in the group today.
export const payers = (members: Member[], today: string) => members.filter((m) => countsOn(m, today));

// A payment from one person to another. It starts from a debt the person
// looking is part of, if any, so settling up is one press.
export function PaymentForm({
  action,
  me,
  members,
  balance,
  today,
  className = "row",
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  me: Member;
  members: Member[];
  balance: Balance;
  today: string;
  className?: string;
}) {
  const counted = payers(members, today);
  const owed = balance.owes.find((o) => o.from === me.id || o.to === me.id) ?? balance.owes[0];
  const other = counted.find((m) => m.id !== me.id);
  const from = owed?.from ?? me.id;
  const to = owed?.to ?? other?.id ?? me.id;
  return (
    <ActionForm action={action} done="Payment recorded" className={className}>
      <label>
        From
        <select name="fromMemberId" defaultValue={from}>
          {counted.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        To
        <select name="toMemberId" defaultValue={to}>
          {counted.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Amount
        <input name="amount" inputMode="decimal" size={8} defaultValue={owed ? centsToDecimal(owed.amountCents) : ""} required />
      </label>
      <label>
        Date
        <input type="date" name="date" defaultValue={today} max={today} required />
      </label>
      <label>
        Note
        <input name="note" />
      </label>
      <button className="primary">Record payment</button>
    </ActionForm>
  );
}
