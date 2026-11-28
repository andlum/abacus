import type { CardLine, PaymentLine } from "@/lib/card-review";
import { formatCents } from "@abacus/core/money";
import { shortDate } from "@abacus/core/dates";

// "Visa 4242", or just the name when no digits were given.
export const cardName = (c: { name: string; lastFour: string | null }) => (c.lastFour ? `${c.name} ${c.lastFour}` : c.name);

// "20 Nov, $1,200.00, $1,058.00 still shared" for one payment.
export function paymentText(p: PaymentLine, today: string): string {
  const base = `${shortDate(p.date, today)}, ${formatCents(p.amountCents)}`;
  if (p.mode !== "shared") return `${base}, not shared`;
  return p.stillSharedCents === p.amountCents ? `${base}, shared whole` : `${base}, ${formatCents(p.stillSharedCents)} still shared`;
}

// In a business group the card's kind is what matters: whose card it is.
export function modeText(c: Pick<CardLine, "cardMode" | "kind">, business = false): string {
  if (business) return c.kind === "business" ? "Business card" : c.kind === "personal" ? "Personal card" : "Not said whose card yet";
  return c.cardMode === "shared" ? "Shared card" : "Personal card";
}
