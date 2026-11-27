import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Rule, SplitComputation } from "@abacus/core/split";

// What a group is for. The app calls the table's rows "groups"; the table
// keeps the name it had when a household was the only kind.
export const GROUP_KINDS = ["household", "business"] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

export const household = pgTable("household", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind", { enum: GROUP_KINDS }).notNull().default("household"),
  // IANA name. Decides which day it is when a recurring cost falls due.
  timezone: text("timezone").notNull().default("UTC"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A person's place in one group. Someone in three groups has three rows, one
// per group, so everything a group records points at a row of its own. Rows
// are provisioned by email before anyone signs in; a sign-in with that
// verified email links the auth user (membership.ts).
export const member = pgTable(
  "member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    authUserId: text("auth_user_id"),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    // Set when a member withdraws an invitation nobody has taken up: the
    // row stays, since rules and shares name this person, but its email no
    // longer lets anyone in (membership.ts).
    inviteCancelledAt: timestamp("invite_cancelled_at", { withTimezone: true }),
    // The first day this person counts in the group's splits. The people a
    // group starts with count from the beginning. Someone added later has
    // null here until they accept, and then the day they joined: nobody is
    // given a share of costs in a group they have not agreed to be in, and
    // costs dated before they joined stay between the people there then.
    sharesFrom: date("shares_from").default("1970-01-01"),
    // Set when another member takes this person's access away
    // (membership.ts removeMember). The row stays, and they still count in
    // money exactly as before; nothing resolves them as a signed-in member.
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by"),
    // The group this person lands in when they have not picked one.
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("member_email_lowercase", sql`${t.email} = lower(${t.email})`),
    unique("member_household_email").on(t.householdId, t.email),
    unique("member_household_auth_user").on(t.householdId, t.authUserId),
    uniqueIndex("member_one_default").on(t.authUserId).where(sql`${t.isDefault}`),
  ],
);

// Sign-in, kept by Better Auth (src/lib/auth.ts). A person signs up with an
// invited email and a password; `auth_user.id` is what `member.auth_user_id`
// points at once they accept the invitation (membership.ts). The columns are the
// adapter's, under table names that stay out of the way of Postgres's own
// `user`. Timestamps are timestamptz like everywhere else; the adapter passes
// Date values and never looks at the column type.
const authTimestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  ...authTimestamps,
});

export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    ...authTimestamps,
  },
  (t) => [index("auth_session_user_id").on(t.userId)],
);

export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...authTimestamps,
  },
  (t) => [index("auth_account_user_id").on(t.userId)],
);

export const authVerification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...authTimestamps,
  },
  (t) => [index("auth_verification_identifier").on(t.identifier)],
);

// The adapter finds tables by Better Auth's model names.
export const authSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
};

// "mcp_token" is unused: an agent is recorded as its member plus `actor_token_id`; dropping it needs a migration.
export const ACTOR_KINDS = ["member", "system", "mcp_token"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

// Append-only: a trigger (see the append-only migration) rejects UPDATE,
// DELETE and TRUNCATE.
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    householdId: uuid("household_id").references(() => household.id),
    actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
    actorMemberId: uuid("actor_member_id").references(() => member.id),
    // The agent token a member acted through, so two agents working for one
    // person can be told apart. Null for anything done in the web app.
    actorTokenId: uuid("actor_token_id").references((): AnyPgColumn => mcpToken.id),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    check("audit_log_actor_kind", sql`${t.actorKind} in ('member', 'system', 'mcp_token')`),
    check("audit_log_member_actor", sql`${t.actorKind} <> 'member' or ${t.actorMemberId} is not null`),
    index("audit_log_household_at").on(t.householdId, t.at),
    // One thing's history: every entry for the rows in its chain.
    index("audit_log_entity").on(t.householdId, t.entityType, t.entityId),
  ],
);

const cents = (name: string) => bigint(name, { mode: "number" });
const isoDate = (name: string) => date(name, { mode: "string" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const householdRef = () =>
  uuid("household_id")
    .notNull()
    .references(() => household.id);
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

// A renegotiation: proposed incomes and rules that take effect together,
// and only once every member has accepted. Immutable once proposed.
export const CHANGE_SET_STATUSES = ["open", "accepted", "rejected", "withdrawn"] as const;
export const changeSet = pgTable(
  "change_set",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    effectiveFrom: isoDate("effective_from").notNull(),
    reason: text("reason").notNull().default(""),
    status: text("status", { enum: CHANGE_SET_STATUSES }).notNull().default("open"),
    // Frozen on final acceptance: what each person agreed to.
    preview: jsonb("preview").$type<unknown>(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
    // The proposer.
    createdBy: uuid("created_by")
      .notNull()
      .references(() => member.id),
  },
  (t) => [check("change_set_status", sql`${t.status} in (${inList(CHANGE_SET_STATUSES)})`)],
);

export const changeSetAcceptance = pgTable(
  "change_set_acceptance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    changeSetId: uuid("change_set_id")
      .notNull()
      .references(() => changeSet.id),
    memberId: uuid("member_id")
      .notNull()
      .references(() => member.id),
    createdAt: createdAt(),
  },
  (t) => [unique("change_set_acceptance_once").on(t.changeSetId, t.memberId)],
);

// `active` means accepted. Which accepted row applies on a date is decided
// by effective_from, so an older row stays `active` after a newer one lands.
export const PROPOSAL_STATUSES = ["proposed", "active", "rejected", "withdrawn", "void"] as const;
export const SHARE_MODES = ["amount", "ratio_only"] as const;

// Read only through src/lib/incomes.ts, which hides a ratio_only amount from
// the partner.
export const income = pgTable(
  "income",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => member.id),
    annualCents: cents("annual_cents").notNull(),
    // The date it counts from. Chosen when it is saved; an older row still
    // in a change set takes the change set's date.
    effectiveFrom: isoDate("effective_from"),
    shareMode: text("share_mode", { enum: SHARE_MODES }).notNull(),
    status: text("status", { enum: PROPOSAL_STATUSES }).notNull().default("proposed"),
    changeSetId: uuid("change_set_id").references(() => changeSet.id),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => income.id),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    // Set when the income is removed, or replaced by an edit dated on or
    // before it: the row stays, as `void`. `replacedBy` is the edit's row,
    // and is null when the income was removed.
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => member.id),
    replacedBy: uuid("replaced_by").references((): AnyPgColumn => income.id),
    createdAt: createdAt(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => member.id),
  },
  (t) => [
    check("income_status", sql`${t.status} in (${inList(PROPOSAL_STATUSES)})`),
    check("income_share_mode", sql`${t.shareMode} in (${inList(SHARE_MODES)})`),
    check("income_non_negative", sql`${t.annualCents} >= 0`),
    check("income_active_has_date", sql`${t.status} <> 'active' or ${t.effectiveFrom} is not null`),
    index("income_household_owner").on(t.householdId, t.ownerId),
  ],
);

// What a cost is for. Each group keeps its own list, which starts as a short
// one for its kind (seedCategories in lib/categories.ts).
// Costs, recurring costs and rules name a category by its slug, which never
// changes, so a rule for a category cannot miss a cost over a spelling. A
// cost entered without one is `other`, which every group has. Removing a
// category sets `removed_at` and leaves the row, because old costs still
// name it and show its label. Adding the name again brings the row back.
export const DEFAULT_CATEGORY = "other";

export const category = pgTable(
  "category",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    // The column kept the name it had when removing was called archiving.
    removedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    // Null for the ones a group starts with.
    createdBy: uuid("created_by").references(() => member.id),
  },
  (t) => [
    unique("category_household_slug").on(t.householdId, t.slug),
    check("category_slug_shape", sql`${t.slug} ~ '^[a-z0-9]+(_[a-z0-9]+)*$'`),
    check("category_label_present", sql`length(trim(${t.label})) > 0`),
    check("category_other_stays", sql`${t.slug} <> 'other' or ${t.removedAt} is null`),
  ],
);

// A bank login a member connected through Plaid (lib/bank.ts). Its cards
// become accounts that point back at it. Never deleted: removing a
// connection sets `removed_at` and blanks the token, and its accounts stay.
export const BANK_CONNECTION_STATUSES = ["ok", "needs_relink"] as const;
export type BankConnectionStatus = (typeof BANK_CONNECTION_STATUSES)[number];

export const bankConnection = pgTable(
  "bank_connection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    // Who connected it. Only they sort its transactions or change it.
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => member.id),
    // Plaid's id for the login; webhooks name it.
    itemId: text("item_id").notNull(),
    // Plaid's access token, encrypted with ABACUS_ENCRYPTION_KEY
    // (lib/secret-box.ts). Null once the connection is removed.
    accessToken: text("access_token"),
    // Where /transactions/sync left off. Null before the first sync.
    cursor: text("cursor"),
    institutionName: text("institution_name").notNull(),
    // Transactions dated before this are ignored: the day it was connected,
    // in the group's timezone, so connecting does not bring in old history.
    syncFrom: isoDate("sync_from").notNull(),
    status: text("status", { enum: BANK_CONNECTION_STATUSES }).notNull().default("ok"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("bank_connection_item").on(t.itemId),
    // So an account or transaction can only name a connection of its own group.
    unique("bank_connection_household_id").on(t.householdId, t.id),
    check("bank_connection_status", sql`${t.status} in (${inList(BANK_CONNECTION_STATUSES)})`),
    check("bank_connection_token_until_removed", sql`(${t.removedAt} is null) = (${t.accessToken} is not null)`),
  ],
);

// Whose money an account is. Only a business group sets it: a cost paid
// from a personal card is one the business owes its owner back. A household
// group's accounts have no kind.
export const ACCOUNT_KINDS = ["personal", "business"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const CARD_MODES = ["shared", "personal"] as const;
export type CardMode = (typeof CARD_MODES)[number];

// Where a cost was paid from: a credit card, a bank account, cash. Named by
// the group; one nobody uses any more is archived, not deleted, and the
// costs paid from it keep it.
export const account = pgTable(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    name: text("name").notNull(),
    // The last four digits of the card or account, to tell two apart. Never
    // the whole number.
    lastFour: text("last_four"),
    kind: text("kind", { enum: ACCOUNT_KINDS }),
    // Set on a card that came from a bank connection, with Plaid's id for
    // it. Kept after the connection is removed, for history.
    bankConnectionId: uuid("bank_connection_id"),
    plaidAccountId: text("plaid_account_id"),
    // "Everything on this card is shared": each new transaction becomes an
    // expense at once. Kept for cards that had it on before card review;
    // the switch is no longer offered, only turned off.
    shareAll: boolean("share_all").notNull().default(false),
    // For a card from a bank connection: `shared`, whose payments become a
    // shared expense, or `personal`, whose payments are only recorded.
    // Purchases get in only through a review (lib/card-review.ts). Null for
    // an account that is not from a bank. A change applies to payments
    // that post from then on.
    cardMode: text("card_mode", { enum: CARD_MODES }),
    // The last day a personal card was reviewed to. Null until the first.
    reviewedThrough: isoDate("reviewed_through"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => member.id),
  },
  (t) => [
    // So a cost can only name an account of its own group.
    unique("account_household_id").on(t.householdId, t.id),
    foreignKey({
      name: "account_bank_connection_fk",
      columns: [t.householdId, t.bankConnectionId],
      foreignColumns: [bankConnection.householdId, bankConnection.id],
    }),
    unique("account_plaid_account").on(t.bankConnectionId, t.plaidAccountId),
    check("account_bank_link", sql`(${t.bankConnectionId} is null) = (${t.plaidAccountId} is null)`),
    // Two accounts in use cannot read the same in a picker. An archived one
    // may share a name with one in use; it cannot be restored until the
    // name is free.
    uniqueIndex("account_live_name")
      .on(t.householdId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    check("account_name_present", sql`length(trim(${t.name})) > 0`),
    check("account_last_four", sql`${t.lastFour} is null or ${t.lastFour} ~ '^[0-9]{4}$'`),
    check("account_kind", sql`${t.kind} is null or ${t.kind} in (${inList(ACCOUNT_KINDS)})`),
    check("account_card_mode", sql`${t.cardMode} is null or ${t.cardMode} in (${inList(CARD_MODES)})`),
    check("account_card_mode_bank", sql`${t.cardMode} is null or ${t.bankConnectionId} is not null`),
  ],
);

export const CADENCES = ["monthly", "quarterly", "half_yearly", "yearly"] as const;
export type Cadence = (typeof CADENCES)[number];
export const TEMPLATE_STATUSES = ["active", "superseded"] as const;

// A recurring cost. Every edit is a new row with the same lineage_id; which
// version applies on a date is decided by effective_from.
export const expenseTemplate = pgTable(
  "expense_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    lineageId: uuid("lineage_id").notNull(),
    name: text("name").notNull(),
    category: text("category").notNull().default(DEFAULT_CATEGORY),
    // Null for a variable cost such as utilities.
    amountCents: cents("amount_cents"),
    cadence: text("cadence", { enum: CADENCES }).notNull(),
    dayOfMonth: integer("day_of_month").notNull(),
    // Every cadence but monthly: a month it falls in, 1 to 12. A quarterly
    // cost falls every 3 months counted from it, a half-yearly one every 6.
    monthOfYear: integer("month_of_year"),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => member.id),
    // Where each bill is paid from, when the group says. Copied onto the
    // expenses it posts.
    accountId: uuid("account_id"),
    startDate: isoDate("start_date").notNull(),
    endDate: isoDate("end_date"),
    effectiveFrom: isoDate("effective_from").notNull(),
    status: text("status", { enum: TEMPLATE_STATUSES }).notNull().default("active"),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => expenseTemplate.id),
    createdAt: createdAt(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => member.id),
  },
  (t) => [
    foreignKey({
      name: "expense_template_category_fk",
      columns: [t.householdId, t.category],
      foreignColumns: [category.householdId, category.slug],
    }),
    foreignKey({
      name: "expense_template_account_fk",
      columns: [t.householdId, t.accountId],
      foreignColumns: [account.householdId, account.id],
    }),
    check("expense_template_cadence", sql`${t.cadence} in (${inList(CADENCES)})`),
    check("expense_template_status", sql`${t.status} in (${inList(TEMPLATE_STATUSES)})`),
    check("expense_template_day", sql`${t.dayOfMonth} between 1 and 31`),
    check(
      "expense_template_month",
      sql`(${t.cadence} <> 'monthly' and ${t.monthOfYear} between 1 and 12) or (${t.cadence} = 'monthly' and ${t.monthOfYear} is null)`,
    ),
    check("expense_template_amount", sql`${t.amountCents} is null or ${t.amountCents} > 0`),
    index("expense_template_lineage").on(t.householdId, t.lineageId),
  ],
);

export const RULE_SCOPES = ["template", "category", "household"] as const;

export const splitRule = pgTable(
  "split_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    scope: text("scope", { enum: RULE_SCOPES }).notNull(),
    // An expense_template lineage_id.
    templateLineageId: uuid("template_lineage_id"),
    category: text("category"),
    rule: jsonb("rule").$type<Rule>().notNull(),
    effectiveFrom: isoDate("effective_from").notNull(),
    status: text("status", { enum: PROPOSAL_STATUSES }).notNull().default("proposed"),
    // Set only on rules from before rules counted at once (migration 0021).
    changeSetId: uuid("change_set_id").references(() => changeSet.id),
    // The row this one changed, when it is an edit.
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => splitRule.id),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    // Set when the rule is removed, or replaced by an edit dated on or
    // before it: the row stays, as `void`. `replacedBy` is the edit's row,
    // and is null when the rule was removed.
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => member.id),
    replacedBy: uuid("replaced_by").references((): AnyPgColumn => splitRule.id),
    createdAt: createdAt(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => member.id),
  },
  (t) => [
    foreignKey({
      name: "split_rule_category_fk",
      columns: [t.householdId, t.category],
      foreignColumns: [category.householdId, category.slug],
    }),
    check("split_rule_status", sql`${t.status} in (${inList(PROPOSAL_STATUSES)})`),
    check(
      "split_rule_one_scope",
      sql`(${t.scope} = 'template' and ${t.templateLineageId} is not null and ${t.category} is null)
        or (${t.scope} = 'category' and ${t.templateLineageId} is null and ${t.category} is not null)
        or (${t.scope} = 'household' and ${t.templateLineageId} is null and ${t.category} is null)`,
    ),
    index("split_rule_household").on(t.householdId, t.status),
  ],
);

export const importBatch = pgTable("import_batch", {
  id: uuid("id").primaryKey().defaultRandom(),
  householdId: householdRef(),
  fileHash: text("file_hash").notNull(),
  rowCount: integer("row_count").notNull(),
  createdAt: createdAt(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => member.id),
});

// `proposed` is an expense an agent asked for that nobody has confirmed yet,
// and `rejected` is one that was turned down. Neither counts anywhere: every
// total reads `posted` only.
export const EXPENSE_STATUSES = ["posted", "unassigned", "needs_amount", "superseded", "void", "proposed", "rejected"] as const;
// `agent` stays on an expense after it is confirmed, so it is always clear
// that a person did not type it. `bank` came from a connected card
// (lib/bank.ts). `card_payment` is the payment to a shared card
// (lib/card-review.ts).
export const EXPENSE_SOURCES = ["template", "manual", "import", "agent", "bank", "card_payment"] as const;
// Where the rule came from: a rule for this recurring cost, for its
// category, the household's own default, the built-in 50/50, or a split
// chosen by the person entering the expense.
export const RULE_SOURCES = ["template", "category", "household", "default", "entry"] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

// What is stored with each expense so its shares can be re-derived from the
// row alone. Holds income row ids, never income amounts.
export type ExpenseComputation = SplitComputation & {
  ruleSource: RuleSource;
  ruleId: string | null;
  // The date whose rules and incomes were used.
  rulesAsOf: string;
  incomeIds?: Record<string, string>;
  chosenBy?: string;
};

export const expense = pgTable(
  "expense",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    templateId: uuid("template_id").references(() => expenseTemplate.id),
    templateLineageId: uuid("template_lineage_id"),
    // "YYYY-MM" for a monthly cost, "YYYY" for a yearly one.
    period: text("period"),
    date: isoDate("date").notNull(),
    description: text("description").notNull(),
    category: text("category").notNull().default(DEFAULT_CATEGORY),
    // Where it was paid from, when the group says. Its kind is the
    // account's kind; nothing is copied.
    accountId: uuid("account_id"),
    // Null only while a variable bill is waiting for its amount.
    totalCents: cents("total_cents"),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => member.id),
    ruleSource: text("rule_source", { enum: RULE_SOURCES }),
    status: text("status", { enum: EXPENSE_STATUSES }).notNull(),
    source: text("source", { enum: EXPENSE_SOURCES }).notNull(),
    computation: jsonb("computation").$type<ExpenseComputation>(),
    // Why the split could not be computed, when status is unassigned.
    unassignedReason: text("unassigned_reason"),
    // A split chosen at entry, kept so an unassigned expense can be retried.
    chosenRule: jsonb("chosen_rule").$type<Rule>(),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => expense.id),
    importBatchId: uuid("import_batch_id").references(() => importBatch.id),
    // The agent call that proposed it, when it came through a propose tool.
    proposalRequestId: uuid("proposal_request_id").references((): AnyPgColumn => proposalRequest.id),
    createdAt: createdAt(),
    // Null when the system posted it on its due date.
    createdBy: uuid("created_by").references(() => member.id),
  },
  (t) => [
    // So a bank transaction can only name an expense of its own group.
    unique("expense_household_id").on(t.householdId, t.id),
    foreignKey({
      name: "expense_category_fk",
      columns: [t.householdId, t.category],
      foreignColumns: [category.householdId, category.slug],
    }),
    foreignKey({
      name: "expense_account_fk",
      columns: [t.householdId, t.accountId],
      foreignColumns: [account.householdId, account.id],
    }),
    check("expense_status", sql`${t.status} in (${inList(EXPENSE_STATUSES)})`),
    check("expense_source", sql`${t.source} in (${inList(EXPENSE_SOURCES)})`),
    check("expense_total", sql`${t.totalCents} is null or ${t.totalCents} > 0`),
    check("expense_total_present", sql`${t.status} = 'needs_amount' or ${t.totalCents} is not null`),
    check("expense_template_period", sql`(${t.templateLineageId} is null) = (${t.period} is null)`),
    // One live expense per recurring cost per period: makes posting safe to repeat.
    uniqueIndex("expense_one_live_per_period")
      .on(t.templateLineageId, t.period)
      .where(sql`${t.status} in ('posted', 'unassigned', 'needs_amount')`),
    // The list of all expenses, newest first, and its cursor: one index scan.
    // Also serves every lookup by group and date, as its first two columns.
    index("expense_household_order").on(t.householdId, t.date, t.createdAt, t.id),
    // Retries and the review queue find a request's proposals by it.
    index("expense_proposal_request").on(t.proposalRequestId).where(sql`${t.proposalRequestId} is not null`),
    // For listing a group's costs by the account they were paid from.
    index("expense_household_account").on(t.householdId, t.accountId).where(sql`${t.accountId} is not null`),
  ],
);

// A trigger (see the shares-sum migration) rejects a posted expense whose
// shares do not sum to its total.
export const expenseShare = pgTable(
  "expense_share",
  {
    expenseId: uuid("expense_id")
      .notNull()
      .references(() => expense.id),
    memberId: uuid("member_id")
      .notNull()
      .references(() => member.id),
    householdId: householdRef(),
    shareCents: cents("share_cents").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.expenseId, t.memberId] }),
    check("expense_share_non_negative", sql`${t.shareCents} >= 0`),
  ],
);

// A card transaction a bank connection brought in (lib/bank.ts). Only posted
// ones are stored; a charge still pending at the bank waits until it posts.
// `to_sort` waits for the connection's owner, who adds it as an expense or
// dismisses it; on a card whose account shares everything it is `added` at
// once. `removed` is one the bank withdrew before anyone sorted it.
export const BANK_TRANSACTION_STATES = ["to_sort", "added", "dismissed", "removed"] as const;
export type BankTransactionState = (typeof BANK_TRANSACTION_STATES)[number];

export const bankTransaction = pgTable(
  "bank_transaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    connectionId: uuid("connection_id").notNull(),
    accountId: uuid("account_id").notNull(),
    // Plaid's id. Unique, so a transaction is never brought in twice.
    plaidTransactionId: text("plaid_transaction_id").notNull(),
    date: isoDate("date").notNull(),
    // Positive is money spent, as Plaid has it; negative is money in, such
    // as a refund.
    amountCents: cents("amount_cents").notNull(),
    description: text("description").notNull(),
    state: text("state", { enum: BANK_TRANSACTION_STATES }).notNull().default("to_sort"),
    // The expense it became, once added.
    expenseId: uuid("expense_id"),
    // Who added or dismissed it, and when. `sorted_by` is null when a shared
    // card's transaction was added by itself.
    sortedBy: uuid("sorted_by").references(() => member.id),
    sortedAt: timestamp("sorted_at", { withTimezone: true }),
    // Set when its owner said a recurring cost it was tied to is not this
    // purchase: it is never tied automatically again (lib/bank-match.ts).
    noAutoTie: boolean("no_auto_tie").notNull().default(false),
    // The shared card payment this purchase was taken out of in a review.
    // A trigger (see the card review migration) keeps the purchases taken
    // out of one payment from adding up to more than it.
    cardPaymentId: uuid("card_payment_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("bank_transaction_plaid_id").on(t.plaidTransactionId),
    foreignKey({
      name: "bank_transaction_card_payment_fk",
      columns: [t.householdId, t.cardPaymentId],
      foreignColumns: [cardPayment.householdId, cardPayment.id],
    }),
    check("bank_transaction_card_payment", sql`${t.cardPaymentId} is null or ${t.state} = 'added'`),
    foreignKey({
      name: "bank_transaction_connection_fk",
      columns: [t.householdId, t.connectionId],
      foreignColumns: [bankConnection.householdId, bankConnection.id],
    }),
    foreignKey({
      name: "bank_transaction_account_fk",
      columns: [t.householdId, t.accountId],
      foreignColumns: [account.householdId, account.id],
    }),
    foreignKey({
      name: "bank_transaction_expense_fk",
      columns: [t.householdId, t.expenseId],
      foreignColumns: [expense.householdId, expense.id],
    }),
    check("bank_transaction_state", sql`${t.state} in (${inList(BANK_TRANSACTION_STATES)})`),
    check("bank_transaction_amount", sql`${t.amountCents} <> 0`),
    check("bank_transaction_expense", sql`(${t.state} = 'added') = (${t.expenseId} is not null)`),
    check("bank_transaction_spent", sql`${t.expenseId} is null or ${t.amountCents} > 0`),
    // A recurring expense is tied to at most one purchase.
    uniqueIndex("bank_transaction_one_tie").on(t.expenseId).where(sql`${t.state} = 'added'`),
    // To sort, for each connection.
    index("bank_transaction_waiting").on(t.connectionId, t.date).where(sql`${t.state} = 'to_sort'`),
  ],
);

// A payment to a connected card, recorded when it posts (lib/bank.ts). On a
// shared card it becomes an expense; on a personal card it is only shown on
// the card's page. The amount paid never changes. `expense_id` is the live
// expense holding what is still shared: it moves to the new row each time
// that expense is superseded, and is null on a personal card and once the
// expense is voided.
export const cardPayment = pgTable(
  "card_payment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    accountId: uuid("account_id").notNull(),
    plaidTransactionId: text("plaid_transaction_id").notNull(),
    date: isoDate("date").notNull(),
    amountCents: cents("amount_cents").notNull(),
    // The card's mode when the payment posted.
    mode: text("mode", { enum: CARD_MODES }).notNull(),
    expenseId: uuid("expense_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("card_payment_household_id").on(t.householdId, t.id),
    unique("card_payment_plaid_id").on(t.plaidTransactionId),
    foreignKey({
      name: "card_payment_account_fk",
      columns: [t.householdId, t.accountId],
      foreignColumns: [account.householdId, account.id],
    }),
    foreignKey({
      name: "card_payment_expense_fk",
      columns: [t.householdId, t.expenseId],
      foreignColumns: [expense.householdId, expense.id],
    }),
    check("card_payment_amount", sql`${t.amountCents} > 0`),
    check("card_payment_mode", sql`${t.mode} in (${inList(CARD_MODES)})`),
    check("card_payment_personal", sql`${t.mode} = 'shared' or ${t.expenseId} is null`),
    uniqueIndex("card_payment_expense").on(t.expenseId).where(sql`${t.expenseId} is not null`),
    index("card_payment_account_date").on(t.accountId, t.date),
  ],
);

export const SETTLEMENT_STATUSES = ["recorded", "void"] as const;

export const settlement = pgTable(
  "settlement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    fromMemberId: uuid("from_member_id")
      .notNull()
      .references(() => member.id),
    toMemberId: uuid("to_member_id")
      .notNull()
      .references(() => member.id),
    amountCents: cents("amount_cents").notNull(),
    date: isoDate("date").notNull(),
    note: text("note").notNull().default(""),
    status: text("status", { enum: SETTLEMENT_STATUSES }).notNull().default("recorded"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => member.id),
    // The payment this one replaced when it was edited; that row is voided.
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => settlement.id),
    createdAt: createdAt(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => member.id),
  },
  (t) => [
    // A payment is replaced once: two edits of it cannot both stand.
    uniqueIndex("settlement_supersedes").on(t.supersedesId),
    check("settlement_status", sql`${t.status} in (${inList(SETTLEMENT_STATUSES)})`),
    check("settlement_positive", sql`${t.amountCents} > 0`),
    check("settlement_two_people", sql`${t.fromMemberId} <> ${t.toMemberId}`),
  ],
);

export const REIMBURSEMENT_STATUSES = ["recorded", "void"] as const;

// A business paying a member back for costs they paid on a personal
// account. A business is not a member, so a settlement cannot say it.
export const reimbursement = pgTable(
  "reimbursement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    // Who was repaid.
    memberId: uuid("member_id")
      .notNull()
      .references(() => member.id),
    amountCents: cents("amount_cents").notNull(),
    date: isoDate("date").notNull(),
    note: text("note").notNull().default(""),
    // The business account it was paid from, when the group says.
    accountId: uuid("account_id"),
    status: text("status", { enum: REIMBURSEMENT_STATUSES }).notNull().default("recorded"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => member.id),
    createdAt: createdAt(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => member.id),
  },
  (t) => [
    foreignKey({
      name: "reimbursement_account_fk",
      columns: [t.householdId, t.accountId],
      foreignColumns: [account.householdId, account.id],
    }),
    check("reimbursement_status", sql`${t.status} in (${inList(REIMBURSEMENT_STATUSES)})`),
    check("reimbursement_positive", sql`${t.amountCents} > 0`),
    // What each member has been repaid.
    index("reimbursement_household_member").on(t.householdId, t.memberId).where(sql`${t.status} = 'recorded'`),
  ],
);

export type Household = typeof household.$inferSelect;
export type Member = typeof member.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
export type ChangeSet = typeof changeSet.$inferSelect;
export type Income = typeof income.$inferSelect;
export type Category = typeof category.$inferSelect;
export type Account = typeof account.$inferSelect;
export type ExpenseTemplate = typeof expenseTemplate.$inferSelect;
export type SplitRule = typeof splitRule.$inferSelect;
export type Expense = typeof expense.$inferSelect;
export type ExpenseShare = typeof expenseShare.$inferSelect;
export type Settlement = typeof settlement.$inferSelect;
export type Reimbursement = typeof reimbursement.$inferSelect;
export type BankConnection = typeof bankConnection.$inferSelect;
export type BankTransaction = typeof bankTransaction.$inferSelect;
export type CardPayment = typeof cardPayment.$inferSelect;

// A credential for the API: a phone app, or a script a self-hoster runs. It
// acts as its member with that member's full rights, so it is not for agents;
// MCP gets its own tokens, limited to proposals. Only a hash is stored, and a
// revoked token is kept, marked, rather than deleted.
export const apiToken = pgTable("api_token", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id")
    .notNull()
    .references(() => member.id),
  householdId: householdRef(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: createdAt(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export type ApiToken = typeof apiToken.$inferSelect;

// Tokens an agent uses. Each reaches one member's group only, and acts with
// the permission it was made with: `read`, or `write` (read, and add, edit
// and void expenses as its member). `propose` is from when agents proposed
// and a person confirmed; those tokens only read now.
export const MCP_TOKEN_PERMISSIONS = ["read", "propose", "write"] as const;
export type McpTokenPermission = (typeof MCP_TOKEN_PERMISSIONS)[number];

export const mcpToken = pgTable(
  "mcp_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => member.id),
    householdId: householdRef(),
    name: text("name").notNull(),
    permission: text("permission", { enum: MCP_TOKEN_PERMISSIONS }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [check("mcp_token_permission", sql`${t.permission} in (${inList(MCP_TOKEN_PERMISSIONS)})`)],
);

export type McpToken = typeof mcpToken.$inferSelect;

// One call to a propose tool, kept so a retry with the same idempotency key
// returns what the first call made instead of proposing it again. The key
// belongs to the token: two tokens may use the same one. `request_hash` is
// the SHA-256 of the call's arguments without the key, so the same key with
// different arguments is refused.
export const proposalRequest = pgTable(
  "proposal_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mcpTokenId: uuid("mcp_token_id")
      .notNull()
      .references(() => mcpToken.id),
    householdId: householdRef(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => member.id),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("proposal_request_key_once").on(t.mcpTokenId, t.idempotencyKey)],
);

export type ProposalRequest = typeof proposalRequest.$inferSelect;

// An agent's request to correct or void an expense that already counts, from
// before agents could only read; nothing writes these now, and old rows stay
// for the audit log. It changed nothing by itself: the member confirmed it,
// and only then was the expense superseded or voided. A correction
// holds all five values it asks for, not just the ones that differ, so the
// row alone says what was asked. `stale` means the expense had changed by
// the time someone tried to confirm it, so nothing was done.
export const EXPENSE_CHANGE_KINDS = ["correction", "void"] as const;
export type ExpenseChangeKind = (typeof EXPENSE_CHANGE_KINDS)[number];
export const EXPENSE_CHANGE_STATUSES = ["proposed", "confirmed", "rejected", "stale"] as const;
export type ExpenseChangeStatus = (typeof EXPENSE_CHANGE_STATUSES)[number];

export const expenseChange = pgTable(
  "expense_change",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: householdRef(),
    // Who the agent works for: the only one who can confirm or reject it.
    memberId: uuid("member_id")
      .notNull()
      .references(() => member.id),
    expenseId: uuid("expense_id")
      .notNull()
      .references(() => expense.id),
    kind: text("kind", { enum: EXPENSE_CHANGE_KINDS }).notNull(),
    date: isoDate("date"),
    description: text("description"),
    category: text("category"),
    totalCents: cents("total_cents"),
    payerId: uuid("payer_id").references(() => member.id),
    reason: text("reason"),
    status: text("status", { enum: EXPENSE_CHANGE_STATUSES }).notNull().default("proposed"),
    proposalRequestId: uuid("proposal_request_id")
      .notNull()
      .references(() => proposalRequest.id),
    // The expense a confirmed correction entered in place of the old one.
    resultExpenseId: uuid("result_expense_id").references(() => expense.id),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: uuid("decided_by").references(() => member.id),
  },
  (t) => [
    foreignKey({
      name: "expense_change_category_fk",
      columns: [t.householdId, t.category],
      foreignColumns: [category.householdId, category.slug],
    }),
    check("expense_change_kind", sql`${t.kind} in (${inList(EXPENSE_CHANGE_KINDS)})`),
    check("expense_change_status", sql`${t.status} in (${inList(EXPENSE_CHANGE_STATUSES)})`),
    check(
      "expense_change_correction_values",
      sql`${t.kind} <> 'correction' or (${t.date} is not null and ${t.description} is not null and ${t.category} is not null and ${t.totalCents} is not null and ${t.payerId} is not null)`,
    ),
    check(
      "expense_change_void_values",
      sql`${t.kind} <> 'void' or (${t.reason} is not null and ${t.date} is null and ${t.description} is null and ${t.category} is null and ${t.totalCents} is null and ${t.payerId} is null)`,
    ),
    check("expense_change_total", sql`${t.totalCents} is null or ${t.totalCents} > 0`),
    check("expense_change_reason_length", sql`${t.reason} is null or length(${t.reason}) <= 500`),
    check("expense_change_decided", sql`(${t.status} = 'proposed') = (${t.decidedAt} is null)`),
    check("expense_change_result", sql`${t.resultExpenseId} is null or (${t.kind} = 'correction' and ${t.status} = 'confirmed')`),
    // The review queue and the cap on waiting proposals read these.
    index("expense_change_waiting").on(t.householdId, t.memberId).where(sql`${t.status} = 'proposed'`),
    // At most one waiting change per expense per member.
    uniqueIndex("expense_change_one_waiting").on(t.expenseId, t.memberId).where(sql`${t.status} = 'proposed'`),
    index("expense_change_request").on(t.proposalRequestId),
  ],
);

export type ExpenseChange = typeof expenseChange.$inferSelect;

// One row per UTC day for the operator's daily email (src/lib/ops-report.ts).
// The row is claimed before the mail goes out, so two machines running the
// daily job send one email between them; sent_at stays empty if sending
// failed, and the claim can be taken again after a while.
export const opsReport = pgTable("ops_report", {
  day: date("day").primaryKey(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  counts: jsonb("counts").$type<Record<string, number>>(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export type OpsReport = typeof opsReport.$inferSelect;
