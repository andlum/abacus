// A fake Plaid for the browser tests (e2e/card-review.spec.ts), so the card
// screens can be driven with no Plaid keys. It exists only when the sign-in
// stand-in does (ABACUS_E2E=1 outside a production build, src/lib/dev-auth.ts)
// and ABACUS_E2E_FAKE_PLAID=1 is also set, which only playwright.config.ts
// does. Anywhere else `e2eBankRuntime` is null and nothing here is reachable.
import { randomBytes } from "node:crypto";
import { addDays, todayIn } from "@abacus/core/dates";
import type { BankRuntime } from "./bank-link.ts";
import { devAuthEnabled } from "./dev-auth.ts";
import { ACCOUNTS, fakePlaid, payment, txn } from "./testing/fake-plaid.ts";

type Env = Record<string, string | undefined>;

export const e2ePlaidEnabled = (env: Env = process.env) => devAuthEnabled(env) && env.ABACUS_E2E_FAKE_PLAID === "1";

// Kept on globalThis: `next dev` can load this module again between requests,
// and the fake's state and sealing key must be the same ones every time.
const held = globalThis as typeof globalThis & { __abacusE2ePlaid?: BankRuntime };

// Public token "business" is described below. Public token "shared" connects the Everyday Card (1234) and "personal" the
// Travel Card (4321). Each card's first sync is empty and its second brings a
// $1,200.00 payment, so the payment arrives after the person has chosen
// shared or personal (POST /api/e2e/sync runs the second one). Purchases are
// read from the bank only when a review asks, and so are the payments, which
// the bank holds too. Dates are relative to the real
// clock, which is what the review page reads.
function build(): BankRuntime {
  const fake = fakePlaid();
  const today = todayIn("America/New_York", new Date());
  const ago = (days: number) => addDays(today, -days);
  const banks: Record<string, { name: string; card: string }> = {
    "access-shared": { name: "Shared Bank", card: "acc-card" },
    "access-personal": { name: "Personal Bank", card: "acc-travel" },
    "access-business": { name: "Business Bank", card: "acc-card" },
  };
  fake.on("shared", "", { next_cursor: "c1" });
  fake.on("shared", "c1", { added: [payment("pay-1", 1200, { date: ago(2) })], next_cursor: "c2" });
  fake.on("personal", "", { next_cursor: "c1" });
  fake.on("personal", "c1", { added: [payment("pay-2", 500, { account_id: "acc-travel", date: ago(2) })], next_cursor: "c2" });
  fake.hold(
    "shared",
    txn("buy-1", { amount: 100, date: ago(9), merchant_name: "Grocer" }),
    txn("buy-2", { amount: 30, date: ago(6), merchant_name: "Hardware" }),
    txn("buy-3", { amount: 12, date: ago(4), merchant_name: "Bakery" }),
    payment("pay-1", 1200, { date: ago(2) }),
  );
  fake.hold(
    "personal",
    txn("buy-4", { account_id: "acc-travel", amount: 45, date: ago(3), merchant_name: "Bookshop" }),
    txn("buy-5", { account_id: "acc-travel", amount: 8, date: ago(1), merchant_name: "Cafe" }),
    payment("pay-2", 500, { account_id: "acc-travel", date: ago(2) }),
  );
  // "business" connects an Everyday Card of its own, for a business group's
  // review: three purchases, and a $300.00 payment that must make no expense.
  fake.on("business", "", { next_cursor: "c1" });
  fake.on("business", "c1", { added: [payment("pay-3", 300, { date: ago(2) })], next_cursor: "c2" });
  fake.hold(
    "business",
    txn("buy-6", { amount: 100, date: ago(9), merchant_name: "Cloud Host" }),
    txn("buy-7", { amount: 40, date: ago(6), merchant_name: "Print Shop" }),
    txn("buy-8", { amount: 15, date: ago(4), merchant_name: "Corner Cafe" }),
    payment("pay-3", 300, { date: ago(2) }),
  );
  const plaid = {
    ...fake.plaid,
    getAccounts: async (token: string) => ACCOUNTS.filter((a) => a.account_id === banks[token]?.card),
    getInstitution: async (token: string) => ({ institutionId: `ins_${token}`, name: banks[token]?.name ?? "Test Bank" }),
  };
  return { plaid, key: randomBytes(32), getKey: async () => null };
}

export function e2eBankRuntime(env: Env = process.env): BankRuntime | null {
  if (!e2ePlaidEnabled(env)) return null;
  return (held.__abacusE2ePlaid ??= build());
}
