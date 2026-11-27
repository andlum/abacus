import { and, eq, inArray } from "drizzle-orm";
import { account, bankConnection, bankTransaction, category, expense, expenseTemplate, mcpToken, reimbursement, settlement, splitRule, type AuditEntry, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { accountLabel } from "./accounts.ts";
import { recentAudit } from "./audit.ts";

export type ActivityItem = {
  id: number;
  at: Date;
  who: string;
  text: string;
  cents: number | null;
  href: string | null;
};

type Lookups = {
  names: Map<string, string>;
  expenses: Map<string, { description: string; totalCents: number | null }>;
  templates: Map<string, { name: string; lineageId: string }>;
  settlements: Map<string, { fromMemberId: string; toMemberId: string; amountCents: number }>;
  // A business paying a member back (owed-back.ts).
  reimbursements?: Map<string, { memberId: string; amountCents: number }>;
  // Agent token names by id, for the entries an agent made.
  tokens?: Map<string, string>;
  accounts?: Map<string, { name: string; lastFour: string | null }>;
  // Category labels by id.
  categories?: Map<string, string>;
  // What each split rule covers, by rule id: "Groceries", "Rent",
  // "everything else".
  rules?: Map<string, string>;
};

// One audit entry as a line a person can read. Incomes never show an amount:
// a partner's salary is not shared in the feed.
export function describe(e: AuditEntry, l: Lookups): ActivityItem {
  // Done through an agent token: "Alex's agent".
  const person = e.actorMemberId ? (l.names.get(e.actorMemberId) ?? "Someone") : e.actorKind === "system" ? "Clementine" : "Assistant";
  const who = e.actorMemberId && e.actorTokenId ? `${person}'s agent` : person;
  const base = { id: e.id, at: e.at, who, cents: null as number | null, href: null as string | null };
  const ex = e.entityType === "expense" && e.entityId ? l.expenses.get(e.entityId) : undefined;
  const tp = e.entityType === "expense_template" && e.entityId ? l.templates.get(e.entityId) : undefined;
  const st = e.entityType === "settlement" && e.entityId ? l.settlements.get(e.entityId) : undefined;
  const payment = e.entityType === "settlement" && e.entityId ? `/payments/${e.entityId}` : "/";
  const rb = e.entityType === "reimbursement" && e.entityId ? l.reimbursements?.get(e.entityId) : undefined;
  const name = (id: string) => l.names.get(id) ?? "someone";
  const ac = e.entityType === "account" && e.entityId ? l.accounts?.get(e.entityId) : undefined;
  const acct = ac ? `the account ${accountLabel(ac)}` : "an account";
  const cat = (e.entityType === "category" && e.entityId && l.categories?.get(e.entityId)) || (typeof e.detail.label === "string" ? e.detail.label : null);
  const catText = cat ? `the category ${cat}` : "a category";
  // The person an invitation entry is about.
  const invitee = e.entityType === "member" && e.entityId ? name(e.entityId) : "someone";
  const agent = (e.actorTokenId && l.tokens?.get(e.actorTokenId)) || "An agent";
  const what = ex?.description ?? "an expense";
  // A recurring cost, or a card transaction the sync posted by itself.
  const fromTemplate = e.detail.source === "template" || (e.detail.source === "bank" && e.actorKind === "system");
  const replaced = typeof e.detail.supersedesId === "string";

  switch (e.action) {
    case "expense.posted":
    case "expense.unassigned":
      return {
        ...base,
        text: `${fromTemplate ? "Posted" : replaced ? "Edited" : "Added"} ${ex?.description ?? "an expense"}${e.action === "expense.unassigned" ? " (could not be split)" : ""}`,
        cents: ex?.totalCents ?? null,
        href: e.entityId ? `/expenses/${e.entityId}` : null,
      };
    case "expense.amount_entered":
      return {
        ...base,
        text: `Entered the amount for ${ex?.description ?? "a bill"}`,
        cents: ex?.totalCents ?? null,
        href: e.entityId ? `/expenses/${e.entityId}` : null,
      };
    case "expense.fixed":
      return {
        ...base,
        text: `Split ${ex?.description ?? "an expense"} that could not be split before`,
        cents: ex?.totalCents ?? null,
        href: e.entityId ? `/expenses/${e.entityId}` : null,
      };
    case "expense.needs_amount":
      return { ...base, text: `${ex?.description ?? "A bill"} is waiting for its amount`, href: "/#to-do" };
    case "expense.proposed":
      return {
        ...base,
        text: `${(e.actorTokenId && l.tokens?.get(e.actorTokenId)) || "An agent"} proposed ${ex?.description ?? "an expense"}`,
        cents: ex?.totalCents ?? null,
      };
    case "expense.confirmed":
      return {
        ...base,
        text: `Confirmed ${ex?.description ?? "an expense"}, which an agent proposed`,
        cents: ex?.totalCents ?? null,
        href: e.entityId ? `/expenses/${e.entityId}` : null,
      };
    case "expense.rejected":
      return { ...base, text: `Turned down ${ex?.description ?? "an expense"}, which an agent proposed`, cents: ex?.totalCents ?? null };
    case "expense.voided":
      return { ...base, text: `Removed ${ex?.description ?? "an expense"}`, cents: ex?.totalCents ?? null };
    case "expense_template.created":
      return { ...base, text: `Set up recurring ${tp?.name ?? "cost"}`, href: tp ? `/recurring/${tp.lineageId}` : null };
    case "expense_template.changed":
      return { ...base, text: `Changed recurring ${tp?.name ?? "cost"}`, href: tp ? `/recurring/${tp.lineageId}` : null };
    case "settlement.recorded":
      return {
        ...base,
        text: st ? `${name(st.fromMemberId)} paid ${name(st.toMemberId)}` : "Recorded a payment",
        cents: st?.amountCents ?? null,
        href: payment,
      };
    case "settlement.edited":
      return {
        ...base,
        text: st ? `Edited a payment: ${name(st.fromMemberId)} paid ${name(st.toMemberId)}` : "Edited a payment",
        cents: st?.amountCents ?? null,
        href: payment,
      };
    case "settlement.voided":
      return { ...base, text: "Undid a payment", cents: st?.amountCents ?? null, href: payment };
    case "reimbursement.recorded":
      return {
        ...base,
        text: rb ? `The business repaid ${name(rb.memberId)}` : "Recorded a repayment",
        cents: rb?.amountCents ?? null,
        href: "/#balance",
      };
    case "reimbursement.voided":
      return { ...base, text: "Undid a repayment", cents: rb?.amountCents ?? null, href: "/#balance" };
    // From before rules counted at once; nothing writes these now.
    case "change_set.proposed":
      return { ...base, text: "Proposed a change", href: "/settings/people#split" };
    case "change_set.accepted":
      return { ...base, text: "Accepted a change", href: "/settings/people#split" };
    case "change_set.activated":
      return { ...base, text: `A change took effect from ${String(e.detail.effectiveFrom ?? "")}`.trim() };
    case "change_set.rejected":
      return { ...base, text: "Turned down a change", href: "/settings/people#split" };
    case "change_set.withdrawn":
      return { ...base, text: "Withdrew a change", href: "/settings/people#split" };
    case "split_rule.added":
    case "split_rule.changed":
    case "split_rule.removed": {
      const covers = e.entityType === "split_rule" && e.entityId ? l.rules?.get(e.entityId) : undefined;
      const verb = e.action === "split_rule.added" ? "Added" : e.action === "split_rule.changed" ? "Changed" : "Removed";
      const text = covers ? `${verb} ${e.action === "split_rule.added" ? "a" : "the"} rule for ${covers}` : `${verb} a split rule`;
      return { ...base, text, href: "/settings/people#split" };
    }
    case "income.recorded":
    case "income.changed":
    case "income.removed": {
      // Whose income, when it is not the actor's own. Never the amount.
      const owner = e.detail.ownerId && e.detail.ownerId !== e.actorMemberId ? name(String(e.detail.ownerId)) : null;
      if (e.action === "income.recorded") return { ...base, text: owner ? `Recorded an income for ${owner}` : "Recorded an income" };
      if (e.action === "income.changed") return { ...base, text: owner ? `Changed ${owner}'s income` : "Changed their income" };
      return { ...base, text: owner ? `Removed ${owner}'s income` : "Removed their income" };
    }
    case "income.withdrawn":
      return { ...base, text: "Withdrew an income" };
    case "income.share_mode_changed":
      return { ...base, text: e.detail.to === "amount" ? "Showed their income amount" : "Hid their income amount" };
    case "import.applied":
      return { ...base, text: `Imported ${String(e.detail.rowCount ?? "")} expenses`.replace("  ", " ") };
    case "api_token.created":
      return { ...base, text: `Connected a device: ${String(e.detail.name ?? "")}` };
    case "api_token.revoked":
      return { ...base, text: `Disconnected a device: ${String(e.detail.name ?? "")}` };
    case "mcp_token.created":
      return {
        ...base,
        text: `Made an agent token that can ${
          e.detail.permission === "write" ? "read, and add, change and remove expenses" : e.detail.permission === "propose" ? "read and propose expenses" : "read"
        }`,
      };
    case "mcp_token.revoked":
      return { ...base, text: "Revoked an agent token" };
    case "member.linked":
      return { ...base, text: "Signed in for the first time" };
    case "household.provisioned":
      return { ...base, text: "Household created" };
    case "household.created":
      return { ...base, text: e.detail.kind === "business" ? "Business created" : "Household created" };
    case "member.default_group_set":
      return { ...base, text: "Made this their default group" };
    case "member.invited":
      return {
        ...base,
        text: e.detail.added ? `Invited ${invitee}` : e.detail.previousEmail ? `Invited ${invitee} again, at a new address` : `Invited ${invitee} again`,
        href: "/settings/people",
      };
    case "member.invite_emailed":
      return { ...base, text: `Emailed ${invitee} an invite`, href: "/settings/people" };
    case "member.invite_cancelled":
      return { ...base, text: `Cancelled ${invitee}'s invite`, href: "/settings/people" };
    case "member.invite_declined":
      return { ...base, text: "Turned down the invitation" };
    case "member.removed":
      return { ...base, text: `Removed ${invitee}'s access`, href: "/settings/people" };
    case "member.link_rejected":
      return { ...base, text: `A sign-in could not be matched to ${invitee}` };
    case "account.added":
      return { ...base, text: `Added ${acct}`, href: "/settings/accounts" };
    case "account.renamed":
      return { ...base, text: `Renamed ${acct}`, href: "/settings/accounts" };
    case "account.kind_changed": {
      const to = e.detail.to === "business" || e.detail.to === "personal" ? e.detail.to : null;
      const it = ac ? accountLabel(ac) : "an account";
      return { ...base, text: to ? `Changed ${it} to a ${to} account` : `Stopped marking ${it} as personal or business`, href: "/settings/accounts" };
    }
    case "account.archived":
      return { ...base, text: `Archived ${acct}`, href: "/settings/accounts" };
    case "account.restored":
      return { ...base, text: `Restored ${acct}`, href: "/settings/accounts" };
    case "account.card_mode_changed":
      return { ...base, text: e.detail.to === "shared" ? `Made ${acct} a shared card` : `Made ${acct} a personal card`, href: "/accounts" };
    case "card_review.submitted":
      return { ...base, text: `Reviewed purchases on ${acct}`, href: "/accounts" };
    case "account.share_all_changed":
      return { ...base, text: e.detail.on === true ? `Set ${acct} to add every purchase` : `Set ${acct} to wait for each purchase to be sorted`, href: "/settings/accounts" };
    // Card activity is the connection owner's own: these say what happened,
    // never an amount or a merchant.
    case "bank_connection.connected":
      return { ...base, text: "Connected a bank", href: "/settings/accounts" };
    case "bank_connection.needs_relink":
      return { ...base, text: "A bank connection needs signing in again", href: "/settings/accounts" };
    case "bank_connection.reconnected":
      return { ...base, text: "A bank connection is working again", href: "/settings/accounts" };
    case "bank_connection.removed":
      return { ...base, text: "Disconnected a bank", href: "/settings/accounts" };
    case "bank_transaction.added":
      return { ...base, text: "Added a card purchase as an expense" };
    case "bank_transaction.cleared_for_review":
      return { ...base, text: "Cleared a card transaction waiting to be sorted" };
    case "bank_transaction.put_back":
      return { ...base, text: "Put a card purchase back into its card payment" };
    case "card_payment.recorded":
      return { ...base, text: "A card payment came in" };
    case "card_payment.shared":
      return { ...base, text: "Shared an earlier card payment" };
    case "bank_transaction.dismissed":
      return { ...base, text: "Set aside a card transaction" };
    case "bank_transaction.restored":
      return { ...base, text: "Put a card transaction back to sort" };
    case "bank_transaction.tied":
      return { ...base, text: "Matched a card purchase to a recurring cost" };
    case "bank_transaction.retied":
      return { ...base, text: "Kept a matched card purchase with the edited expense" };
    case "bank_transaction.untied":
      return { ...base, text: "Let go of a card purchase matched to a recurring cost" };
    case "category.added":
      return { ...base, text: `Added ${catText}`, href: "/settings/categories" };
    case "category.renamed":
      return {
        ...base,
        text: typeof e.detail.from === "string" && typeof e.detail.to === "string" ? `Renamed the category ${e.detail.from} to ${e.detail.to}` : `Renamed ${catText}`,
        href: "/settings/categories",
      };
    case "category.removed":
      return { ...base, text: `Removed ${catText}`, href: "/settings/categories" };
    // From before categories were removed rather than archived.
    case "category.archived":
      return { ...base, text: `Archived ${catText}`, href: "/settings/categories" };
    case "category.restored":
      return { ...base, text: `Restored ${catText}`, href: "/settings/categories" };
    case "expense.correction_proposed":
      return { ...base, text: `${agent} proposed a correction to ${what}` };
    case "expense.void_proposed":
      return { ...base, text: `${agent} proposed removing ${what}` };
    case "expense.correction_confirmed":
      return { ...base, text: `Accepted a correction to ${what}, which an agent proposed` };
    case "expense.void_confirmed":
      return { ...base, text: `Removed ${what}, as an agent proposed`, cents: ex?.totalCents ?? null };
    case "expense.correction_rejected":
      return { ...base, text: `Turned down a correction to ${what}, which an agent proposed` };
    case "expense.void_rejected":
      return { ...base, text: `Kept ${what}, which an agent proposed removing` };
    case "expense.correction_stale":
      return { ...base, text: `Set aside an out-of-date correction to ${what}` };
    case "expense.void_stale":
      return { ...base, text: `Set aside an out-of-date proposal to remove ${what}` };
    default:
      return { ...base, text: e.action.replaceAll("_", " ").replace(".", ": ") };
  }
}

// Left out of the feed every member sees: a sign-in that matched nobody,
// and the owner's own sorting of their card transactions.
// A card payment is shown on its owner's card page, and a shared one is in
// the Ledger as an expense; neither needs a line of its own.
const PRIVATE_TO_ACTOR = new Set([
  "member.link_rejected",
  "bank_transaction.dismissed",
  "bank_transaction.restored",
  "bank_transaction.cleared_for_review",
  "card_payment.recorded",
  "card_payment.shared",
]);

// Card purchases tied to recurring costs: only the connection's owner reads these.
const OWNER_ONLY = new Set(["bank_transaction.tied", "bank_transaction.retied", "bank_transaction.untied", "bank_transaction.put_back"]);

export async function recentActivity(db: Db, householdId: string, names: Map<string, string>, limit: number, viewer?: Member) {
  const recent = (await recentAudit(db, householdId, limit)).filter((e) => !PRIVATE_TO_ACTOR.has(e.action));
  const ownerOnly = recent.filter((e) => OWNER_ONLY.has(e.action) && e.entityId);
  const mine = new Set(
    !viewer || ownerOnly.length === 0
      ? []
      : (
          await db
            .select({ id: bankTransaction.id })
            .from(bankTransaction)
            .innerJoin(bankConnection, eq(bankConnection.id, bankTransaction.connectionId))
            .where(and(inArray(bankTransaction.id, ownerOnly.map((e) => e.entityId!)), eq(bankConnection.ownerId, viewer.id)))
        ).map((r) => r.id),
  );
  const entries = recent.filter((e) => !OWNER_ONLY.has(e.action) || (e.entityId && mine.has(e.entityId)));
  const ids = (type: string) => [...new Set(entries.filter((e) => e.entityType === type && e.entityId).map((e) => e.entityId!))];
  const [ex, tp, st, rb, ac, ct, sr] = [ids("expense"), ids("expense_template"), ids("settlement"), ids("reimbursement"), ids("account"), ids("category"), ids("split_rule")];
  const tk = [...new Set(entries.map((e) => e.actorTokenId).filter((id): id is string => !!id))];
  const lookups: Lookups = {
    names,
    expenses: new Map(
      ex.length === 0
        ? []
        : (
            await db
              .select({ id: expense.id, description: expense.description, totalCents: expense.totalCents })
              .from(expense)
              .where(and(eq(expense.householdId, householdId), inArray(expense.id, ex)))
          ).map((r) => [r.id, r]),
    ),
    templates: new Map(
      tp.length === 0
        ? []
        : (
            await db
              .select({ id: expenseTemplate.id, name: expenseTemplate.name, lineageId: expenseTemplate.lineageId })
              .from(expenseTemplate)
              .where(and(eq(expenseTemplate.householdId, householdId), inArray(expenseTemplate.id, tp)))
          ).map((r) => [r.id, r]),
    ),
    settlements: new Map(
      st.length === 0
        ? []
        : (
            await db
              .select({
                id: settlement.id,
                fromMemberId: settlement.fromMemberId,
                toMemberId: settlement.toMemberId,
                amountCents: settlement.amountCents,
              })
              .from(settlement)
              .where(and(eq(settlement.householdId, householdId), inArray(settlement.id, st)))
          ).map((r) => [r.id, r]),
    ),
    reimbursements: new Map(
      rb.length === 0
        ? []
        : (
            await db
              .select({ id: reimbursement.id, memberId: reimbursement.memberId, amountCents: reimbursement.amountCents })
              .from(reimbursement)
              .where(and(eq(reimbursement.householdId, householdId), inArray(reimbursement.id, rb)))
          ).map((r) => [r.id, r]),
    ),
    tokens: new Map(
      tk.length === 0
        ? []
        : (
            await db
              .select({ id: mcpToken.id, name: mcpToken.name })
              .from(mcpToken)
              .where(and(eq(mcpToken.householdId, householdId), inArray(mcpToken.id, tk)))
          ).map((r) => [r.id, r.name]),
    ),
  };
  if (ac.length > 0) {
    const rows = await db
      .select({ id: account.id, name: account.name, lastFour: account.lastFour })
      .from(account)
      .where(and(eq(account.householdId, householdId), inArray(account.id, ac)));
    lookups.accounts = new Map(rows.map((r) => [r.id, r]));
  }
  if (ct.length > 0) {
    const rows = await db
      .select({ id: category.id, label: category.label })
      .from(category)
      .where(and(eq(category.householdId, householdId), inArray(category.id, ct)));
    lookups.categories = new Map(rows.map((r) => [r.id, r.label]));
  }
  if (sr.length > 0) {
    const rows = await db
      .select({ id: splitRule.id, scope: splitRule.scope, category: splitRule.category, lineageId: splitRule.templateLineageId })
      .from(splitRule)
      .where(and(eq(splitRule.householdId, householdId), inArray(splitRule.id, sr)));
    const labels = new Map(
      (await db.select({ slug: category.slug, label: category.label }).from(category).where(eq(category.householdId, householdId))).map((c) => [c.slug, c.label]),
    );
    const lineages = [...new Set(rows.map((r) => r.lineageId).filter((id): id is string => !!id))];
    // A recurring cost's latest name.
    const costs = new Map(
      lineages.length === 0
        ? []
        : (
            await db
              .select({ lineageId: expenseTemplate.lineageId, name: expenseTemplate.name })
              .from(expenseTemplate)
              .where(and(eq(expenseTemplate.householdId, householdId), inArray(expenseTemplate.lineageId, lineages)))
              .orderBy(expenseTemplate.createdAt)
          ).map((r) => [r.lineageId, r.name]),
    );
    lookups.rules = new Map(
      rows.map((r) => [
        r.id,
        r.scope === "category" ? (labels.get(r.category!) ?? r.category!) : r.scope === "template" ? (costs.get(r.lineageId!) ?? "a recurring cost") : "everything else",
      ]),
    );
  }
  return entries.map((e) => describe(e, lookups));
}
