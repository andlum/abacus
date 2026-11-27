// An in-memory Plaid for tests of the bank code.
import { PlaidError, type PlaidAccount, type PlaidApi, type PlaidSyncPage, type PlaidTransaction } from "../plaid";

export const ACCOUNTS: PlaidAccount[] = [
  { account_id: "acc-card", name: "Everyday Card", mask: "1234", type: "credit", subtype: "credit card" },
  { account_id: "acc-travel", name: "Travel Card", mask: "4321", type: "credit", subtype: "credit card" },
  // Never followed: only credit cards are.
  { account_id: "acc-check", name: "Checking", mask: "0000", type: "depository", subtype: "checking" },
];

export const txn = (id: string, over: Partial<PlaidTransaction> = {}): PlaidTransaction => ({
  transaction_id: id,
  account_id: "acc-card",
  amount: 20,
  iso_currency_code: "USD",
  date: "2027-03-05",
  pending: false,
  merchant_name: "Corner Shop",
  ...over,
});

// A payment to the card: money in, in Plaid's card-payment category.
export const payment = (id: string, dollars: number, over: Partial<PlaidTransaction> = {}): PlaidTransaction =>
  txn(id, {
    amount: -dollars,
    merchant_name: null,
    name: "Payment, thank you",
    personal_finance_category: { primary: "LOAN_PAYMENTS", detailed: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" },
    ...over,
  });

export const page = (over: Partial<PlaidSyncPage>): PlaidSyncPage => ({ added: [], modified: [], removed: [], next_cursor: "", has_more: false, ...over });

// An in-memory Plaid. A public token "x" becomes access token "access-x".
// `pages` answers /transactions/sync by access token and cursor; `errors`
// queues error codes the next sync calls for that token throw.
export function fakePlaid() {
  const pages = new Map<string, PlaidSyncPage>();
  const errors = new Map<string, string[]>();
  const removedItems: string[] = [];
  const linkCalls: Parameters<PlaidApi["createLinkToken"]>[0][] = [];
  const syncCalls: (string | undefined)[] = [];
  // What /transactions/get answers, by access token, and every call made.
  const held = new Map<string, PlaidTransaction[]>();
  const getCalls: Parameters<PlaidApi["transactionsGet"]>[0][] = [];
  let accounts = ACCOUNTS;
  let institution: { institutionId: string; name: string } | null = { institutionId: "ins_1", name: "Test Bank" };
  const fail = (code: string) => new PlaidError("/transactions/sync", 400, code, "ITEM_ERROR", "req-1");
  const plaid: PlaidApi = {
    async createLinkToken(input) {
      linkCalls.push(input);
      return { linkToken: "link-1", expiration: "2027-03-10T19:00:00Z" };
    },
    async exchangePublicToken(publicToken) {
      return { accessToken: `access-${publicToken}`, itemId: `item-${publicToken}` };
    },
    async transactionsSync({ accessToken, cursor }) {
      syncCalls.push(cursor);
      const code = errors.get(accessToken)?.shift();
      if (code) throw fail(code);
      return pages.get(`${accessToken}|${cursor ?? ""}`) ?? page({ next_cursor: cursor ?? "" });
    },
    async transactionsGet(input) {
      getCalls.push(input);
      const code = errors.get(input.accessToken)?.shift();
      if (code) throw new PlaidError("/transactions/get", 400, code, "ITEM_ERROR", "req-3");
      const all = (held.get(input.accessToken) ?? [])
        .filter((t) => t.date >= input.startDate && t.date <= input.endDate && (!input.accountIds || input.accountIds.includes(t.account_id)))
        .sort((a, b) => b.date.localeCompare(a.date));
      const offset = input.offset ?? 0;
      return { transactions: all.slice(offset, offset + (input.count ?? 100)), total_transactions: all.length };
    },
    async getAccounts() {
      return accounts;
    },
    async removeItem(accessToken) {
      const code = errors.get(accessToken)?.shift();
      if (code) throw new PlaidError("/item/remove", 400, code, "ITEM_ERROR", "req-2");
      removedItems.push(accessToken);
    },
    async getInstitution() {
      return institution;
    },
    async getWebhookVerificationKey() {
      throw new Error("not used");
    },
    async sandboxPublicToken() {
      return "public-sandbox";
    },
  };
  return {
    plaid,
    removedItems,
    linkCalls,
    syncCalls,
    getCalls,
    // Sets what /transactions/get holds for public token `token`.
    hold: (token: string, ...t: PlaidTransaction[]) => held.set(`access-${token}`, t),
    setInstitution: (name: string | null) => (institution = name ? { institutionId: `ins_${name}`, name } : null),
    setAccounts: (a: PlaidAccount[]) => (accounts = a),
    on: (token: string, cursor: string, p: Partial<PlaidSyncPage>) => pages.set(`access-${token}|${cursor}`, page(p)),
    failNext: (token: string, ...codes: string[]) => errors.set(`access-${token}`, codes),
  };
}
