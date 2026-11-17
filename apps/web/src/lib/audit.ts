import { desc, eq } from "drizzle-orm";
import { auditLog, type AuditEntry } from "../db/schema.ts";
import type { Db } from "../db/types.ts";

export type Actor =
  // `tokenId` names the agent token the member acted through, if any.
  | { kind: "member"; memberId: string; tokenId?: string }
  | { kind: "system" };

// Every action the code writes, dotted and past tense. writeAudit takes only
// these, and activity.ts must have words for each (activity.test.ts), so a
// new action is added here and given a sentence in the same change.
export const AUDIT_ACTIONS = [
  "account.added",
  "account.archived",
  "account.kind_changed",
  "account.renamed",
  "account.restored",
  "account.share_all_changed",
  "api_token.created",
  "api_token.revoked",
  "bank_connection.connected",
  "bank_connection.needs_relink",
  "bank_connection.reconnected",
  "bank_connection.removed",
  "bank_transaction.added",
  "bank_transaction.dismissed",
  "bank_transaction.restored",
  "bank_transaction.retied",
  "bank_transaction.tied",
  "bank_transaction.untied",
  "category.added",
  "category.archived",
  "category.removed",
  "category.renamed",
  "category.restored",
  "change_set.accepted",
  "change_set.activated",
  "change_set.proposed",
  "change_set.rejected",
  "change_set.withdrawn",
  "expense.amount_entered",
  "expense.confirmed",
  "expense.correction_confirmed",
  "expense.correction_proposed",
  "expense.correction_rejected",
  "expense.correction_stale",
  "expense.fixed",
  "expense.needs_amount",
  "expense.posted",
  "expense.proposed",
  "expense.rejected",
  "expense.unassigned",
  "expense.void_confirmed",
  "expense.void_proposed",
  "expense.void_rejected",
  "expense.void_stale",
  "expense.voided",
  "expense_template.changed",
  "expense_template.created",
  "household.created",
  "household.provisioned",
  "import.applied",
  "income.changed",
  "income.recorded",
  "income.removed",
  "income.share_mode_changed",
  "income.withdrawn",
  "mcp_token.created",
  "mcp_token.revoked",
  "member.default_group_set",
  "member.invite_cancelled",
  "member.invite_declined",
  "member.invite_emailed",
  "member.invited",
  "member.link_rejected",
  "member.linked",
  "member.removed",
  "reimbursement.recorded",
  "reimbursement.voided",
  "settlement.edited",
  "settlement.recorded",
  "settlement.voided",
  "split_rule.added",
  "split_rule.changed",
  "split_rule.removed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditInput = {
  householdId: string | null;
  actor: Actor;
  action: AuditAction;
  entity?: { type: string; id: string };
  detail?: Record<string, unknown>;
};

// Pass the transaction handle as `db` so the entry commits or rolls back with
// the change it describes.
export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    householdId: input.householdId,
    actorKind: input.actor.kind,
    actorMemberId: input.actor.kind === "system" ? null : input.actor.memberId,
    actorTokenId: input.actor.kind === "member" ? (input.actor.tokenId ?? null) : null,
    action: input.action,
    entityType: input.entity?.type ?? null,
    entityId: input.entity?.id ?? null,
    detail: input.detail ?? {},
  });
}

export async function recentAudit(db: Db, householdId: string, limit: number): Promise<AuditEntry[]> {
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.householdId, householdId))
    .orderBy(desc(auditLog.id))
    .limit(limit);
}
