// Where costs are paid from: the cards and accounts a group names for
// itself. In a business group each is personal or business, so the owner can
// see which costs went on their own card. An account nobody uses any more is
// archived, never deleted: the costs paid from it keep it.
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { account, ACCOUNT_KINDS, expense, expenseTemplate, household, reimbursement, type Account, type AccountKind, type GroupKind, type Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { writeAudit } from "./audit.ts";
import { checkText } from "./text.ts";
import { UserError } from "@abacus/core/errors";
import { isUuid } from "./ids.ts";

export const MAX_ACCOUNT_NAME = 60;

export type AccountInput = { name: string; lastFour?: string | null };

export const KIND_LABELS: Record<AccountKind, string> = { personal: "Personal", business: "Business" };

// "Business card ··4242", or just the name when no digits were given.
export function accountLabel(a: Pick<Account, "name" | "lastFour">): string {
  return a.lastFour ? `${a.name} ··${a.lastFour}` : a.name;
}

// `personal` or `business` from what a form or a file says, ignoring case
// and spaces around it; null when blank or anything else.
export function parseAccountKind(text: string | null | undefined): AccountKind | null {
  const value = (text ?? "").trim().toLowerCase();
  return (ACCOUNT_KINDS as readonly string[]).includes(value) ? (value as AccountKind) : null;
}

// Every run of white space, no-break and wide spaces included, becomes one
// space, so two names that look the same are the same. Used on add, rename
// and import alike.
export function cleanAccountName(text: string): string {
  checkText("account name", text, MAX_ACCOUNT_NAME);
  const name = text.replace(/\s+/gu, " ").trim();
  if (!name) throw new UserError("give the account a name");
  return name;
}

function clean(input: AccountInput) {
  const name = cleanAccountName(input.name);
  const lastFour = (input.lastFour ?? "").trim() || null;
  if (lastFour && !/^[0-9]{4}$/.test(lastFour)) throw new UserError("the last four digits must be exactly four digits");
  return { name, lastFour };
}

// A business group's accounts must say whose money they are; a household's
// have no kind.
function kindFor(groupKind: GroupKind, text: string | null | undefined): AccountKind | null {
  const blank = !(text ?? "").trim();
  if (groupKind === "household") {
    if (!blank) throw new UserError("a household's accounts have no kind; that is only for a business");
    return null;
  }
  const kind = parseAccountKind(text);
  if (!kind) throw new UserError("say whether the account is personal or business");
  return kind;
}

async function groupKind(db: Db, householdId: string): Promise<GroupKind> {
  const [row] = await db.select({ kind: household.kind }).from(household).where(eq(household.id, householdId));
  if (!row) throw new UserError("that group does not exist");
  return row.kind;
}

export type ListAccountsOptions = { archived?: boolean; kind?: AccountKind };

// A group's accounts by name. Archived ones are left out unless asked for;
// with `kind`, only the accounts of that kind.
export async function listAccounts(db: Db, householdId: string, { archived = false, kind }: ListAccountsOptions = {}): Promise<Account[]> {
  const rows = await db
    .select()
    .from(account)
    .where(and(eq(account.householdId, householdId), kind ? eq(account.kind, kind) : undefined))
    .orderBy(asc(sql`lower(${account.name})`), asc(account.createdAt));
  return rows.filter((a) => archived || !a.archivedAt);
}

// With `lock`, holds a share lock on the row until the caller's transaction
// ends, so archiving it (an update) waits, or has already happened and is seen.
// "update" takes the stronger lock, for a change that must wait for those.
async function find(db: Db, householdId: string, id: string, { lock = false }: { lock?: boolean | "update" } = {}): Promise<Account | undefined> {
  if (!isUuid(id)) return undefined;
  const query = db
    .select()
    .from(account)
    .where(and(eq(account.householdId, householdId), eq(account.id, id)))
    .limit(1);
  const [row] = lock === "update" ? await query.for("update") : lock ? await query.for("share") : await query;
  return row;
}

async function mustFind(db: Db, householdId: string, id: string, options: { lock?: boolean | "update" } = {}): Promise<Account> {
  const row = await find(db, householdId, id, options);
  if (!row) throw new UserError("that account is not in this group");
  return row;
}

// The id of the group's account that `text` names, or null when it is
// blank. An archived account is refused unless it is `keep`: the account an
// expense being edited already has, which an edit may leave as it is. An
// account newly attached is locked until `db`, the caller's transaction,
// ends, so it cannot be archived between this check and the save.
export async function toAccountId(
  db: Db,
  householdId: string,
  text: string | null | undefined,
  { keep, archived = false }: { keep?: string | null; archived?: boolean } = {},
): Promise<string | null> {
  const value = (text ?? "").trim().toLowerCase();
  if (!value) return null;
  const row = await find(db, householdId, value, { lock: value !== keep });
  if (!row) throw new UserError("choose an account from the list");
  if (row.archivedAt && !archived && row.id !== keep) {
    throw new UserError(`"${row.name}" is archived; restore it under Settings to use it again`);
  }
  return row.id;
}

// Refuses a name an account in use already has, compared without case. An
// archived account may share it. `except` is the account being renamed or
// restored. Holds a lock for the transaction so two people cannot both take
// a name; the database's unique index is the backstop.
async function nameIsFree(tx: Db, householdId: string, name: string, except?: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"abacus.account." + householdId}))`);
  const [same] = await tx
    .select()
    .from(account)
    .where(
      and(
        eq(account.householdId, householdId),
        isNull(account.archivedAt),
        sql`lower(${account.name}) = lower(${name})`,
        except ? sql`${account.id} <> ${except}` : undefined,
      ),
    )
    .limit(1);
  if (same) throw new UserError(`there is already an account called "${same.name}"`);
}

// Adds an account inside a transaction the caller holds: the import uses it
// to bring back an account a file names. Audited with ids only.
export async function insertAccount(
  tx: Db,
  actor: Member,
  input: AccountInput & { kind?: string | null },
  via: "settings" | "import" = "settings",
): Promise<Account> {
  const { name, lastFour } = clean(input);
  const kind = kindFor(await groupKind(tx, actor.householdId), input.kind);
  await nameIsFree(tx, actor.householdId, name);
  const [row] = await tx
    .insert(account)
    .values({ householdId: actor.householdId, name, lastFour, kind, createdBy: actor.id })
    .returning();
  await writeAudit(tx, {
    householdId: actor.householdId,
    actor: { kind: "member", memberId: actor.id },
    action: "account.added",
    entity: { type: "account", id: row!.id },
    detail: { kind, via },
  });
  return row!;
}

// Adds an account a bank connection reads, inside the connection's
// transaction. The name is the bank's; when the group already uses it, the
// first free " (2)", " (3)" and so on is added. It has no kind, even in a
// business group, until someone sets one. Audited with ids only.
export async function insertBankAccount(
  tx: Db,
  actor: Member,
  input: { name: string; lastFour: string | null; bankConnectionId: string; plaidAccountId: string },
): Promise<Account> {
  const wanted = input.name.replace(/\s+/gu, " ").trim().slice(0, MAX_ACCOUNT_NAME).trim() || "Bank account";
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"abacus.account." + actor.householdId}))`);
  const taken = new Set(
    (await tx
      .select({ name: account.name })
      .from(account)
      .where(and(eq(account.householdId, actor.householdId), isNull(account.archivedAt))))
      .map((a) => a.name.toLowerCase()),
  );
  let name = wanted;
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = `${wanted.slice(0, MAX_ACCOUNT_NAME - suffix.length).trim()}${suffix}`;
  }
  const lastFour = input.lastFour && /^[0-9]{4}$/.test(input.lastFour) ? input.lastFour : null;
  const [row] = await tx
    .insert(account)
    .values({
      householdId: actor.householdId,
      name,
      lastFour,
      createdBy: actor.id,
      // A new card shares nothing until its owner says it is shared.
      cardMode: "personal",
      bankConnectionId: input.bankConnectionId,
      plaidAccountId: input.plaidAccountId,
    })
    .returning();
  await writeAudit(tx, {
    householdId: actor.householdId,
    actor: { kind: "member", memberId: actor.id },
    action: "account.added",
    entity: { type: "account", id: row!.id },
    detail: { kind: null, via: "bank", bankConnectionId: input.bankConnectionId },
  });
  return row!;
}

export async function addAccount(db: Db, actor: Member, input: AccountInput & { kind?: string | null }): Promise<Account> {
  return db.transaction((tx) => insertAccount(tx, actor, input));
}

// Changes an account's name or digits. Costs point at the account's id, so
// they follow the change.
export async function renameAccount(db: Db, actor: Member, id: string, input: AccountInput): Promise<Account> {
  const { name, lastFour } = clean(input);
  return db.transaction(async (tx) => {
    const before = await mustFind(tx, actor.householdId, id);
    const fields = [...(before.lastFour !== lastFour ? ["lastFour"] : []), ...(before.name !== name ? ["name"] : [])];
    if (fields.length === 0) return before;
    if (!before.archivedAt) await nameIsFree(tx, actor.householdId, name, before.id);
    const [row] = await tx.update(account).set({ name, lastFour }).where(eq(account.id, before.id)).returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "account.renamed",
      entity: { type: "account", id: before.id },
      detail: { fields },
    });
    return row!;
  });
}

// Whether any expense (of any status, replaced and voided ones included), any
// version of a recurring cost, or any repayment names the account.
async function inUse(tx: Db, householdId: string, id: string): Promise<boolean> {
  const named = (table: typeof expense | typeof expenseTemplate | typeof reimbursement) =>
    tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.householdId, householdId), eq(table.accountId, id)))
      .limit(1);
  for (const table of [expense, expenseTemplate, reimbursement]) {
    if ((await named(table)).length > 0) return true;
  }
  return false;
}

// Says whose money a business group's account is, until something is paid
// from it. After that the kind is fixed: an expense's kind is its account's,
// and what the business owes its owner (owed-back.ts) is worked out from it,
// so changing it would rewrite what was already counted.
export async function setAccountKind(db: Db, actor: Member, id: string, kindText: string | null): Promise<Account> {
  return db.transaction(async (tx) => {
    // Locked for update: saving an expense or repayment that names the
    // account takes a share lock on it (toAccountId), so the two wait for
    // each other and the check below sees anything saved first.
    const before = await mustFind(tx, actor.householdId, id, { lock: "update" });
    const kind = kindFor(await groupKind(tx, actor.householdId), kindText);
    if (before.kind === kind) return before;
    if (await inUse(tx, actor.householdId, before.id)) {
      throw new UserError("this account is already in use. Archive it and add a new one instead");
    }
    const [row] = await tx.update(account).set({ kind }).where(eq(account.id, before.id)).returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: "account.kind_changed",
      entity: { type: "account", id: before.id },
      detail: { from: before.kind, to: kind },
    });
    return row!;
  });
}

// Archiving takes an account off the pickers; costs paid from it keep it.
// Restoring needs its name to be free among the accounts in use.
export async function setAccountArchived(db: Db, actor: Member, id: string, archived: boolean): Promise<Account> {
  return db.transaction(async (tx) => {
    const before = await mustFind(tx, actor.householdId, id);
    if (Boolean(before.archivedAt) === archived) return before;
    if (!archived) await nameIsFree(tx, actor.householdId, before.name, before.id);
    const [row] = await tx
      .update(account)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(account.id, before.id))
      .returning();
    await writeAudit(tx, {
      householdId: actor.householdId,
      actor: { kind: "member", memberId: actor.id },
      action: archived ? "account.archived" : "account.restored",
      entity: { type: "account", id: before.id },
      detail: {},
    });
    return row!;
  });
}
