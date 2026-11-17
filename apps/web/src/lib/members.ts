import { and, asc, eq } from "drizzle-orm";
import { member, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { UserError } from "@abacus/core/errors";
import { isUuid } from "./ids.ts";


// In a stable order: the split calculation's seeded draw starts from it.
export async function householdMembers(db: Db, householdId: string): Promise<Member[]> {
  return db.select().from(member).where(eq(member.householdId, householdId)).orderBy(asc(member.id));
}

// Whether this person takes part in splits of costs dated `date`
// (see `sharesFrom` in the schema).
export const countsOn = (m: Pick<Member, "sharesFrom">, date: string) => m.sharesFrom !== null && m.sharesFrom <= date;

// The ids of the people a cost dated `date` is split between, in that same order.
export const memberIdsOn = (members: Pick<Member, "id" | "sharesFrom">[], date: string) =>
  members.filter((m) => countsOn(m, date)).map((m) => m.id);

// With `on`, the person must also count on that date: someone invited who
// has not joined cannot pay for a cost or be part of a payment.
export async function requireHouseholdMember(db: Db, householdId: string, memberId: string, what: string, on?: string) {
  // An id that is not a UUID names no one; checked here, not by Postgres.
  if (!isUuid(memberId)) throw new UserError(`${what} must be a member of this household`);
  const [row] = await db
    .select({ id: member.id, sharesFrom: member.sharesFrom })
    .from(member)
    .where(and(eq(member.householdId, householdId), eq(member.id, memberId)));
  if (!row) throw new UserError(`${what} must be a member of this household`);
  if (on !== undefined && !countsOn(row, on)) throw new UserError(`${what} was not part of this group on that date`);
}
