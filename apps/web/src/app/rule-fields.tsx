"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Member } from "@/db/schema";
import { centsToDecimal } from "@abacus/core/money";
import type { Rule } from "@abacus/core/split";

type Kind = "none" | "even" | "percent" | "income_proportional" | "fixed_plus_remainder";
type Remainder = "even" | "percent" | "income_proportional";

// The fields `readRule` reads. Percentages and fixed amounts appear only for
// the splits that use them. `none` is the label for "no rule picked"; leave
// it out where a rule is required, and the split starts as even. `initial`
// fills the fields with a rule as it is, to change it. `byIncome` false (a
// business, which keeps no incomes) leaves out the split by income, unless
// the rule being changed already uses it.
export function RuleFields({
  members,
  prefix = "",
  none,
  initial,
  byIncome = true,
}: {
  members: Pick<Member, "id" | "displayName">[];
  prefix?: string;
  none?: string;
  initial?: Rule;
  byIncome?: boolean;
}) {
  const startKind: Kind = initial?.kind ?? (none ? "none" : "even");
  const startRemainder: Remainder = initial?.kind === "fixed_plus_remainder" ? initial.remainder.kind : "even";
  const [kind, setKind] = useState<Kind>(startKind);
  const [remainder, setRemainder] = useState<Remainder>(startRemainder);
  // A saved form is reset by the browser, which puts the boxes back to their
  // first option without telling React. Follow it, so the fields on screen
  // match what the boxes say.
  const kindBox = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const form = kindBox.current?.form;
    if (!form) return;
    const onReset = () => {
      setKind(startKind);
      setRemainder(startRemainder);
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [startKind, startRemainder]);
  const fixedCents = initial?.kind === "fixed_plus_remainder" ? initial.fixedCents : {};
  const base = initial?.kind === "fixed_plus_remainder" ? initial.remainder : initial;
  const bp = base?.kind === "percent" ? base.bp : {};
  const fixed = kind === "fixed_plus_remainder";
  const income = byIncome || startKind === "income_proportional" || startRemainder === "income_proportional";
  const percent = kind === "percent" || (fixed && remainder === "percent");
  return (
    <>
      <label>
        How to split
        <select ref={kindBox} name={`${prefix}kind`} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {none && <option value="none">{none}</option>}
          <option value="even">Evenly</option>
          <option value="percent">By fixed percentages</option>
          {income && <option value="income_proportional">By income</option>}
          <option value="fixed_plus_remainder">A fixed amount first, then the rest</option>
        </select>
      </label>
      {fixed && (
        <div className="row">
          {members.map((m) => (
            <label key={m.id}>
              {m.displayName} pays first
              <input name={`${prefix}fixed_${m.id}`} inputMode="decimal" size={8} defaultValue={fixedCents[m.id] ? centsToDecimal(fixedCents[m.id]!) : undefined} />
            </label>
          ))}
          <label>
            then the rest
            <select name={`${prefix}remainder`} value={remainder} onChange={(e) => setRemainder(e.target.value as Remainder)}>
              <option value="even">evenly</option>
              <option value="percent">by fixed percentages</option>
              {income && <option value="income_proportional">by income</option>}
            </select>
          </label>
        </div>
      )}
      {percent && (
        <div className="row">
          {members.map((m) => (
            <label key={m.id}>
              {m.displayName} %
              <input name={`${prefix}pct_${m.id}`} inputMode="decimal" size={6} defaultValue={bp[m.id] !== undefined ? percentText(bp[m.id]!) : undefined} />
            </label>
          ))}
          <span className="note">Must add up to 100.</span>
        </div>
      )}
    </>
  );
}

// 6000 -> "60", 3333 -> "33.33": as `readRule` reads it back.
const percentText = (bp: number) => centsToDecimal(bp).replace(/\.?0+$/, "");

// A split that is only asked for when the section is opened. Closed, it
// sends no fields, so `readRule` answers null and the saved rules apply.
// Opened, it starts as an even split.
export function OptionalRule({
  summary,
  children,
  members,
  prefix,
  byIncome,
}: {
  summary: string;
  children?: ReactNode;
  members: Pick<Member, "id" | "displayName">[];
  prefix: string;
  byIncome?: boolean;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const first = useRef(true);

  // The fields came or went without the form hearing of it; tell the split
  // preview to look again.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    ref.current?.dispatchEvent(new Event("change", { bubbles: true }));
  }, [open]);

  return (
    <details ref={ref} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {children}
      {open && <RuleFields members={members} prefix={prefix} byIncome={byIncome} />}
    </details>
  );
}
