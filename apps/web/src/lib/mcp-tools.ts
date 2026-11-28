// The tools /api/mcp offers an agent. Every token gets the read tools; a
// `write` token also gets add_expense, edit_expense and void_expense, which
// take effect at once, as if its member had done it in the app. Each calls
// the same lib functions the pages and /api/v1 call; nothing here adds up
// money or works out a split. The group and the member come from the token
// (McpContext), never from an argument. No result carries an income: rules
// say their kind, and splits give shares and percentages. Like the pages and
// /api/v1, the tools that read expenses or the balance first post the
// recurring costs that have fallen due.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { UserError } from "@abacus/core/errors";
import { addMonths, isIsoDate, isMonth } from "@abacus/core/dates";
import type { household, Member } from "../db/schema.ts";
import type { Db } from "../db/types.ts";
import { expenseJson, memberJson, memberId, type Body } from "./api.ts";
import { listAttention } from "./attention.ts";
import { getBalance } from "./balance.ts";
import { getOwedBack } from "./owed-back.ts";
import { listAccounts } from "./accounts.ts";
import { listCategories } from "./categories.ts";
import { createExpense, editExpense, getExpense, listMonth, listRange, postDue, voidExpense } from "./expenses.ts";
import { canWrite, type McpTokenListing } from "./mcp-tokens.ts";
import { describeRule } from "./rule-text.ts";
import { listRules } from "./rules.ts";
import { previewSplit } from "./split-preview.ts";

export type McpContext = {
  db: Db;
  me: Member;
  token: McpTokenListing;
  home: typeof household.$inferSelect;
  members: Member[];
  today: string;
  // When this request arrived.
  now: Date;
};

export const MAX_RANGE_DAYS = 366;
export const MAX_LISTED_EXPENSES = 500;
export const MAX_BALANCE_ENTRIES = 100;

const CENTS = "All money is in integer cents (12345 means 123.45 in the group's currency).";
const FIRST = "Call get_context first to learn the group, its members' ids and its categories.";
const POSTS_DUE =
  "Reading first posts any recurring costs that have fallen due, as opening the app does, so they are included.";

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const ok = (out: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(out) }],
  structuredContent: out,
});

const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

// A UserError is meant for the person asking, so its message passes through.
// Anything else may carry internals: it is logged here and answered plainly.
function safely<A>(name: string, run: (args: A) => Promise<Record<string, unknown>>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await run(args));
    } catch (e) {
      if (e instanceof UserError) return fail(e.message);
      console.error(`mcp tool ${name} failed`, e);
      return fail("something went wrong on the server; try again later");
    }
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const totalCents = z
  .number({ error: "totalCents must be a whole number of cents" })
  .int("totalCents must be a whole number of cents")
  .positive("totalCents must be more than zero")
  .max(Number.MAX_SAFE_INTEGER, "totalCents is too large");

const isoDate = (what: string) => z.string().refine(isIsoDate, `${what} must be a date like 2026-01-31`);

// Whole days from one ISO date to another.
const daysBetween = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

export function registerReadTools(server: McpServer, ctx: McpContext) {
  const { db, me, token, home, members, today } = ctx;

  server.registerTool(
    "get_context",
    {
      title: "Group and members",
      description:
        "Call this first. Says which group this token reaches (a household or a business), " +
        "today's date there, who the token acts for, the members with their ids, the categories " +
        "an expense can have, the accounts costs are paid from (in a business group, each personal or business), " +
        "and the split rules, each with the date it applies from. " +
        "Every other tool works in this one group; none takes a group argument. " +
        "If the group or person is not the one you expected, stop: the token belongs to someone else. " +
        CENTS,
      inputSchema: z.strictObject({}),
      annotations: READ_ONLY,
    },
    safely("get_context", async () => ({
      group: { name: home.name, kind: home.kind, timezone: home.timezone },
      today,
      you: memberJson(me),
      token: { name: token.name },
      note: canWrite(token)
        ? "This token can read, and add, edit and void expenses for you. What it writes counts at once."
        : "This token can only read. Expenses are added and changed by people in the Clementine app.",
      members: members.map(memberJson),
      categories: (await listCategories(db, home.id)).map((c) => ({ slug: c.slug, label: c.label, taxLine: c.taxLine, halfDeductible: c.halfDeductible })),
      accounts: (await listAccounts(db, home.id, { archived: true })).map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        archived: a.archivedAt !== null,
      })),
      rules: (await listRules(db, home.id)).map((r) => ({
        scope: r.scope,
        category: r.category,
        templateLineageId: r.templateLineageId,
        effectiveFrom: r.effectiveFrom,
        rule: r.rule,
        text: describeRule(r.rule, members),
      })),
    })),
  );

  server.registerTool(
    "list_expenses",
    {
      title: "Expenses",
      description:
        "Lists the group's expenses in one calendar month (month: \"2026-10\") or between two dates, " +
        "both included (from and to: \"2026-10-01\"), oldest first. Give a month, or from and to, not both. " +
        `A range may span at most ${MAX_RANGE_DAYS} days and return at most ${MAX_LISTED_EXPENSES} expenses. ` +
        "Each expense has its total, payer, status and shares: member id to the cents that member bears, " +
        "and the account it was paid from, with its name and kind, or null when none was recorded. " +
        POSTS_DUE +
        " " +
        CENTS +
        " " +
        FIRST,
      inputSchema: z.strictObject({
        month: z.string().refine(isMonth, "month must be a month like 2026-10").optional(),
        from: isoDate("from").optional(),
        to: isoDate("to").optional(),
      }),
      annotations: READ_ONLY,
    },
    safely("list_expenses", async ({ month, from, to }: { month?: string; from?: string; to?: string }) => {
      // One over the cap is enough to know the cap was passed.
      const opts = { limit: MAX_LISTED_EXPENSES + 1 };
      let rows;
      if (month && !from && !to) {
        from = `${month}-01`;
        to = isoDayBefore(`${addMonths(month, 1)}-01`);
        await postDue(db, home.id, today);
        rows = await listMonth(db, home.id, month, opts);
      } else if (!month && from && to) {
        if (to < from) throw new UserError("from must be on or before to");
        if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
          throw new UserError(`a range can span at most ${MAX_RANGE_DAYS} days; ask for a shorter one`);
        }
        await postDue(db, home.id, today);
        rows = await listRange(db, home.id, from, to, opts);
      } else {
        throw new UserError("give a month, or from and to");
      }
      if (rows.length > MAX_LISTED_EXPENSES) {
        throw new UserError(`that range holds more than ${MAX_LISTED_EXPENSES} expenses; ask for a shorter one`);
      }
      const accounts = new Map((await listAccounts(db, home.id, { archived: true })).map((a) => [a.id, a]));
      const account = (id: string | null) => {
        const a = id ? accounts.get(id) : undefined;
        return a ? { name: a.name, kind: a.kind } : null;
      };
      return {
        from,
        to,
        count: rows.length,
        expenses: rows.map((e) => ({ ...expenseJson(e), account: account(e.accountId) })),
      };
    }),
  );

  server.registerTool(
    "get_balance",
    {
      title: "Balance",
      description:
        "Who owes whom across all posted expenses and settlements. In a business group, an expense paid from a " +
        "personal account is left out of this: the business owes it back to whoever paid, in owedBack. " +
        "net: member id to their position " +
        "(positive means the group owes them, negative means they owe). owes: the payments that would settle " +
        `everything. entries: the ${MAX_BALANCE_ENTRIES} most recent expenses and settlements behind it, newest first, ` +
        "with what each did to every member's position; entryCount is how many there are in all. " +
        "In a business group only, owedBack says what the business owes each member for costs they paid on a " +
        "personal account: personalPaidCents less repaidCents is owedCents (negative: the member owes the business); " +
        "untaggedCount and untaggedCents are how many expenses with an amount (posted, or not split) have no " +
        "account, and their total; they are not counted. " +
        POSTS_DUE +
        " " +
        CENTS +
        " " +
        FIRST,
      inputSchema: z.strictObject({}),
      annotations: READ_ONLY,
    },
    safely("get_balance", async () => {
      await postDue(db, home.id, today);
      const b = await getBalance(db, home.id);
      const owedBack = await getOwedBack(db, home.id);
      return {
        net: b.net,
        owes: b.owes,
        entryCount: b.entries.length,
        entries: b.entries.slice(-MAX_BALANCE_ENTRIES).reverse(),
        ...(owedBack ? { owedBack } : {}),
      };
    }),
  );

  server.registerTool(
    "list_attention",
    {
      title: "Needs attention",
      description:
        "Expenses someone needs to act on: needsAmount are bills waiting for their amount, unassigned are " +
        "expenses whose split could not be worked out (they are not in the balance until fixed). onDefault " +
        "lists recurring costs still split by the built-in 50/50, for information. count is the first two lists together. " +
        "Fixing these is done by a person in the web app. " +
        POSTS_DUE +
        " " +
        CENTS +
        " " +
        FIRST,
      inputSchema: z.strictObject({}),
      annotations: READ_ONLY,
    },
    safely("list_attention", async () => {
      await postDue(db, home.id, today);
      const a = await listAttention(db, home.id, today);
      return {
        needsAmount: a.needsAmount.map(expenseJson),
        unassigned: a.unassigned.map(expenseJson),
        onDefault: a.onDefault,
        count: a.count,
      };
    }),
  );

  server.registerTool(
    "preview_split",
    {
      title: "Preview a split",
      description:
        "The shares the server would post for an expense of totalCents on a date in a category, under the " +
        "group's rules. Saves nothing. Never work a split out yourself; ask this. " +
        "date defaults to today, category to the default category, payerId to the member this token acts for. " +
        "ok: false comes with why the split cannot be worked out. shares sum exactly to totalCents. " +
        CENTS +
        " " +
        FIRST,
      inputSchema: z.strictObject({
        totalCents,
        date: isoDate("date").optional(),
        category: z.string().optional(),
        payerId: z.string().optional(),
      }),
      annotations: READ_ONLY,
    },
    safely("preview_split", async (a: { totalCents: number; date?: string; category?: string; payerId?: string }) =>
      previewSplit(db, home.id, members, {
        totalCents: a.totalCents,
        payerId: memberId(a as Body, "payerId", members, me.id),
        category: a.category ?? "",
        date: a.date ?? today,
      }),
    ),
  );
}

// A resent add_expense within this long of the first is the same expense.
export const RETRY_WINDOW_MS = 2 * 60_000;

const WRITES = { readOnlyHint: false, idempotentHint: false, openWorldHint: false } as const;

const ASK = "Never guess a category or a payer the person did not state: ask them. ";
const REPORT =
  "Tell the person what was written and how it was split (shares: member id to cents). " +
  "status unassigned means the rules could not split it (unassignedReason says why); it does not count until fixed in the app. ";

// The tools that write, only for a `write` token. Each acts as the token's
// member, in that member's group, and is recorded as done through the token.
export function registerWriteTools(server: McpServer, ctx: McpContext) {
  const { db, me, token, home, members, today, now } = ctx;
  // Every request authenticates its token afresh and gets a new server, so a
  // token that cannot write (or was revoked) never has these tools.
  if (!canWrite(token)) return;
  const via = { agentTokenId: token.id };

  server.registerTool(
    "add_expense",
    {
      title: "Add an expense",
      description:
        "Adds an expense to the group now, as the member this token acts for; it counts in the balance at once. " +
        "The server splits it by the group's rules on its date; you never give shares. " +
        "If the person only asks what something would cost them, use preview_split instead, which saves nothing. " +
        "category is a slug and payerId a member id, both from get_context. date defaults to today; " +
        "accountId (optional) is one of get_context's accounts. " +
        "If this token added the same date, amount, description, category and payer in the last 2 minutes, " +
        "nothing is added and that expense comes back with alreadyAdded: true, so a resent call does not count twice; " +
        "for a real second identical purchase, use a different description or wait 2 minutes. " +
        ASK +
        REPORT +
        CENTS,
      inputSchema: z.strictObject({
        description: z.string(),
        totalCents,
        category: z.string(),
        payerId: z.string(),
        date: isoDate("date").optional(),
        accountId: z.string().optional(),
      }),
      annotations: { ...WRITES, destructiveHint: false },
    },
    safely(
      "add_expense",
      async (a: { description: string; totalCents: number; category: string; payerId: string; date?: string; accountId?: string }) => {
        const row = await createExpense(db, home.id, {
          kind: "manual",
          actor: me,
          date: a.date ?? today,
          description: a.description,
          category: a.category,
          totalCents: a.totalCents,
          payerId: memberId(a as Body, "payerId", members),
          accountId: a.accountId ?? null,
          today,
          agentTokenId: via.agentTokenId,
          retrySince: new Date(now.getTime() - RETRY_WINDOW_MS),
        });
        return { expense: expenseJson(row), ...(row.alreadyAdded ? { alreadyAdded: true } : {}) };
      },
    ),
  );

  server.registerTool(
    "edit_expense",
    {
      title: "Edit an expense",
      description:
        "Changes an expense, as the member this token acts for: a posted one, or an unassigned one the rules " +
        "could not split. Give its expenseId (from " +
        "list_expenses) and only the fields to change; the rest stay as they are. The old expense is kept as " +
        "superseded and a new one, with a new id, replaces it and is split again by the rules on its date. " +
        "accountId: null clears the account. " +
        ASK +
        REPORT +
        CENTS,
      inputSchema: z.strictObject({
        expenseId: z.string(),
        description: z.string().optional(),
        totalCents: totalCents.optional(),
        category: z.string().optional(),
        payerId: z.string().optional(),
        date: isoDate("date").optional(),
        accountId: z.string().nullable().optional(),
      }),
      annotations: { ...WRITES, destructiveHint: true },
    },
    safely(
      "edit_expense",
      async (a: {
        expenseId: string;
        description?: string;
        totalCents?: number;
        category?: string;
        payerId?: string;
        date?: string;
        accountId?: string | null;
      }) => {
        const old = await getExpense(db, home.id, a.expenseId);
        if (old.status === "needs_amount") throw new UserError("that bill is waiting for its amount; it is entered in the app");
        const row = await editExpense(
          db,
          me,
          old.id,
          {
            date: a.date ?? old.date,
            description: a.description ?? old.description,
            category: a.category ?? old.category,
            totalCents: a.totalCents ?? old.totalCents!,
            payerId: memberId(a as Body, "payerId", members, old.payerId),
            accountId: a.accountId,
            // A split picked for this one expense stays picked.
            rule: old.chosenRule ?? undefined,
          },
          today,
          via,
        );
        return { replaced: old.id, expense: expenseJson(row) };
      },
    ),
  );

  server.registerTool(
    "void_expense",
    {
      title: "Void an expense",
      description:
        "Removes an expense from the balance, as the member this token acts for. Give its expenseId (from " +
        "list_expenses). It is kept as void in the history, not deleted. Only void what the person asked you to; " +
        "if more than one expense could be meant, ask which.",
      inputSchema: z.strictObject({ expenseId: z.string() }),
      annotations: { ...WRITES, destructiveHint: true },
    },
    safely("void_expense", async (a: { expenseId: string }) => {
      await voidExpense(db, me, a.expenseId, via);
      return { voided: a.expenseId, expense: expenseJson(await getExpense(db, home.id, a.expenseId)) };
    }),
  );
}

function isoDayBefore(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}
