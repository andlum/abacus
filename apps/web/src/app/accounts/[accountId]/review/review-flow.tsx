"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { addDays, shortDate } from "@abacus/core/dates";
import { formatCents } from "@abacus/core/money";
import type { Rule } from "@abacus/core/split";
import type { Review, ReviewLine } from "@/lib/card-review";
import type { SplitPreview } from "@/lib/split-preview";
import { previewReviewAction, submitReviewAction } from "../../actions";
import { paymentText } from "../../card-text";

type Person = { id: string; displayName: string };
type Category = { slug: string; label: string };
type Choice = "usual" | "even" | "percent" | "mine" | "theirs";
type Edit = {
  description: string;
  category: string;
  choice: Choice;
  pct: Record<string, string>;
  // A business group's label step.
  vendor: string;
  note: string;
  usePct: string;
  useBasis: string;
};

const CHOICE_TEXT: Record<Choice, string> = {
  usual: "Our usual split",
  even: "Evenly",
  percent: "Custom percentages",
  mine: "All mine",
  theirs: "All theirs",
};

// "60" or "33.33" as basis points; null when it is not a percentage.
function parseBp(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const bp = Math.round(Number(t) * 100);
  return bp <= 10000 ? bp : null;
}

const selectable = (l: ReviewLine) => !l.moneyIn && !l.addedExpenseId;

export function ReviewFlow({
  review,
  fromParam,
  meId,
  members,
  categories,
  defaultCategory,
  today,
}: {
  review: Review;
  fromParam?: string;
  meId: string;
  members: Person[];
  categories: Category[];
  defaultCategory: string;
  today: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"pick" | "split" | "submit">("pick");
  // A business group's review is pick, label, log; a household's is pick, split, submit.
  const biz = review.groupKind === "business";
  const bizCard = biz && review.account.kind === "business";
  const splits = review.splits;
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(review.lines.filter((l) => selectable(l) && (biz ? l.picked : l.ticked)).map((l) => l.plaidTransactionId)),
  );
  const [edits, setEdits] = useState<Record<string, Edit>>(() =>
    Object.fromEntries(
      review.lines.map((l) => [
        l.plaidTransactionId,
        {
          description: l.description,
          category: biz && categories.some((c) => c.slug === l.category) ? l.category : defaultCategory,
          choice: "usual" as Choice,
          pct: {},
          vendor: l.description,
          note: "",
          usePct: "100",
          useBasis: "",
        },
      ]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [sending, startSending] = useTransition();

  const shared = review.account.cardMode === "shared";
  const other = members.length === 2 ? members.find((m) => m.id !== meId) : undefined;
  const choices: Choice[] = other ? ["usual", "even", "percent", "theirs", "mine"] : ["usual", "even", "percent"];

  const pickedLines = review.lines.filter((l) => picked.has(l.plaidTransactionId));
  const tied = pickedLines.filter((l) => l.suggestion);
  const own = pickedLines.filter((l) => !l.suggestion);
  const total = pickedLines.reduce((a, l) => a + l.amountCents, 0);
  const stillShared = review.payment?.stillSharedCents ?? 0;
  const canPick = review.lines.filter(selectable).length;
  const pickedText = bizCard
    ? `${pickedLines.length} of ${canPick} are business · ${formatCents(total)}`
    : `${pickedLines.length} picked · ${formatCents(total)}${shared ? ` of ${formatCents(stillShared)}` : ""}`;
  const labelOf = (slug: string) => categories.find((c) => c.slug === slug)?.label ?? slug;

  // How much of a row was for the business, or why it cannot be saved yet.
  function useOf(e: Edit): { bp?: number; problem?: string } {
    const bp = parseBp(e.usePct);
    if (bp === null || bp < 1) return { problem: "Business use must be above 0 and up to 100." };
    if (bp < 10000 && !e.useBasis.trim()) return { problem: "Say in one line why it is less than 100% business." };
    return { bp };
  }

  const change = (id: string, patch: Partial<Edit>) => setEdits((e) => ({ ...e, [id]: { ...e[id]!, ...patch } }));

  // The rule a row's choice stands for, or why it is not one yet.
  function ruleOf(e: Edit): { rule?: Rule; problem?: string } {
    if (!splits || e.choice === "usual") return {};
    if (e.choice === "even") return { rule: { kind: "even" } };
    if (e.choice === "mine") return { rule: { kind: "percent", bp: { [meId]: 10000 } } };
    if (e.choice === "theirs") return other ? { rule: { kind: "percent", bp: { [other.id]: 10000 } } } : { problem: "Choose who pays." };
    const bp: Record<string, number> = {};
    for (const m of members) {
      const v = parseBp(e.pct[m.id] || "0");
      if (v === null) return { problem: `${m.displayName}'s percentage must be between 0 and 100.` };
      if (v > 0) bp[m.id] = v;
    }
    if (Object.values(bp).reduce((a, b) => a + b, 0) !== 10000) return { problem: "The percentages must add up to 100." };
    return { rule: { kind: "percent", bp } };
  }

  function toSplit() {
    setError(null);
    setStep("split");
  }

  function toSubmit() {
    const bad = own
      .map((l) => {
        const e = edits[l.plaidTransactionId]!;
        return { l, p: ruleOf(e).problem ?? (biz ? useOf(e).problem : undefined) };
      })
      .find((x) => x.p);
    if (bad) {
      setError(`${bad.l.description}: ${bad.p}`);
      return;
    }
    if (own.some((l) => !edits[l.plaidTransactionId]!.description.trim())) {
      setError("Every purchase needs a description.");
      return;
    }
    setError(null);
    setStep("submit");
  }

  function submit() {
    setError(null);
    startSending(async () => {
      const result = await submitReviewAction({
        accountId: review.account.id,
        payment: review.payment?.id,
        from: fromParam,
        items: pickedLines.map((l) => {
          if (l.suggestion) return { plaidTransactionId: l.plaidTransactionId, tieTo: l.suggestion.expenseId };
          const e = edits[l.plaidTransactionId]!;
          const item = { plaidTransactionId: l.plaidTransactionId, description: e.description.trim(), category: e.category, rule: ruleOf(e).rule };
          if (!biz) return item;
          const bp = useOf(e).bp ?? 10000;
          return { ...item, vendor: e.vendor.trim() || null, note: e.note.trim() || null, businessUseBp: bp, useBasis: bp < 10000 ? e.useBasis.trim() : null };
        }),
      });
      // A success sends the browser to the Ledger; only a refusal answers here.
      if (result.error) setError(result.error);
    });
  }

  const payments = review.payments.filter((p) => p.mode === "shared");

  return (
    <div>
      <ol className="my-4 flex list-none flex-wrap gap-2 pl-0 text-sm" aria-label="Steps">
        {(["pick", "split", "submit"] as const).map((s, i) => (
          <li key={s} aria-current={step === s ? "step" : undefined} className={step === s ? "tag ok" : "tag"}>
            {i + 1}. {s === "pick" ? "Pick" : s === "split" ? (biz ? "Label" : "Split") : biz ? "Log" : "Submit"}
          </li>
        ))}
      </ol>

      {step === "pick" && (
        <section aria-labelledby="pick">
          <h2 id="pick">{bizCard ? "Untick what was personal" : biz ? "Pick the business purchases" : "Pick purchases to split"}</h2>
          <p className="note">
            {shortDate(review.from, today)} to {shortDate(review.to, today)}. Nothing is saved until the last step.
          </p>
          <div className="row">
            {shared && payments.length > 1 && (
              <label>
                Payment
                <select
                  value={review.payment?.id ?? ""}
                  onChange={(e) => router.push(`/accounts/${review.account.id}/review?${new URLSearchParams({ payment: e.target.value })}`)}
                >
                  {payments.map((p) => (
                    <option key={p.id} value={p.id}>
                      {paymentText(p, today)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Link
              href={`/accounts/${review.account.id}/review?${new URLSearchParams({
                ...(review.payment ? { payment: review.payment.id } : {}),
                from: addDays(review.from, -30),
              })}`}
              className="note"
            >
              Go back 30 more days
            </Link>
          </div>
          {review.lines.length === 0 && <p className="note">No purchases in these dates.</p>}
          <ul className="list-none divide-y divide-border/70 pl-0 space-y-0">
            {review.lines.map((l) => (
              <li key={l.plaidTransactionId} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <label className="check min-w-0 [overflow-wrap:anywhere]">
                    <input
                      type="checkbox"
                      disabled={!selectable(l)}
                      checked={picked.has(l.plaidTransactionId)}
                      onChange={(e) =>
                        setPicked((p) => {
                          const next = new Set(p);
                          if (e.target.checked) next.add(l.plaidTransactionId);
                          else next.delete(l.plaidTransactionId);
                          return next;
                        })
                      }
                    />{" "}
                    <strong>{l.description}</strong>, {shortDate(l.date, today)}
                  </label>
                  <span className="num">
                    {l.moneyIn ? "In " : ""}
                    {formatCents(Math.abs(l.amountCents))}
                  </span>
                </div>
                {l.moneyIn && (
                  <p className="note my-1">
                    {l.cardPayment && biz
                      ? "A payment to the card. It is not logged as a cost: the purchases are."
                      : l.cardPayment && review.account.cardMode === "personal"
                      ? "A payment to the card. Make the card shared to share it."
                      : "Money coming in cannot be picked."}
                  </p>
                )}
                {l.addedExpenseId && (
                  <p className="note my-1">
                    <span className="tag ok">Added</span> <Link href={`/expenses/${l.addedExpenseId}`}>See the expense</Link>
                  </p>
                )}
                {l.suggestion && !l.addedExpenseId && <p className="note my-1">Already in the ledger as {l.suggestion.name}</p>}
              </li>
            ))}
          </ul>
          <p aria-live="polite" className="mt-4 font-medium">
            {pickedText}
          </p>
          <div className="row">
            <button className="primary" disabled={pickedLines.length === 0} onClick={toSplit}>
              {biz ? "Next: label" : "Next: split"}
            </button>
            {pickedLines.length === 0 && <span className="note">Leaving with none picked changes nothing.</span>}
          </div>
        </section>
      )}

      {step === "split" && (
        <section aria-labelledby="split">
          <h2 id="split">{biz ? "Label each one" : "Choose how each one splits"}</h2>
          {biz && (
            <label className="max-w-xs">
              Set all to
              <select
                value=""
                onChange={(e) => {
                  const category = e.target.value;
                  if (!category) return;
                  setEdits((all) => Object.fromEntries(Object.entries(all).map(([id, v]) => [id, { ...v, category }])));
                }}
              >
                <option value="">Choose a category…</option>
                {categories.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {splits && (
          <label className="max-w-xs">
            {biz ? "Set every split to" : "Set all to"}
            <select
              value=""
              onChange={(e) => {
                const choice = e.target.value as Choice;
                if (!choice) return;
                setEdits((all) => Object.fromEntries(Object.entries(all).map(([id, v]) => [id, { ...v, choice }])));
              }}
            >
              <option value="">Choose…</option>
              {choices
                .filter((c) => c !== "percent")
                .map((c) => (
                  <option key={c} value={c}>
                    {CHOICE_TEXT[c]}
                  </option>
                ))}
            </select>
          </label>
          )}
          <ul className="list-none divide-y divide-border/70 pl-0 space-y-0">
            {own.map((l) => {
              const e = edits[l.plaidTransactionId]!;
              const { rule, problem } = ruleOf(e);
              const use = biz ? useOf(e) : {};
              return (
                <li key={l.plaidTransactionId} className="py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span>{shortDate(l.date, today)}</span>
                    <strong className="num">{formatCents(l.amountCents)}</strong>
                  </div>
                  <div className="row">
                    <label>
                      Description
                      <input value={e.description} maxLength={200} onChange={(ev) => change(l.plaidTransactionId, { description: ev.target.value })} />
                    </label>
                    <label>
                      Category
                      <select value={e.category} onChange={(ev) => change(l.plaidTransactionId, { category: ev.target.value })}>
                        {categories.map((c) => (
                          <option key={c.slug} value={c.slug}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {splits && (
                      <label>
                        Split
                        <select value={e.choice} onChange={(ev) => change(l.plaidTransactionId, { choice: ev.target.value as Choice })}>
                          {choices.map((c) => (
                            <option key={c} value={c}>
                              {CHOICE_TEXT[c]}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  {biz && (
                    <div className="row">
                      <label>
                        Vendor
                        <input value={e.vendor} maxLength={500} onChange={(ev) => change(l.plaidTransactionId, { vendor: ev.target.value })} />
                      </label>
                      <label>
                        Note
                        <input
                          value={e.note}
                          maxLength={500}
                          placeholder="What it was for"
                          onChange={(ev) => change(l.plaidTransactionId, { note: ev.target.value })}
                        />
                      </label>
                      <label>
                        Business use %
                        <input inputMode="decimal" size={6} value={e.usePct} onChange={(ev) => change(l.plaidTransactionId, { usePct: ev.target.value })} />
                      </label>
                      {use.bp !== 10000 && (
                        <label>
                          Why less than 100%
                          <input
                            value={e.useBasis}
                            maxLength={500}
                            placeholder="Half the calls are clients"
                            onChange={(ev) => change(l.plaidTransactionId, { useBasis: ev.target.value })}
                          />
                        </label>
                      )}
                    </div>
                  )}
                  {biz && use.problem && <p className="note my-1 text-destructive">{use.problem}</p>}
                  {splits && e.choice === "percent" && (
                    <div className="row">
                      {members.map((m) => (
                        <label key={m.id}>
                          {m.displayName} %
                          <input
                            inputMode="decimal"
                            size={6}
                            value={e.pct[m.id] ?? ""}
                            onChange={(ev) => change(l.plaidTransactionId, { pct: { ...e.pct, [m.id]: ev.target.value } })}
                          />
                        </label>
                      ))}
                      <span className="note">Must add up to 100.</span>
                    </div>
                  )}
                  {problem ? (
                    <p className="note my-1 text-destructive">{problem}</p>
                  ) : (
                    splits && <RowPreview line={l} category={e.category} rule={rule} members={members} />
                  )}
                </li>
              );
            })}
            {tied.map((l) => (
              <li key={l.plaidTransactionId} className="py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    {l.description}, {shortDate(l.date, today)}
                  </span>
                  <strong className="num">{formatCents(l.amountCents)}</strong>
                </div>
                <p className="note my-1">Already in the ledger as {l.suggestion!.name}.{" "}
                  {l.suggestion!.kind === "added"
                    ? biz
                      ? "It is not added again."
                      : "It is taken out of the payment, not added again."
                    : "It fills that cost in; nothing new is added."}
                </p>
              </li>
            ))}
          </ul>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="row">
            <button onClick={() => setStep("pick")}>Back</button>
            <button className="primary" onClick={toSubmit}>
              Next: check
            </button>
          </div>
        </section>
      )}

      {step === "submit" && (
        <section aria-labelledby="submit">
          <h2 id="submit">{biz ? "Check and log" : "Check and submit"}</h2>
          <ul className="list-none divide-y divide-border/70 pl-0 space-y-0">
            {pickedLines.map((l) => {
              const e = edits[l.plaidTransactionId]!;
              const bp = useOf(e).bp ?? 10000;
              const said = [
                e.description.trim(),
                ...(biz ? [labelOf(e.category)] : []),
                ...(biz && bp < 10000 ? [`${bp / 100}% business`] : []),
                ...(splits ? [CHOICE_TEXT[e.choice].toLowerCase()] : []),
              ].join(", ");
              return (
                <li key={l.plaidTransactionId} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {l.suggestion ? `${l.description}, tied to ${l.suggestion.name}` : said}
                  </span>
                  <span className="num">{formatCents(l.amountCents)}</span>
                </li>
              );
            })}
          </ul>
          {shared ? (
            <p className="note">The card payment becomes {formatCents(stillShared - total)}.</p>
          ) : (
            <p className="note">This card is marked reviewed up to {shortDate(review.to, today)}. Purchases you leave out do not come back unless you go further back.</p>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="row">
            <button onClick={() => setStep("split")} disabled={sending}>
              Back
            </button>
            <button className="primary" onClick={submit} disabled={sending}>
              {biz
                ? `Log ${pickedLines.length} · ${formatCents(total)}`
                : shared
                  ? `Split ${pickedLines.length} separately · ${formatCents(total)}`
                  : `Add ${pickedLines.length} to the ledger · ${formatCents(total)}`}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

// Each person's share of one purchase, as the app would split it if saved.
function RowPreview({ line, category, rule, members }: { line: ReviewLine; category: string; rule?: Rule; members: Person[] }) {
  const [answer, setAnswer] = useState<SplitPreview | null>(null);
  const key = useMemo(() => JSON.stringify([line.amountCents, line.date, category, rule ?? null]), [line.amountCents, line.date, category, rule]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      const next = await previewReviewAction({ totalCents: line.amountCents, category, date: line.date, rule });
      if (live) setAnswer(next);
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key]);
  if (!answer) return <p className="note my-1">Working it out…</p>;
  if (!answer.ok) return <p className="note my-1 text-destructive">{answer.why}</p>;
  return (
    <p className="my-1 flex flex-wrap gap-x-6 text-sm" aria-live="polite">
      {members.map((m) => (
        <span key={m.id}>
          <span className="text-muted-foreground">{m.displayName}</span> <span className="tabular-nums font-semibold">{formatCents(answer.shares[m.id] ?? 0)}</span>
        </span>
      ))}
    </p>
  );
}
