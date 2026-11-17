# MCP server

`/api/mcp` lets an agent (Claude Code, a custom script) read a group's
expenses and balance, and, with a write token, add, edit and void expenses
for its member. Someone can type an expense into the app or just tell their
agent about it. Tokens are made and revoked under Settings → Agents
(`src/lib/mcp-tokens.ts`); the server is `src/lib/mcp.ts`, its tools
`src/lib/mcp-tools.ts`.

An agent's write takes effect at once, like the same change made in the web
app: there is no proposal or confirm step. Activity and the expense's page
say it came through the agent ("Alex's agent added this expense").

Agents could once propose expenses, corrections and voids for a person to
confirm. That was removed. Expenses left from then stay in the table as
`proposed` (never confirmed) or `rejected`; they never count in a balance, a
month, an export or the attention lists, and no tool shows them. The tables
`proposal_request` and `expense_change` are kept for the audit log, which
points at them, and nothing writes to them.

## How a token is scoped

A person in two groups has two `member` rows, one per group. An agent token is
tied to one `member` row, so it can only reach that row's group.

1. In Settings, while working in the business group, Alex makes an agent token
   named "Business expenses agent".
2. The token (`abm_` followed by 43 characters) is shown once. Only its
   SHA-256 is stored, as with `api_token`.
3. The agent connects to `/api/mcp` with `Authorization: Bearer abm_...`.
4. The server reads the group from the token on every call. No tool takes a
   group argument.

Agent tokens are their own table, `mcp_token`, not rows in `api_token`. An
`api_token` acts with its member's full rights, and an `abk_` token is never
accepted at `/api/mcp`, nor an `abm_` token at `/api/v1`.

| Column | Meaning |
| --- | --- |
| `id` | uuid |
| `member_id` | the member the token acts for |
| `household_id` | that member's group |
| `name` | what the person called it |
| `permission` | `read` (the default) or `write`, chosen when the token is made: the box "Can add, change and remove expenses". A `propose` token made before agents lost their proposals still works, and only reads. |
| `token_hash` | SHA-256 of the token, unique |
| `created_at` | |
| `last_used_at` | shown in Settings |
| `revoked_at` | a revoked token is kept, marked |

## Tools

| Tool | Returns |
| --- | --- |
| `get_context` | The group's name and kind, the member the token acts for, the members, the categories, the accounts costs are paid from (with each one's kind in a business, and whether it is archived) and the active split rules. Agents call this first, so a token pasted into the wrong agent is noticed at once. |
| `list_expenses` | Expenses in a month or a date range, with their shares and the account each was paid from (`account`: name and kind, or null). |
| `get_balance` | Who owes whom. In a business group, a cost paid from a personal account is left out of that and appears in `owedBack` instead: what the business owes each member for costs they paid on a personal account, less what it has repaid them, and how many expenses (and what total) have no account and so are not counted. |
| `list_attention` | Expenses that are unassigned or need an amount. |
| `preview_split` | The shares for an amount, date and category. The server computes them; the agent never does. Saves nothing. |

These are marked `readOnlyHint`. Reading expenses, the balance or the
attention list first posts the recurring costs that have fallen due, as
opening the app does.

A write token also gets these. A read token is not shown them, and calling
one anyway is refused.

| Tool | Takes | Does |
| --- | --- | --- |
| `add_expense` | `description`, `totalCents`, `category`, `payerId`, and optionally `date` (today if left out) and `accountId` | Adds a posted expense, split by the group's rules as the web does. If the same token added one with the same date, amount, description, category and payer in the last 2 minutes, it adds nothing and returns that one with `alreadyAdded: true`. |
| `edit_expense` | `expenseId` and any of `description`, `totalCents`, `category`, `payerId`, `date`, `accountId` (null clears it) | Replaces the expense with a new one that supersedes it, keeping the fields not given and its chosen split rule. A bill waiting for its amount is refused: that is entered in the app. |
| `void_expense` | `expenseId` | Voids the expense. Unlike an edit, this works on a bill waiting for its amount, as in the web app. |

They call the same `src/lib/expenses.ts` functions as the web, so they get the
same refusals (a future date, an unknown category or payer, an expense
already void), returned as a tool error the agent can read. The agent never
sends shares; the server computes them and returns them. An expense an agent
adds or edits has `source` `agent`; its audit entry has `actor_kind` `member`
and the token in `actor_token_id`. The tool descriptions tell the agent to
say what it wrote and how it was split, to use `preview_split` for "what
would this cost me", and to ask rather than guess a category or a payer.

### Not offered

Settlements, incomes, split rules, inviting members and tokens. Incomes are
not readable either: the agent sees shares, not what anyone earns.

## A resent call

An agent whose call timed out after the expense was saved may send it again.
`add_expense` therefore looks, in the same transaction, for a live expense
this token added in the last 2 minutes with the same date, amount,
description, category and payer (found through the audit entries carrying the
token's id). If there is one, it returns that expense marked `alreadyAdded`
instead of adding a second. A real second identical purchase needs a
different description or a 2-minute wait; the tool description says so. Two
copies of one call arriving at the same instant could still both be added.

## Limits

Streamable HTTP without sessions, through the official SDK
(`@modelcontextprotocol/server`): the 2026-07-28 revision and 2025-era
clients, each POST answered in JSON. 60 calls a minute per token, counted in
each server process's memory; over that is a 429. One message per POST: a
JSON-RPC batch is refused with a 400, and a body over 1 MB with a 413. At most
10 live tokens per member.

## Decisions taken

| Question | Choice | What it costs |
| --- | --- | --- |
| How does an agent sign in? | A pasted token. | Works with Claude Code and custom agents. Clients that only connect by OAuth wait for a later version. |
| What can an agent read? | Everything its member sees in that group, except incomes. | An agent cannot explain an income-ratio split beyond the shares it is shown. It does see the split percentages its member sees, so someone who knows their own income can work out the other person's from an income-ratio split. |
| Can an agent write? | Expenses only, with a write token, and at once. | A mistaken write counts until someone edits or voids it; Activity shows which writes were the agent's. |
| Do tokens expire? | No. Revoke by hand; last use is shown. | A forgotten token works until someone notices it. |

## What could go wrong

- **A leaked token.** A read token can read one group's expenses and
  balance. A write token can also add, edit and void that group's expenses as
  its member; each such change is in the audit log with the token's id, so it
  can be found and undone. Revoking it takes effect on the next call.
- **The rate limit is per server process.** Each process counts on its own
  and a restart clears the count, so with several machines a token gets 60
  calls a minute on each.

## Connecting

Make a token in Settings → Agents, then point an MCP client at
`https://<your site>/api/mcp` with the header
`Authorization: Bearer abm_...`. In Claude Code:

```sh
claude mcp add --transport http abacus https://abacus.example.com/api/mcp \
  --header "Authorization: Bearer abm_..."
```

A missing, unknown or revoked token, or a device token (`abk_`), gets a 401
that does not say which.
