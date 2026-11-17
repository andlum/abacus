// A one-line summary of an import preview, so the table below it can be
// skimmed rather than read row by row. Types only, so the browser can use it.
import type { ImportRow } from "./transfer";

export type ImportCounts = {
  total: number;
  added: number;
  replaced: number;
  // Replaced rows whose split comes out different: other shares, or split
  // where it was not before.
  resplit: number;
  onDefault: number;
  unsplit: number;
};

const sameShares = (a: Record<string, number>, b: Record<string, number>) =>
  Object.keys({ ...a, ...b }).every((id) => (a[id] ?? 0) === (b[id] ?? 0));

export function importCounts(rows: ImportRow[]): ImportCounts {
  const counts: ImportCounts = { total: rows.length, added: 0, replaced: 0, resplit: 0, onDefault: 0, unsplit: 0 };
  for (const r of rows) {
    if (r.old) {
      counts.replaced++;
      if (r.old.status !== r.status || !sameShares(r.old.shares, r.shares)) counts.resplit++;
    } else {
      counts.added++;
    }
    if (r.status === "unassigned") counts.unsplit++;
    else if (r.ruleSource === "default") counts.onDefault++;
  }
  return counts;
}
