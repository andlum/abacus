import { and, eq, inArray } from "drizzle-orm";
import { UserError } from "@abacus/core/errors";
import { household, member, type GroupKind, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";

// A group is a household or a small business: the `household` table's rows.
// A person in several groups has one member row in each (their memberships),
// and works in one group at a time.

export type GroupChoice = { id: string; name: string; kind: GroupKind; isDefault: boolean };

// Which of a person's memberships a request acts as: the group they switched
// to, else their default, else the one they have been in longest.
// `memberships` is oldest first, as resolveMemberships returns it.
export function currentMembership(memberships: Member[], wantedGroupId: string | undefined): Member | null {
  return (
    memberships.find((m) => m.householdId === wantedGroupId) ??
    memberships.find((m) => m.isDefault) ??
    memberships[0] ??
    null
  );
}

// The groups behind a person's memberships, in the same order.
export async function groupsFor(db: Db, memberships: Member[]): Promise<GroupChoice[]> {
  if (memberships.length === 0) return [];
  const rows = await db
    .select()
    .from(household)
    .where(inArray(household.id, memberships.map((m) => m.householdId)));
  return memberships.flatMap((m) => {
    const g = rows.find((r) => r.id === m.householdId);
    return g ? [{ id: g.id, name: g.name, kind: g.kind, isDefault: m.isDefault }] : [];
  });
}

// Makes one of a person's groups the one they land in.
export async function setDefaultGroup(db: Db, memberships: Member[], groupId: string): Promise<void> {
  const chosen = memberships.find((m) => m.householdId === groupId);
  if (!chosen) throw new UserError("you are not in that group");
  if (chosen.isDefault) return;
  await db.transaction(async (tx) => {
    // Unmark first: at most one default per person at any moment.
    await tx
      .update(member)
      .set({ isDefault: false })
      .where(and(inArray(member.id, memberships.map((m) => m.id)), eq(member.isDefault, true)));
    await tx.update(member).set({ isDefault: true }).where(eq(member.id, chosen.id));
    await writeAudit(tx, {
      householdId: chosen.householdId,
      actor: { kind: "member", memberId: chosen.id },
      action: "member.default_group_set",
      entity: { type: "member", id: chosen.id },
    });
  });
}
