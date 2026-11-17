import { formatCents } from "@abacus/core/money";

type Person = { id: string; displayName: string };

// When an expense is edited, a line saying that saving would give it other
// shares than the ones it has: the rules or incomes of its date changed
// since it was split. Null when nothing would move, when the amount was
// changed (then new shares are expected), or when it was stored unsplit.
export function resplitLine(people: Person[], stored: Record<string, number>, next: Record<string, number>): string | null {
  const sum = (shares: Record<string, number>) => Object.values(shares).reduce((a, b) => a + b, 0);
  if (Object.keys(stored).length === 0 || sum(stored) !== sum(next)) return null;
  const moved = people.filter((p) => (stored[p.id] ?? 0) !== (next[p.id] ?? 0));
  if (moved.length === 0) return null;
  return `Saving will re-split this: ${people
    .map((p) => `${p.displayName} ${formatCents(stored[p.id] ?? 0)} → ${formatCents(next[p.id] ?? 0)}`)
    .join(", ")}`;
}
