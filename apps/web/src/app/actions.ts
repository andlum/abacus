"use server";

import { attempt, field, moneyField, wholeField, type ActionState } from "@/lib/action";
import { returnTo } from "@/lib/return-to";
import { createApiToken, revokeApiToken } from "@/lib/api-tokens";
import { createMcpToken, revokeMcpToken } from "@/lib/mcp-tokens";
import { editSettlement, recordSettlement, voidSettlement } from "@/lib/balance";
import { recordReimbursement, voidReimbursement } from "@/lib/owed-back";
import { disconnectBanksOf, addFromBank, connectBank, firstSyncFrom, matchBill, notThisPurchase, dismissBankTransaction, removeBankConnection, restoreBankTransaction, setShareAll } from "@/lib/bank";
import { bankRuntime, finishRelink, requireBank, startLink, webhookUrl } from "@/lib/bank-link";
import { addAccount, renameAccount, setAccountArchived, setAccountKind } from "@/lib/accounts";
import { addCategory, removeCategory, renameCategory } from "@/lib/categories";
import { UserError } from "@abacus/core/errors";
import { createExpense, editExpense, enterAmount, fixUnassigned, getExpense, postEarlier, voidExpense } from "@/lib/expenses";
import { recordIncome, removeIncome, setShareMode } from "@/lib/incomes";
import { parseCents } from "@abacus/core/money";
import { claimInviteEmail, inviteLimits } from "@/lib/invite-limits";
import { sendInviteEmail } from "@/lib/invite-mail";
import { createMailer } from "@/lib/mail";
import { siteAddress } from "@/lib/site";
import { cancelInvite, invitePerson, reinvite, removeMember } from "@/lib/membership";
import { devAuthEnabled } from "@/lib/dev-auth";
import { readRule } from "@/lib/rule-text";
import { addRule, editRule, removeRule, type RuleTarget } from "@/lib/rules";
import { requireHousehold } from "@/lib/session";
import { previewSplit, type SplitPreview } from "@/lib/split-preview";
import { createTemplate, editTemplate, endTemplate } from "@/lib/templates";
import { CADENCES, type Cadence, type Member } from "@/db/schema";
import type { Db } from "@/db/types";
import { applyImport, previewImport, type ImportPreview } from "@/lib/transfer";

// ---- Expenses --------------------------------------------------------------

// The account picked, blank for none. A form without the picker leaves the
// account as it was.
const accountField = (form: FormData) => (form.has("accountId") ? field(form, "accountId") : undefined);

// One form for both: a one-time expense, or a recurring cost that enters
// itself on each due date.
export async function addExpense(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, members, today }) => {
    const kind = field(form, "kind");
    if (kind === "recurring") {
      const cadence = field(form, "cadence") as Cadence;
      if (!CADENCES.includes(cadence)) throw new UserError("choose how often it repeats");
      // A split chosen here is saved as the cost's own rule. Both are saved
      // together or not at all.
      const rule = readRule(form, "trule_", members);
      await db.transaction(async (tx) => {
        const t = await createTemplate(tx, me, {
          name: field(form, "description"),
          category: field(form, "category"),
          amountCents: moneyField(form, "amount", "the amount", true),
          cadence,
          dayOfMonth: wholeField(form, "dayOfMonth", "the due day"),
          monthOfYear: cadence === "monthly" ? null : wholeField(form, "monthOfYear", "the month"),
          payerId: field(form, "payerId"),
          accountId: accountField(form),
          startDate: field(form, "startDate"),
        });
        if (rule) {
          await addRule(
            tx,
            me,
            { scope: "template", templateLineageId: t.lineageId, rule, effectiveFrom: t.startDate > today ? t.startDate : today },
            today,
          );
        }
      });
      return "/recurring";
    }
    if (kind !== "once") throw new UserError("choose one-time or recurring");
    const row = await createExpense(db, me.householdId, {
      kind: "manual",
      actor: me,
      date: field(form, "date"),
      description: field(form, "description"),
      category: field(form, "category"),
      totalCents: moneyField(form, "amount", "the amount")!,
      payerId: field(form, "payerId"),
      accountId: accountField(form),
      rule: readRule(form, "rule_", members) ?? undefined,
      today,
    });
    // The list of every expense, where one dated today is first; an earlier
    // one is first on the list from its date back.
    return row.date < today ? `/?to=${row.date}` : "/";
  });
}

export type PreviewAnswer = {
  preview: SplitPreview | null;
  hint: string | null;
  recurring?: boolean;
};

// The split the Add expense form would save, worked out as the form is
// filled in. Saves nothing.
export async function previewExpense(form: FormData): Promise<PreviewAnswer> {
  const { me, db, members } = await requireHousehold();
  const recurring = field(form, "kind") === "recurring";
  const amount = field(form, "amount");
  if (!amount) {
    return { preview: null, hint: recurring ? "Enter an amount to see the split, or leave it empty if it varies." : "Enter an amount to see the split." };
  }
  const totalCents = parseCents(amount);
  if (totalCents === null) return { preview: null, hint: "The amount must look like 1234.56." };
  let rule;
  try {
    rule = readRule(form, recurring ? "trule_" : "rule_", members) ?? undefined;
  } catch (e) {
    if (e instanceof UserError) return { preview: { ok: false, rule: null, why: `That split is not valid: ${e.message}.`, reason: "invalid_rule" }, hint: null };
    throw e;
  }
  const date = field(form, recurring ? "startDate" : "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { preview: null, hint: "Pick a date to see the split." };
  // Editing an expense keeps the recurring cost it came from, and that
  // cost's own rule.
  const editing = field(form, "expenseId");
  const templateLineageId = editing ? (await getExpense(db, me.householdId, editing)).templateLineageId : null;
  const preview = await previewSplit(db, me.householdId, members, {
    templateLineageId,
    totalCents,
    payerId: field(form, "payerId") || me.id,
    category: field(form, "category"),
    date,
    rule,
  });
  return { preview, hint: null, recurring };
}

export async function saveExpense(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, members, today }) => {
    const row = await editExpense(
      db,
      me,
      field(form, "expenseId"),
      {
        date: field(form, "date"),
        description: field(form, "description"),
        category: field(form, "category"),
        totalCents: moneyField(form, "amount", "the amount")!,
        payerId: field(form, "payerId"),
        accountId: accountField(form),
        rule: readRule(form, "rule_", members) ?? undefined,
      },
      today,
    );
    // Back to the list the edit was opened from, else the list from its date back.
    return returnTo(field(form, "from")) ?? `/?to=${row.date}`;
  });
}

// From a list the row is simply gone or struck through; from the expense's
// own page (`then=list`) there is nothing left to edit, so it lands on the
// list from the expense's date back.
export async function voidExpenseAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    const id = field(form, "expenseId");
    await voidExpense(db, me, id);
    if (field(form, "then") === "list") return `/?to=${(await getExpense(db, me.householdId, id)).date}`;
  });
}

export async function enterAmountAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    await enterAmount(db, me, field(form, "expenseId"), moneyField(form, "amount", "the amount")!);
  });
}

export async function fixUnassignedAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, members, today }) => {
    await fixUnassigned(db, me, field(form, "expenseId"), today, readRule(form, "rule_", members) ?? undefined);
  });
}

// ---- Recurring costs -------------------------------------------------------

export async function changeRecurring(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, today }) => {
    await editTemplate(
      db,
      me,
      field(form, "lineageId"),
      {
        name: field(form, "name"),
        category: field(form, "category"),
        amountCents: moneyField(form, "amount", "the amount", true),
        dayOfMonth: wholeField(form, "dayOfMonth", "the due day"),
        payerId: field(form, "payerId"),
        accountId: accountField(form),
      },
      field(form, "effectiveFrom"),
      today,
    );
    return "/recurring";
  });
}

export async function endRecurring(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, today }) => {
    await endTemplate(db, me, field(form, "lineageId"), field(form, "endDate"), today);
    return "/recurring";
  });
}

// One month from before the cost started. A cost whose amount varies lands
// in the to-do list on Home, where the amount is entered.
export async function enterEarlierRecurring(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, today }) => {
    const row = await postEarlier(db, me, field(form, "lineageId"), field(form, "month"), today);
    // The list from that date back, so the month just entered is at the top.
    return row.status === "needs_amount" ? "/#to-do" : `/?to=${row.date}`;
  });
}

// ---- Incomes and changes ---------------------------------------------------

// Adds an income or changes it: either way it counts at once, from the date given.
export async function saveIncome(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, today }) => {
    const ownerId = String(form.get("ownerId") ?? "") || undefined;
    const effectiveFrom = String(form.get("effectiveFrom") ?? "") || undefined;
    await recordIncome(db, me, { annualCents: moneyField(form, "amount", "the income")!, ownerId, effectiveFrom }, today);
  });
}

// Shows an income amount hidden before hiding went away.
export async function setShareModeAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(({ me, db }) => setShareMode(db, me, field(form, "incomeId"), field(form, "shareMode") as "amount"));
}

export async function removeIncomeAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(({ me, db }) => removeIncome(db, me, field(form, "ownerId")));
}

// ---- Split rules -------------------------------------------------------------

// What a rule form says the rule covers: "household", "category" with a
// category picked, or "template:<lineage id>".
function ruleTarget(form: FormData): RuleTarget {
  const target = field(form, "target");
  if (target === "household") return { scope: "household" };
  if (target === "category") return { scope: "category", category: field(form, "category") };
  if (target.startsWith("template:")) return { scope: "template", templateLineageId: target.slice("template:".length) };
  throw new UserError("choose what the rule covers");
}

// Adds a rule, or changes the one already there for what it covers: either
// way it counts at once, from the date given.
export async function addRuleAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, members, today }) => {
    const rule = readRule(form, "rule_", members);
    if (!rule) throw new UserError("choose how to split");
    const effectiveFrom = String(form.get("effectiveFrom") ?? "") || undefined;
    await addRule(db, me, { ...ruleTarget(form), rule, effectiveFrom }, today);
  });
}

export async function editRuleAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, members, today }) => {
    const rule = readRule(form, "rule_", members);
    if (!rule) throw new UserError("choose how to split");
    const effectiveFrom = String(form.get("effectiveFrom") ?? "") || undefined;
    await editRule(db, me, field(form, "ruleId"), { rule, effectiveFrom }, today);
  });
}

export async function removeRuleAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(({ me, db, today }) => removeRule(db, me, field(form, "ruleId"), today));
}

// ---- Balance ---------------------------------------------------------------

const paymentFields = (form: FormData) => ({
  fromMemberId: field(form, "fromMemberId"),
  toMemberId: field(form, "toMemberId"),
  amountCents: moneyField(form, "amount", "the amount")!,
  date: field(form, "date"),
  note: field(form, "note"),
});

// From the payment page: once it is recorded, the home page shows the
// balance it leaves.
export async function recordPaymentAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, today }) => {
    await recordSettlement(db, me, paymentFields(form), today);
    return "/";
  });
}

// Saving an edit replaces the payment, so the page moves to the new row.
export async function editSettlementAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, today }) => {
    const row = await editSettlement(
      db,
      me,
      field(form, "settlementId"),
      paymentFields(form),
      today,
    );
    return `/payments/${row.id}`;
  });
}

export async function voidSettlementAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(({ me, db }) => voidSettlement(db, me, field(form, "settlementId")));
}

// A business paying a member back for costs paid on a personal account.
export async function repay(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, today }) => {
    await recordReimbursement(
      db,
      me,
      {
        memberId: field(form, "memberId"),
        amountCents: moneyField(form, "amount", "the amount")!,
        date: field(form, "date"),
        accountId: field(form, "accountId"),
        note: field(form, "note"),
      },
      today,
    );
  });
}

export async function voidReimbursementAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(({ me, db }) => voidReimbursement(db, me, field(form, "reimbursementId")));
}

// ---- Import ----------------------------------------------------------------

export type ImportState = ActionState & { preview?: ImportPreview; imported?: number };

const MAX_IMPORT = 900_000;

export async function previewImportAction(_: ImportState, form: FormData): Promise<ImportState> {
  let preview: ImportPreview | undefined;
  const state = await attempt(async ({ me, db, today }) => {
    const text = field(form, "csv");
    if (text.length > MAX_IMPORT) throw new UserError("the file is too large");
    preview = await previewImport(db, me, text, today);
  });
  return { ...state, preview };
}

export async function applyImportAction(_: ImportState, form: FormData): Promise<ImportState> {
  let imported: number | undefined;
  const state = await attempt(async ({ me, db, today }) => {
    const text = field(form, "csv");
    if (text.length > MAX_IMPORT) throw new UserError("the file is too large");
    imported = (await applyImport(db, me, text, today)).rows.length;
  });
  return { ...state, imported };
}

// ---- Devices ---------------------------------------------------------------

export type TokenState = ActionState & { token?: string; name?: string };

// The token goes back to the browser this once; only its hash is kept.
export async function createTokenAction(_: TokenState, form: FormData): Promise<TokenState> {
  let made: { token: string; name: string } | undefined;
  const state = await attempt(async ({ me, db }) => {
    const { token, row } = await createApiToken(db, me, field(form, "name"));
    made = { token, name: row.name };
  });
  return { ...state, ...made };
}

export async function revokeTokenAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(({ me, db }) => revokeApiToken(db, me, field(form, "tokenId")));
}

// ---- Agents ----------------------------------------------------------------

// Like a device token: shown this once, only its hash kept.
export async function createAgentTokenAction(_: TokenState, form: FormData): Promise<TokenState> {
  let made: { token: string; name: string } | undefined;
  const state = await attempt(async ({ me, db }) => {
    const permission = field(form, "permission") === "write" ? "write" : "read";
    const { token, row } = await createMcpToken(db, me, { name: field(form, "name"), permission });
    made = { token, name: row.name };
  });
  return { ...state, ...made };
}

export async function revokeAgentTokenAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(({ me, db }) => revokeMcpToken(db, me, field(form, "tokenId")));
}

export async function addCategoryAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    await addCategory(db, me, field(form, "label"));
  });
}

export async function renameCategoryAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    await renameCategory(db, me, field(form, "slug"), field(form, "label"));
  });
}

export async function removeCategoryAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    await removeCategory(db, me, field(form, "slug"));
  });
}

export async function addAccountAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    await addAccount(db, me, { name: field(form, "name"), lastFour: field(form, "lastFour"), kind: field(form, "kind") });
  });
}

export async function renameAccountAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    await renameAccount(db, me, field(form, "accountId"), { name: field(form, "name"), lastFour: field(form, "lastFour") });
  });
}

export async function setAccountKindAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    await setAccountKind(db, me, field(form, "accountId"), field(form, "kind"));
  });
}

export async function archiveAccountAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    await setAccountArchived(db, me, field(form, "accountId"), true);
  });
}

export async function restoreAccountAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    await setAccountArchived(db, me, field(form, "accountId"), false);
  });
}

export async function cancelInviteAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(({ me, db }) => cancelInvite(db, me, field(form, "memberId")));
}

export async function removeMemberAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    const gone = await removeMember(db, me, field(form, "memberId"));
    // Access is gone either way; a bank that cannot be reached is stopped here.
    await disconnectBanksOf(db, bankRuntime(), me, gone);
  });
}

// Invites a person again and writes to them. The address of this site comes
// from the request, as on the Devices page.
export async function reinviteAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, home }) => {
    await emailInvite(db, me, home.name, await reinvite(db, me, field(form, "memberId"), field(form, "email")));
  });
}

// Adds a person to the group the member is working in, and writes to them.
// Under the local sign-in stand-in nobody accepts an invitation, so there
// the person counts in splits from today.
export async function invitePersonAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, home, today }) => {
    const invited = await invitePerson(
      db,
      me,
      { displayName: field(form, "displayName"), email: field(form, "email") },
      inviteLimits(),
      devAuthEnabled() ? today : null,
    );
    await emailInvite(db, me, home.name, invited);
  });
}

// The invitation is already saved when this runs, so a failure says so.
async function emailInvite(db: Db, me: Member, groupName: string, invited: Member): Promise<void> {
  try {
    await claimInviteEmail(db, me, invited, inviteLimits());
  } catch (e) {
    if (e instanceof UserError) throw new UserError(`the invite is saved, but no email was sent: ${e.message}`);
    throw e;
  }
  try {
    await sendInviteEmail(createMailer(), { to: invited.email, inviterName: me.displayName, groupName, site: await siteAddress() });
  } catch (e) {
    console.error("invite email failed", e);
    throw new UserError("the invite is saved, but the email could not be sent; tell them the address of this site yourself");
  }
}

// ---- Connected banks -------------------------------------------------------

// A token for Plaid's sign-in window, for a new connection or, with
// `connectionId`, to sign in again to one.
export async function bankLinkTokenAction(connectionId?: string): Promise<{ linkToken?: string; error?: string }> {
  const { me, db } = await requireHousehold();
  try {
    return await startLink(db, requireBank(bankRuntime()), me, { connectionId, webhook: webhookUrl() });
  } catch (e) {
    if (e instanceof UserError) return { error: e.message };
    throw e;
  }
}

// Plaid's window finished: keep the login it made.
export async function connectBankAction(publicToken: string, institutionName: string): Promise<ActionState> {
  return attempt(async ({ me, db, today }) => {
    await connectBank(db, requireBank(bankRuntime()), me, { publicToken: String(publicToken), institutionName: String(institutionName ?? "") }, firstSyncFrom(today));
  });
}

export async function relinkBankAction(connectionId: string): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    await finishRelink(db, requireBank(bankRuntime()), me, String(connectionId), new Date());
  });
}

export async function setBankShareAllAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    requireBank(bankRuntime());
    await setShareAll(db, me, field(form, "accountId"), field(form, "on") === "1");
  });
}

export async function disconnectBankAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    await removeBankConnection(db, requireBank(bankRuntime()), me, field(form, "connectionId"));
  });
}

export async function addFromBankAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db, today }) => {
    requireBank(bankRuntime());
    await addFromBank(db, me, field(form, "transactionId"), { category: field(form, "category") || undefined }, today);
  });
}

export async function matchBillAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    requireBank(bankRuntime());
    await matchBill(db, me, field(form, "transactionId"), field(form, "expenseId"));
  });
}

export async function notThisPurchaseAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    requireBank(bankRuntime());
    await notThisPurchase(db, me, field(form, "transactionId"));
  });
}

export async function setAsideBankAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    requireBank(bankRuntime());
    await dismissBankTransaction(db, me, field(form, "transactionId"));
  });
}

export async function restoreBankAction(_: ActionState, form: FormData): Promise<ActionState> {
  return attempt(async ({ me, db }) => {
    requireBank(bankRuntime());
    await restoreBankTransaction(db, me, field(form, "transactionId"));
  });
}
