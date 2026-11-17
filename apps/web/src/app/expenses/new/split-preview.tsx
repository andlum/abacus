"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, Info } from "lucide-react";
import { formatCents } from "@abacus/core/money";
import { previewExpense, type PreviewAnswer } from "../../actions";
import { resplitLine } from "./resplit";

type Person = { id: string; displayName: string };

// Why a split by income could not be worked out. Each is fixed on the
// incomes page.
const INCOME_REASONS: Record<string, string> = {
  income_missing: "someone has no income on record for this date",
  all_incomes_zero: "every income is zero",
  ratio_unavailable: "the income ratio could not be worked out",
};

// Shows who pays what as the surrounding form is filled in, using the same
// rules saving would use, and holds the form's `submit` button: it is off
// while the split needs incomes that are not there. On the edit page,
// `stored` is the expense's shares as saved, to say when saving moves them.
export function SplitPreview({
  people,
  submit,
  stored,
}: {
  people: Person[];
  submit: string;
  stored?: Record<string, number>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [answer, setAnswer] = useState<PreviewAnswer | null>(null);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest = 0;
    const run = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const ask = ++latest;
        const next = await previewExpense(new FormData(form));
        if (ask === latest) setAnswer(next);
      }, 250);
    };
    run();
    form.addEventListener("input", run);
    form.addEventListener("change", run);
    form.addEventListener("reset", run);
    // Coming back from adding incomes in another tab.
    window.addEventListener("focus", run);
    return () => {
      window.removeEventListener("focus", run);
      clearTimeout(timer);
      form.removeEventListener("input", run);
      form.removeEventListener("change", run);
      form.removeEventListener("reset", run);
    };
  }, []);

  const p = answer?.preview;
  const needsIncome = p && !p.ok ? INCOME_REASONS[p.reason] : undefined;
  const resplit = stored && p?.ok ? resplitLine(people, stored, p.shares) : null;
  return (
    <>
    <div ref={ref} aria-live="polite" aria-label="Split preview" role="region" className="my-4 max-w-xl rounded-xl border bg-muted/30 p-4 text-sm">
      <div className="mb-2 font-semibold">How it splits</div>
      {!answer ? (
        <p className="note">Working it out…</p>
      ) : !p ? (
        <p className="note">{answer.hint}</p>
      ) : needsIncome ? (
        <p className="flex gap-2 text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            This can't be split by income yet: {needsIncome}. Please{" "}
            <a href="/settings/people#income" target="_blank" rel="noopener" className="underline">
              add incomes
            </a>{" "}
            (opens in a new tab) in order to split by income.
          </span>
        </p>
      ) : !p.ok ? (
        <p className="flex gap-2 text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {p.why}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-8 gap-y-1">
            {people.map((m) => (
              <div key={m.id}>
                <span className="text-muted-foreground">{m.displayName}</span>{" "}
                <span className="text-base font-semibold tabular-nums">{formatCents(p.shares[m.id] ?? 0)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 font-medium">{p.effect}</p>
          {resplit && (
            <p className="mt-1 flex gap-2 text-warn">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              {resplit}
            </p>
          )}
          <p className="note mt-1">
            {p.rule}
            {p.ratio && ` (income ratio ${p.ratio})`}. {!p.isDefault && p.why}
          </p>
          {p.isDefault && (
            <p className="mt-2 flex gap-2 text-warn">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              No rule covers this yet, so it falls back to an even split.{" "}
              {answer.recurring ? "Choose a split for this cost above to change that." : "Add a rule in Settings to change that."}
            </p>
          )}
          {p.leftoverCents > 0 && (
            <p className="note mt-1">
              {p.leftoverCents === 1 ? "One cent doesn't" : `${p.leftoverCents} cents don't`} divide evenly; it goes to
              one of you at random when saved.
            </p>
          )}
        </>
      )}
    </div>
    <button className="primary" disabled={!!needsIncome}>
      {submit}
    </button>
    </>
  );
}
