# Abacus

[![CI](https://github.com/andlum/abacus/actions/workflows/ci.yml/badge.svg)](https://github.com/andlum/abacus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Split rent and shared costs with the people you live with, on a server you
control. Abacus is an open-source alternative to Splitwise, with a web app, a
native iOS app, and an MCP server so you can tell an AI agent "I paid $84 for
groceries" and have it entered.

> **Status: early.** Abacus works well for two people sharing a household.
> Larger groups, small-business spaces and the iOS app are still being built;
> see the [roadmap](docs/roadmap.md). Expect rough edges, and back up your
> database.

## Why another expense splitter?

Most splitting apps assume every cost is split evenly, or by percentages you
retype each time. Real households are messier:

- **Rent is split by income, but groceries are 50/50.** Abacus keeps a split
  rule per category: even, fixed percentages, in proportion to each person's
  income, or a fixed amount each with the rest split by another rule.
- **The rule changes, and the past should not.** Rules have start dates.
  "Rent is 60/40 from March" applies from March onward and leaves February's
  numbers alone.
- **You can check the maths.** Every share is stored with the rule and the
  inputs that produced it, so anyone can re-derive it. Shares always add up to
  the total, to the cent, and the rule for placing a leftover cent is stored
  too.
- **Nothing is quietly changed.** An edit replaces a row with a new one that
  points back at the old one, and every change is in the activity log.
- **Your finances stay yours.** Self-host it with Docker on one machine. No
  ads, and no outside account needed to sign in.

## Features

**Splitting**
- Split rules per category, with start dates: even, percentages, income
  proportional, or fixed amounts plus a remainder
- Each person's share shown live while you type an amount
- A balance page that says who owes whom, and payments to settle up

**Keeping track**
- One ledger of every expense and payment, filtered by month, category,
  payer, account, amount and more
- Recurring costs that post themselves on their due date, or ask for the
  amount when it varies (the electricity bill)
- A list of what needs attention: bills waiting for an amount, and expenses
  no split rule covers yet
- Categories per group, and CSV export and import

**Groups and people**
- Invite your partner by email; each person has their own sign-in
- One person can belong to several groups (a household, a small business)
  and switch between them
- In a business group, mark each card or account as personal or business, and
  see what the business owes each person for costs they paid personally

**Apps and integrations**
- A web app that installs to a phone's home screen
- A native iOS app (SwiftUI), first version
- An [HTTP API](#http-api) described by an OpenAPI spec
- An [MCP server](#use-it-from-an-ai-agent) for AI agents, with read-only or
  read-write tokens
- Optional bank import through
  [Plaid](docs/setup.md#connect-a-bank-optional), using your own Plaid keys

## Host it yourself

You need one machine with Docker and an SMTP account (Abacus emails sign-up
confirmations and invitations).

```bash
git clone https://github.com/andlum/abacus.git
cd abacus
cp .env.selfhost.example .env   # fill in the five required values
docker compose -f docker-compose.selfhost.yml up -d --build
```

Open the address you set in `BETTER_AUTH_URL`, create an account, and name
your household.

**Do that straight away:** the first account to finish setup owns the site.
After that, people get in only by invitation.

[docs/self-hosting.md](docs/self-hosting.md) covers HTTPS, backups, restores,
upgrades and using your own Postgres.

## Develop

Needs Node 24 (22.18 is the oldest that works), pnpm and Docker.

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local   # set BETTER_AUTH_SECRET
pnpm db:up && pnpm db:migrate
pnpm dev
```

Open http://localhost:3000. Locally, sign-in emails are printed to the
`pnpm dev` log instead of being sent.

To click around without passwords, set `ABACUS_E2E=1` in
`apps/web/.env.local`. Then sign in as any member at `/dev-sign-in`, and use
"Pretend today is" to watch rent post on the 1st without waiting for the 1st.
This is always off in production.

| Command | What it does |
|---|---|
| `pnpm test` | Unit and integration tests, on in-memory Postgres. No setup needed. |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm e2e` | Playwright browser tests |
| `pnpm db:generate` | A new migration after editing `apps/web/src/db/schema.ts` |

Full setup is in [docs/setup.md](docs/setup.md); running your own copy is in
[docs/self-hosting.md](docs/self-hosting.md).
The iOS app needs Xcode; see [apps/ios/README.md](apps/ios/README.md).

### How the code is laid out

| Path | What |
|---|---|
| `apps/web` | Next.js app, Postgres schema and migrations, the `/api/v1` API and the MCP server |
| `apps/ios` | SwiftUI app; it calls `/api/v1` and nothing else |
| `packages/core` | Money, dates, CSV and the split calculation, in plain TypeScript with no database |

A few rules hold everywhere: money is integer cents, percentages are integer
basis points (10000 = 100%), and the server computes every split, never a
client. [CODING_STANDARDS.md](CODING_STANDARDS.md) has the rest.

## HTTP API

The web app serves a JSON API at `/api/v1`, described by an OpenAPI spec at
`/api/v1/openapi.json`. Make a token under Settings → Devices, then:

```bash
curl -H "Authorization: Bearer $ABACUS_TOKEN" http://localhost:3000/api/v1/me
```

A test fails if a route is missing from the spec or answers in a shape the
spec doesn't describe, so the spec stays accurate.

## Use it from an AI agent

`/api/mcp` is an [MCP](https://modelcontextprotocol.io) server. Make a token
under Settings → Agents and give it to Claude Code, or any agent that accepts
a bearer token (clients that only sign in with OAuth don't work yet). A
read token can list expenses, check the balance and preview a split. A write
token can also add, edit and void expenses. The server computes every share;
the agent never does. Tools, limits and how to connect are in
[docs/mcp.md](docs/mcp.md).

## Contributing

Bug reports, ideas and pull requests are welcome.

- For anything bigger than a small fix, open an issue first so we can agree
  on the approach.
- Branch from `main`, one change per pull request, and fill in the template:
  what changes, why, and how you checked it.
- CI runs `pnpm typecheck` and `pnpm test`; both must pass.
- Write the test first, especially for the split calculation.
- This repository is public. Use invented people and round numbers
  (`alex@example.com`, $100.00) in tests, fixtures and screenshots, never
  real financial data.

## Security

Please don't open a public issue for a security problem. [SECURITY.md](SECURITY.md)
says how to report one privately.

## License

[MIT](LICENSE)
