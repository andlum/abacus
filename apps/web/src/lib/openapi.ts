// The API's description, served at /api/v1/openapi.json. The iOS client (and
// an Android one later) is generated from it, so it must match what the
// routes return: openapi.test.ts calls every route and checks each answer
// against the schema here.
import { ACCOUNT_KINDS, GROUP_KINDS, EXPENSE_SOURCES, EXPENSE_STATUSES, REIMBURSEMENT_STATUSES, RULE_SOURCES, SETTLEMENT_STATUSES } from "../db/schema.ts";

type Schema = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (s: Schema) => ({ ...s, type: [s.type, "null"] });
const object = (properties: Record<string, Schema>, optional: string[] = []): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
  additionalProperties: false,
});
const uuid = { type: "string", format: "uuid" };
const date = { type: "string", format: "date", description: "YYYY-MM-DD" };
const instant = { type: "string", format: "date-time" };
const cents = { type: "integer", description: "Whole cents." };
const centsByMember = { type: "object", additionalProperties: { type: "integer" }, description: "Cents, keyed by member id." };

const json = (schema: Schema) => ({ content: { "application/json": { schema } } });
const ok = (description: string, schema: Schema) => ({ description, ...json(schema) });
const error = (description: string) => ({ description, ...json(ref("Error")) });
const failures = {
  "400": error("The request was refused; `error` says why, in words fit to show the person."),
  "401": error("No token, or a token that is unknown or revoked."),
};
// What the list of all expenses can be asked for; proposals belong to review.
const LISTED_STATUSES = EXPENSE_STATUSES.filter((s) => s !== "proposed" && s !== "rejected");
const idPath = (what: string) => ({ name: "id", in: "path", required: true, schema: uuid, description: `The ${what}'s id.` });

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Clementine API",
    version: "1",
    description:
      "Shared costs for a household. Money is integer cents; dates are YYYY-MM-DD in the household's timezone. " +
      "The server computes every split: clients show `shares` and previews, and never work a split out themselves. " +
      "Sign in with a token made under Settings → Devices, sent as `Authorization: Bearer abk_...`.",
  },
  servers: [{ url: "/api/v1" }],
  security: [{ token: [] }],
  paths: {
    "/me": {
      get: {
        operationId: "getMe",
        summary: "Who the token acts for, their household, its members and its categories",
        responses: { "200": ok("You", ref("Me")), "401": failures["401"] },
      },
    },
    "/balance": {
      get: {
        operationId: "getBalance",
        summary: "Who owes whom, and every expense and payment behind it",
        description:
          "`net`, `owes` and `entries` count posted expenses and recorded payments. In a business group, an expense " +
          "paid from a personal account is left out of them: the business owes it back in full to the member who paid, " +
          "which `owedBack` reports. Its shares are still stored on the expense.",
        responses: { "200": ok("The balance", ref("Balance")), "401": failures["401"] },
      },
    },
    "/attention": {
      get: {
        operationId: "getAttention",
        summary: "Expenses waiting for someone to act",
        responses: { "200": ok("What needs attention", ref("Attention")), "401": failures["401"] },
      },
    },
    "/months/{month}/expenses": {
      get: {
        operationId: "listMonthExpenses",
        summary: "Every expense dated in a month, voided and replaced ones included",
        parameters: [{ name: "month", in: "path", required: true, schema: { type: "string", pattern: "^\\d{4}-\\d{2}$" }, description: "YYYY-MM" }],
        responses: {
          "200": ok("The month", object({ month: { type: "string" }, expenses: { type: "array", items: ref("Expense") } })),
          "401": failures["401"],
          "404": error("Not a month."),
        },
      },
    },
    "/expenses": {
      get: {
        operationId: "listExpenses",
        summary: "Every expense, newest first, a page at a time, narrowed by filters",
        description:
          "Ordered by date, then when each was entered, then id, newest first. Filters combine: an expense must pass all that are given. " +
          "Proposals and the ones turned down are never listed. Pass `nextCursor` back as `cursor` for the next page.",
        parameters: [
          { name: "from", in: "query", required: false, schema: date, description: "Dated on or after this day." },
          { name: "to", in: "query", required: false, schema: date, description: "Dated on or before this day." },
          { name: "category", in: "query", required: false, schema: ref("Category"), description: "Only this category." },
          { name: "payer", in: "query", required: false, schema: uuid, description: "Only those this member paid." },
          { name: "account", in: "query", required: false, schema: { type: "string" }, description: "An account's id, or `none` for expenses with no account." },
          { name: "accountKind", in: "query", required: false, schema: { type: "string", enum: [...ACCOUNT_KINDS] }, description: "Only those paid from an account of this kind. Accounts have a kind in a business group only." },
          { name: "source", in: "query", required: false, schema: { type: "string", enum: [...EXPENSE_SOURCES] }, description: "How the expense came to exist." },
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string", enum: ["live", "all", ...LISTED_STATUSES], default: "live" },
            description: "`live` is every expense that counts (posted, unassigned, needs_amount); `all` adds replaced and voided ones.",
          },
          { name: "minCents", in: "query", required: false, schema: { type: "integer", minimum: 0 }, description: "Of at least this amount." },
          { name: "maxCents", in: "query", required: false, schema: { type: "integer", minimum: 0 }, description: "Of at most this amount." },
          { name: "q", in: "query", required: false, schema: { type: "string", maxLength: 100 }, description: "Text to find in the description, ignoring case." },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 }, description: "How many to return." },
          { name: "cursor", in: "query", required: false, schema: { type: "string" }, description: "The `nextCursor` of the page before." },
        ],
        responses: { "200": ok("The matching expenses", ref("ExpenseList")), ...failures },
      },
      post: {
        operationId: "createExpense",
        summary: "Add a one-time expense",
        description: "Split by the household's rules, or by `rule` for this expense only.",
        requestBody: { required: true, ...json(ref("NewExpense")) },
        responses: { "201": ok("The expense as saved", ref("Expense")), ...failures },
      },
    },
    "/expenses/preview": {
      post: {
        operationId: "previewExpense",
        summary: "What an expense would split to, without saving it",
        requestBody: { required: true, ...json(ref("ExpensePreviewRequest")) },
        responses: { "200": ok("The split it would get", ref("SplitPreview")), ...failures },
      },
    },
    "/expenses/{id}": {
      get: {
        operationId: "getExpense",
        summary: "One expense",
        parameters: [idPath("expense")],
        responses: { "200": ok("The expense", ref("Expense")), "401": failures["401"], "404": error("No such expense in your household.") },
      },
    },
    "/expenses/{id}/void": {
      post: {
        operationId: "voidExpense",
        summary: "Void an expense: it stays in the history and leaves the balance",
        parameters: [idPath("expense")],
        responses: { "200": ok("The voided expense", ref("Expense")), ...failures, "404": error("Not an expense id.") },
      },
    },
    "/settlements": {
      get: {
        operationId: "listSettlements",
        summary: "Payments between members, oldest first, voided ones included",
        responses: {
          "200": ok("The payments", object({ settlements: { type: "array", items: ref("Settlement") } })),
          "401": failures["401"],
        },
      },
      post: {
        operationId: "recordSettlement",
        summary: "Record a payment from one member to another",
        requestBody: { required: true, ...json(ref("NewSettlement")) },
        responses: { "201": ok("The payment as saved", ref("Settlement")), ...failures },
      },
    },
    "/settlements/{id}": {
      put: {
        operationId: "editSettlement",
        summary: "Edit a payment: the old one is voided and kept, and a new one points back at it",
        parameters: [idPath("payment")],
        requestBody: { required: true, ...json(ref("SettlementEdit")) },
        responses: {
          "200": ok("The new payment, whose supersedesId is the old one's id. Saved with nothing changed, the payment as it was.", ref("Settlement")),
          ...failures,
          "404": error("Not a well-formed id. An unknown id, another group's, or one already replaced or voided is refused with 400."),
        },
      },
    },
    "/settlements/{id}/void": {
      post: {
        operationId: "voidSettlement",
        summary: "Void a payment",
        parameters: [idPath("payment")],
        responses: { "200": ok("The voided payment", ref("Settlement")), ...failures, "404": error("Not a well-formed id. An unknown id, another group's, or one already voided is refused with 400.") },
      },
    },
    "/reimbursements": {
      get: {
        operationId: "listReimbursements",
        summary: "A business paying members back, oldest first, voided ones included",
        responses: {
          "200": ok("The repayments", object({ reimbursements: { type: "array", items: ref("Reimbursement") } })),
          "401": failures["401"],
        },
      },
      post: {
        operationId: "recordReimbursement",
        summary: "Record the business paying a member back for costs paid on a personal account",
        description: "Only in a business group. `accountId`, when given, must be one of the group's business accounts in use.",
        requestBody: { required: true, ...json(ref("NewReimbursement")) },
        responses: { "201": ok("The repayment as saved", ref("Reimbursement")), ...failures },
      },
    },
    "/reimbursements/{id}/void": {
      post: {
        operationId: "voidReimbursement",
        summary: "Void a repayment",
        parameters: [idPath("repayment")],
        responses: { "200": ok("The voided repayment", ref("Reimbursement")), ...failures, "404": error("Not a well-formed id. An unknown id, another group's, or one already voided is refused with 400.") },
      },
    },
    "/openapi.json": {
      get: {
        operationId: "getOpenApi",
        summary: "This description",
        security: [],
        responses: { "200": ok("The OpenAPI document", { type: "object" }) },
      },
    },
  },
  components: {
    securitySchemes: { token: { type: "http", scheme: "bearer", description: "A token from Settings → Devices." } },
    schemas: {
      Error: object({ error: { type: "string" } }),
      Member: object({ id: uuid, displayName: { type: "string" } }),
      Me: object({
        me: object({ id: uuid, displayName: { type: "string" }, email: { type: "string" } }),
        household: object({
          id: uuid,
          name: { type: "string" },
          kind: { type: "string", enum: [...GROUP_KINDS], description: "What the group is. A token acts in one group." },
          timezone: { type: "string" },
        }),
        members: { type: "array", items: ref("Member") },
        categories: {
          type: "array",
          items: ref("CategoryChoice"),
          description: "The categories to offer for a new expense. Removed ones are left out, though older expenses may still name them.",
        },
        accounts: {
          type: "array",
          items: ref("Account"),
          description: "The accounts the group pays from, archived ones too, since older expenses may name them. Offer only the ones not archived for a new expense.",
        },
        today: { ...date, description: "Today in the household's timezone." },
      }),
      Account: object({
        id: uuid,
        name: { type: "string" },
        lastFour: nullable({ type: "string", description: "The last four digits of the card or account, when given." }),
        kind: nullable({
          type: "string",
          enum: [...ACCOUNT_KINDS, null],
          description: "In a business group, whether the account is personal or business. Null in a household.",
        }),
        archived: { type: "boolean", description: "No longer offered for a new expense." },
      }),
      Category: {
        type: "string",
        description: "The slug of one of the group's categories, as listed by /me. Each group keeps its own list. Left out, it is `other`.",
      },
      CategoryChoice: object({ slug: ref("Category"), label: { type: "string", description: "What people call it." } }),
      Expense: object({
        id: uuid,
        date,
        description: { type: "string" },
        category: ref("Category"),
        accountId: nullable({ ...uuid, description: "The account it was paid from, as listed by /me. Null when not recorded." }),
        totalCents: nullable({ ...cents, description: "Null while a recurring bill waits for its amount." }),
        payerId: uuid,
        status: { type: "string", enum: [...EXPENSE_STATUSES] },
        source: { type: "string", enum: [...EXPENSE_SOURCES] },
        ruleSource: nullable({ type: "string", enum: [...RULE_SOURCES, null] }),
        unassignedReason: nullable({ type: "string" }),
        templateLineageId: nullable(uuid),
        period: nullable({ type: "string" }),
        supersedesId: nullable(uuid),
        shares: { ...centsByMember, description: "Each member's share in cents; sums to totalCents. Empty unless posted." },
        createdAt: instant,
      }),
      ExpenseList: object({
        expenses: { type: "array", items: ref("Expense") },
        nextCursor: nullable({ type: "string", description: "Pass as `cursor` for the next page; null on the last page." }),
        count: { type: "integer", description: "How many expenses match, beyond this page." },
        totalCents: {
          ...cents,
          description: "The sum of every match that counts (not replaced, not voided, and with an amount), beyond this page.",
        },
      }),
      NewExpense: object(
        {
          description: { type: "string" },
          totalCents: { ...cents, minimum: 1 },
          date: { ...date, description: "Defaults to today; cannot be later than today." },
          category: ref("Category"),
          accountId: nullable({
            ...uuid,
            description: "The account it was paid from, as listed by /me; not an archived one. Null or left out when not recorded.",
          }),
          payerId: { ...uuid, description: "Defaults to you." },
          rule: ref("Rule"),
        },
        ["date", "category", "accountId", "payerId", "rule"],
      ),
      ExpensePreviewRequest: object(
        {
          totalCents: { ...cents, minimum: 1 },
          date: { ...date, description: "Whose rules apply. Defaults to today." },
          category: ref("Category"),
          payerId: { ...uuid, description: "Defaults to you." },
          rule: ref("Rule"),
        },
        ["date", "category", "payerId", "rule"],
      ),
      SplitPreview: {
        oneOf: [
          object({
            ok: { type: "boolean", const: true },
            shares: centsByMember,
            rule: { type: "string", description: "The rule, in words." },
            why: { type: "string", description: "Why this rule applies, in words." },
            isDefault: { type: "boolean", description: "Split by the built-in 50/50 because nothing else applies." },
            ratio: nullable({ type: "string" }),
            leftoverCents: { type: "integer" },
            effect: { type: "string", description: "What it does to the balance, in words." },
          }),
          object({
            ok: { type: "boolean", const: false },
            rule: nullable({ type: "string" }),
            why: { type: "string" },
            reason: { type: "string", description: "The code behind `why`, such as `income_missing`." },
          }),
        ],
      },
      BaseRule: {
        oneOf: [
          object({ kind: { type: "string", const: "even" } }),
          object({ kind: { type: "string", const: "income_proportional" } }),
          object({
            kind: { type: "string", const: "percent" },
            bp: { type: "object", additionalProperties: { type: "integer" }, description: "Basis points keyed by member id; sum to 10000." },
          }),
        ],
      },
      Rule: {
        description: "How to split. Every member id must belong to the household.",
        oneOf: [
          ref("BaseRule"),
          object({
            kind: { type: "string", const: "fixed_plus_remainder" },
            fixedCents: centsByMember,
            remainder: ref("BaseRule"),
          }),
        ],
      },
      Balance: object({
        net: { ...centsByMember, description: "Positive: the household owes this member. Negative: this member owes." },
        owes: { type: "array", items: object({ from: uuid, to: uuid, amountCents: cents }) },
        entries: {
          type: "array",
          items: object({
            kind: { type: "string", enum: ["expense", "settlement"] },
            id: uuid,
            date,
            description: { type: "string" },
            effect: centsByMember,
          }),
        },
        owedBack: ref("OwedBack"),
      }, ["owedBack"]),
      OwedBack: {
        ...object({
          members: {
            type: "array",
            items: object({
              memberId: uuid,
              personalPaidCents: {
                ...cents,
                description: "Costs with an amount (posted, or not split) this member paid on a personal account.",
              },
              repaidCents: { ...cents, description: "Repayments to this member, not voided." },
              owedCents: {
                ...cents,
                description: "What the business owes this member: the first less the second. Negative: the member owes the business.",
              },
            }),
          },
          untaggedCount: { type: "integer", description: "Expenses with an amount (posted, or not split) and no account, which are not counted." },
          untaggedCents: { ...cents, description: "The total of those expenses." },
        }),
        description: "Only in a business group: what the business owes the members who paid its costs with their own money.",
      },
      Attention: object({
        needsAmount: { type: "array", items: ref("Expense") },
        unassigned: { type: "array", items: ref("Expense") },
        onDefault: { type: "array", items: object({ lineageId: uuid, name: { type: "string" }, category: ref("Category") }) },
        count: { type: "integer" },
      }),
      Settlement: object({
        id: uuid,
        fromMemberId: uuid,
        toMemberId: uuid,
        amountCents: cents,
        date,
        note: { type: "string" },
        status: { type: "string", enum: [...SETTLEMENT_STATUSES] },
        supersedesId: nullable({ ...uuid, description: "The payment this one replaced when it was edited. Null when it replaced nothing." }),
        createdAt: instant,
        createdBy: uuid,
      }),
      Reimbursement: object({
        id: uuid,
        memberId: uuid,
        amountCents: cents,
        date,
        accountId: nullable({ ...uuid, description: "The business account it was paid from. Null when not recorded." }),
        note: { type: "string" },
        status: { type: "string", enum: [...REIMBURSEMENT_STATUSES] },
        createdAt: instant,
        createdBy: uuid,
      }),
      NewReimbursement: object(
        {
          memberId: uuid,
          amountCents: { ...cents, minimum: 1 },
          date: { ...date, description: "Defaults to today; cannot be later than today." },
          accountId: nullable({
            ...uuid,
            description: "The business account it was paid from, as listed by /me; not a personal or archived one. Null or left out when not recorded.",
          }),
          note: { type: "string" },
        },
        ["date", "accountId", "note"],
      ),
      NewSettlement: object(
        {
          fromMemberId: uuid,
          toMemberId: uuid,
          amountCents: { ...cents, minimum: 1 },
          date: { ...date, description: "Defaults to today; cannot be later than today." },
          note: { type: "string" },
        },
        ["date", "note"],
      ),
      SettlementEdit: object(
        {
          fromMemberId: uuid,
          toMemberId: uuid,
          amountCents: { ...cents, minimum: 1 },
          date: { ...date, description: "Cannot be later than today." },
          note: { type: "string", description: "Left out, the note is cleared." },
        },
        ["note"],
      ),
    },
  },
} as const;
