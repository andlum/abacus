"use client";

import { useActionState, useState, useTransition } from "react";
import { importCounts } from "@/lib/import-counts";
import { formatCents } from "@abacus/core/money";
import { applyImportAction, previewImportAction, type ImportState } from "../actions";

type Person = { id: string; displayName: string };

const shareText = (shares: Record<string, number>, people: Person[]) =>
  people.map((p) => `${p.displayName} ${formatCents(shares[p.id] ?? 0)}`).join(" · ");

// Two steps: read the file and show what importing would do, then import
// exactly that text.
export function ImportForm({ people }: { people: Person[] }) {
  const [csv, setCsv] = useState("");
  const [previewed, preview] = useActionState<ImportState, FormData>(previewImportAction, {});
  const [applied, apply] = useActionState<ImportState, FormData>(applyImportAction, {});
  const [pending, start] = useTransition();
  const nameOf = new Map(people.map((p) => [p.id, p.displayName]));

  const send = (action: (form: FormData) => void) => {
    const form = new FormData();
    form.set("csv", csv);
    start(() => action(form));
  };
  const result = previewed.preview;
  const counts = result?.ok ? importCounts(result.rows) : null;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const done = applied.imported !== undefined;

  return (
    <div aria-busy={pending}>
      <label>
        CSV file
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            setCsv(file ? await file.text() : "");
          }}
        />
      </label>
      <button type="button" disabled={!csv || pending} onClick={() => send(preview)}>
        Check the file
      </button>

      {previewed.error && (
        <p role="alert" className="error">
          Not checked: {previewed.error}.
        </p>
      )}
      {done && <p role="status">Imported {applied.imported} expenses.</p>}
      {applied.error && (
        <p role="alert" className="error">
          {applied.error}.
        </p>
      )}

      {!done && result && !result.ok && (
        <>
          <p role="alert" className="error">
            Nothing can be imported until these are fixed:
          </p>
          <ul>
            {result.errors.map((e, i) => (
              <li key={i}>
                Line {e.line}: {e.message}
              </li>
            ))}
          </ul>
        </>
      )}

      {!done && result?.ok && (
        <>
          <h3>What importing would do</h3>
          <ul aria-label="Import summary">
            <li>
              {plural(counts!.added, "new expense", "new expenses")}, and{" "}
              {plural(counts!.replaced, "expense already here", "expenses already here")} replaced
              {counts!.replaced > 0 && <>, of which {counts!.resplit} would split differently</>}.
            </li>
            {result.newAccounts.length > 0 && (
              <li>
                {plural(result.newAccounts.length, "account", "accounts")} would be added: {result.newAccounts.join(", ")}.
              </li>
            )}
            {counts!.onDefault > 0 && people.length > 1 && (
              <li>
                {plural(counts!.onDefault, "expense has", "expenses have")} no rule, so{" "}
                {counts!.onDefault === 1 ? "it splits" : "they split"} by the even-split default.
              </li>
            )}
            {counts!.unsplit > 0 && (
              <li>
                {plural(counts!.unsplit, "expense cannot", "expenses cannot")} be split. {counts!.unsplit === 1 ? "It" : "They"} would
                wait in the to-do list on Home, out of the balance.
              </li>
            )}
            <li>
              {people
                .map((p) => {
                  const change = result.balanceChange[p.id] ?? 0;
                  return `${p.displayName}'s position ${change === 0 ? "does not change" : `moves by ${formatCents(change)}`}`;
                })
                .join("; ")}
              .
            </li>
          </ul>
          <table>
            <thead>
              <tr>
                <th>Line</th>
                <th>Date</th>
                <th>Expense</th>
                <th className="num">Total</th>
                <th>Paid by</th>
                <th>Segments now</th>
                <th>Segments after</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr key={r.line}>
                  <td>{r.line}</td>
                  <td className="whitespace-nowrap">{r.date}</td>
                  <td>
                    {r.description} {!r.old && <span className="tag">new</span>}
                  </td>
                  <td className="num">{formatCents(r.totalCents)}</td>
                  <td>{nameOf.get(r.payerId)}</td>
                  <td>{r.old ? (r.old.status === "posted" ? shareText(r.old.shares, people) : "not split") : "—"}</td>
                  <td>
                    {r.status === "posted" ? (
                      <>
                        {shareText(r.shares, people)}{" "}
                        {r.ruleSource === "default" && people.length > 1 && <span className="tag warn">even-split default</span>}
                      </>
                    ) : (
                      <span className="tag warn">cannot be split</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" disabled={pending} onClick={() => send(apply)}>
            Import these {result.rows.length} expenses
          </button>
        </>
      )}
    </div>
  );
}
