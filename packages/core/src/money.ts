// Money is integer cents everywhere. These turn cents into text and text
// into cents without passing through a fractional number.

// 123456 -> "1234.56"
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// 123456 -> "$1,234.56"
export function formatCents(cents: number): string {
  const [whole, fraction] = centsToDecimal(Math.abs(cents)).split(".");
  return `${cents < 0 ? "-" : ""}$${whole!.replace(/\B(?=(\d{3})+$)/g, ",")}.${fraction}`;
}

// "1,234.5" -> 123450. Null when the text is not an amount of money.
export function parseCents(text: string): number | null {
  const cleaned = text.trim().replace(/^\$/, "").replaceAll(",", "");
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

// 6000 -> "60%", 3333 -> "33.33%"
export function formatBp(bp: number): string {
  return `${centsToDecimal(bp).replace(/\.?0+$/, "")}%`;
}

// "60" -> 6000, "33.33" -> 3333. Null when not a percentage from 0 to 100.
export function parseBp(text: string): number | null {
  const bp = parseCents(text.trim().replace(/%$/, ""));
  return bp === null || bp > 10000 ? null : bp;
}
