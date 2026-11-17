import { describe as group, expect, it } from "vitest";
import type { AuditEntry } from "../db/schema.ts";
import { describe } from "./activity.ts";
import { AUDIT_ACTIONS } from "./audit.ts";

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: 1,
  at: new Date("2027-03-01T10:00:00Z"),
  householdId: "h",
  actorKind: "member",
  actorMemberId: "alex",
  actorTokenId: null,
  action: "expense.posted",
  entityType: "expense",
  entityId: "e1",
  detail: {},
  ...over,
});

const lookups = {
  names: new Map([
    ["alex", "Alex"],
    ["sam", "Sam"],
  ]),
  expenses: new Map([["e1", { description: "Groceries", totalCents: 8000 }]]),
  templates: new Map([["t1", { name: "Rent", lineageId: "l1" }]]),
  settlements: new Map([["s1", { fromMemberId: "sam", toMemberId: "alex", amountCents: 50000 }]]),
  tokens: new Map([["k1", "Receipts agent"]]),
};

group("describe", () => {
  it("names the expense, the person and the amount", () => {
    expect(describe(entry({}), lookups)).toMatchObject({
      who: "Alex",
      text: "Added Groceries",
      cents: 8000,
      href: "/expenses/e1",
    });
  });

  it("says a recurring cost was posted, not added", () => {
    expect(describe(entry({ actorKind: "system", actorMemberId: null, detail: { source: "template" } }), lookups)).toMatchObject({
      who: "Clementine",
      text: "Posted Groceries",
    });
  });

  it("describes a payment between partners", () => {
    const e = entry({ action: "settlement.recorded", entityType: "settlement", entityId: "s1", actorMemberId: "sam" });
    expect(describe(e, lookups)).toMatchObject({ text: "Sam paid Alex", cents: 50000, href: "/payments/s1" });
  });

  it("says a payment was edited, with its new amount, and links to it", () => {
    const e = entry({ action: "settlement.edited", entityType: "settlement", entityId: "s1", actorMemberId: "alex", detail: { supersedesId: "s0" } });
    expect(describe(e, lookups)).toMatchObject({ text: "Edited a payment: Sam paid Alex", cents: 50000, href: "/payments/s1" });
  });

  it("describes a business paying a member back", () => {
    const l = { ...lookups, reimbursements: new Map([["r1", { memberId: "alex", amountCents: 6000 }]]) };
    const recorded = entry({ action: "reimbursement.recorded", entityType: "reimbursement", entityId: "r1" });
    expect(describe(recorded, l)).toMatchObject({ text: "The business repaid Alex", cents: 6000, href: "/#balance" });
    const voided = entry({ action: "reimbursement.voided", entityType: "reimbursement", entityId: "r1" });
    expect(describe(voided, l)).toMatchObject({ text: "Undid a repayment", cents: 6000, href: "/#balance" });
  });

  it("sends a bill waiting for its amount to the to-do list on Home", () => {
    const e = entry({ action: "expense.needs_amount" });
    expect(describe(e, lookups)).toMatchObject({ text: "Groceries is waiting for its amount", href: "/#to-do" });
  });

  it("never shows an income amount", () => {
    const e = entry({ action: "income.recorded", entityType: "income", entityId: "i1", detail: { shareMode: "amount" } });
    expect(describe(e, lookups)).toMatchObject({ text: "Recorded an income", cents: null });
  });

  it("reads as a sentence for a bill's amount, a fixed split and a share mode", () => {
    expect(describe(entry({ action: "expense.amount_entered" }), lookups)).toMatchObject({ text: "Entered the amount for Groceries", cents: 8000 });
    expect(describe(entry({ action: "expense.fixed" }), lookups)).toMatchObject({ text: "Split Groceries that could not be split before" });
    const shown = entry({ action: "income.share_mode_changed", entityType: "income", detail: { from: "ratio_only", to: "amount" } });
    expect(describe(shown, lookups)).toMatchObject({ text: "Showed their income amount", cents: null });
  });

  it("links a recurring cost to its page", () => {
    const e = entry({ action: "expense_template.created", entityType: "expense_template", entityId: "t1" });
    expect(describe(e, lookups)).toMatchObject({ text: "Set up recurring Rent", href: "/recurring/l1" });
  });

  it("names a device when it is connected or disconnected", () => {
    const made = entry({ action: "api_token.created", entityType: "api_token", detail: { name: "Alex's phone" } });
    expect(describe(made, lookups)).toMatchObject({ text: "Connected a device: Alex's phone", cents: null });
    const gone = entry({ action: "api_token.revoked", entityType: "api_token", detail: { name: "Alex's phone" } });
    expect(describe(gone, lookups)).toMatchObject({ text: "Disconnected a device: Alex's phone" });
  });

  it("says what an agent token may do when it is made, and when it is revoked", () => {
    const made = entry({ action: "mcp_token.created", entityType: "mcp_token", detail: { permission: "propose" } });
    expect(describe(made, lookups)).toMatchObject({ text: "Made an agent token that can read and propose expenses", cents: null });
    const reader = entry({ action: "mcp_token.created", entityType: "mcp_token", detail: { permission: "read" } });
    expect(describe(reader, lookups)).toMatchObject({ text: "Made an agent token that can read" });
    const gone = entry({ action: "mcp_token.revoked", entityType: "mcp_token", detail: { permission: "read" } });
    expect(describe(gone, lookups)).toMatchObject({ text: "Revoked an agent token" });
  });

  it("names the agent token that proposed an expense, when it is known", () => {
    const named = entry({ action: "expense.proposed", actorTokenId: "k1" });
    expect(describe(named, lookups)).toMatchObject({ text: "Receipts agent proposed Groceries", cents: 8000 });
    expect(describe(entry({ action: "expense.proposed" }), lookups)).toMatchObject({ text: "An agent proposed Groceries" });
  });

  it("says an expense came through the member's agent when a token wrote it", () => {
    expect(describe(entry({ actorTokenId: "k1", detail: { source: "agent" } }), lookups)).toMatchObject({
      who: "Alex's agent",
      text: "Added Groceries",
      cents: 8000,
    });
    expect(describe(entry({ actorTokenId: "k1", action: "expense.voided" }), lookups)).toMatchObject({ who: "Alex's agent", text: "Removed Groceries" });
    const made = entry({ action: "mcp_token.created", entityType: "mcp_token", entityId: "k1", detail: { permission: "write" } });
    expect(describe(made, lookups)).toMatchObject({ who: "Alex", text: "Made an agent token that can read, and add, change and remove expenses" });
  });

  it("names an account and what it became", () => {
    const l = { ...lookups, accounts: new Map([["a1", { name: "Alex Visa", lastFour: "4242" }]]) };
    const changed = entry({ action: "account.kind_changed", entityType: "account", entityId: "a1", detail: { from: "personal", to: "business" } });
    expect(describe(changed, l)).toMatchObject({ text: "Changed Alex Visa ··4242 to a business account", href: "/settings/accounts" });
    const added = entry({ action: "account.added", entityType: "account", entityId: "a1" });
    expect(describe(added, l)).toMatchObject({ text: "Added the account Alex Visa ··4242" });
  });

  it("names the person an invitation was for", () => {
    const emailed = entry({ action: "member.invite_emailed", entityType: "member", entityId: "sam" });
    expect(describe(emailed, lookups)).toMatchObject({ text: "Emailed Sam an invite" });
    const cancelled = entry({ action: "member.invite_cancelled", entityType: "member", entityId: "sam" });
    expect(describe(cancelled, lookups)).toMatchObject({ text: "Cancelled Sam's invite" });
  });

  it("says what a split rule covers when it is added, changed or removed", () => {
    const l = { ...lookups, rules: new Map([["r1", "Groceries"]]) };
    const of = (action: string) => describe(entry({ action, entityType: "split_rule", entityId: "r1" }), l);
    expect(of("split_rule.added")).toMatchObject({ text: "Added a rule for Groceries", cents: null, href: "/settings/people#split" });
    expect(of("split_rule.changed")).toMatchObject({ text: "Changed the rule for Groceries" });
    expect(of("split_rule.removed")).toMatchObject({ text: "Removed the rule for Groceries" });
  });

  // The fallback turns "account.kind_changed" into "account: kind changed".
  // Every action the code can write (AuditAction makes writeAudit refuse any
  // other) must read as a sentence instead, even with nothing to look up.
  it.each(AUDIT_ACTIONS)("has words for %s", (action) => {
    const raw = action.replaceAll("_", " ").replace(".", ": ");
    const text = describe(entry({ action, entityType: null, entityId: null }), { names: new Map(), expenses: new Map(), templates: new Map(), settlements: new Map() }).text;
    expect(text).not.toBe(raw);
    expect(text).not.toMatch(/_|undefined|null/);
  });
});
