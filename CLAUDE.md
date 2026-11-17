# Abacus — personal finance companion

An open-source (MIT) alternative to Splitwise that grows into a general
finance companion: split rent and shared costs with a household, and, for
people who also run a small business, track business expenses with an
agent's help. Anyone can self-host it. The web app and a native iOS app share
one HTTP API.

Today the code is the household app: dated split rules for two partners,
groups, an HTTP API with device tokens, and an MCP server through which an
agent reads and, with a write token, adds, edits and voids expenses
(`docs/mcp.md`). What comes next is in `docs/roadmap.md`; setup and deploy
steps are in `docs/setup.md`.

## Layout

A pnpm workspace. Run commands from the root; they forward to the package.

- `apps/web` — the Next.js app: pages, server actions, database schema and
  migrations, scripts, Playwright tests. Paths below are relative to it.
- `packages/core` (`@abacus/core`) — money, dates, CSV and the split
  calculation. Pure TypeScript with no database or framework. Imported by
  subpath: `@abacus/core/money`, `@abacus/core/split`. Exports point at the
  `.ts` sources; there is no build step.
- `apps/ios` — the SwiftUI app, built with Xcode (see `apps/ios/README.md`).
  Not part of the pnpm workspace. It calls `/api/v1` and nothing else.
- Code that needs the database stays in `apps/web/src/lib`. Move a module to
  `core` only when it is pure.

## Public repo

This repository is public. Commits, tests, fixtures and docs use invented
people and values (`alex@example.com`, round numbers), never anyone's real
financial data.

## Changes go through pull requests

Nothing is pushed to `main` directly. Each change is a branch and a pull
request, so the reason for it and how it was checked are written down in one
place.

- **Branch from `origin/main`**, one change per branch. If other work is
  uncommitted in the checkout, make the branch in a `git worktree` rather than
  switching branches under it.
- **Open the pull request with `gh pr create`** and fill in the template: what
  changes, why, how it was checked, and anything to do before it deploys (a
  migration, a new environment variable).
- **CI must pass** (`.github/workflows/ci.yml`): typecheck, tests, the
  migration check, the build, and the Playwright story (`pnpm e2e`).
- **No review is required for now.** Once CI is green, merge it yourself with
  `gh pr merge --squash --delete-branch`. The pull request title becomes the
  commit on `main`, so write it like the commit subjects already there.
- **A release is a tag.** Merging to `main` does not ship anything. A `v*`
  tag on `main` (`git tag v0.2.0 origin/main && git push origin v0.2.0`)
  marks a version as ready, and the hosted instance deploys the newest one.
  Deploy configuration lives outside this repository.

GitHub does not enforce any of this while the repository is private on a free
plan; it is a convention until branch protection is switched on.

## Data conventions

Money is integer cents, percentages are integer basis points (10000 = 100%),
dates are ISO `YYYY-MM-DD`. A row that stops being true is voided or
superseded, never overwritten. A change takes effect when it is saved; there
are no proposed or waiting states. Agent writes take effect at once and are
recorded as the agent's in the activity log.

`CODING_STANDARDS.md` holds these and the rest of the rules in full. Read it
when reviewing a diff, and before changing money, history, locking, a data
migration or an API shape.

## Working in the code

- **Who is asking:** pages and server actions start with `requireMember()`
  (`src/lib/session.ts`), which returns the member row for the group the
  person is working in. A group is a `household` row of kind `household` or
  `business`; someone in several groups has one `member` row in each, picks
  one in the header (the `abacus_group` cookie), and may mark one as their
  default (`src/lib/groups.ts`). A group names a person by email, which
  makes an invitation, not a membership: the invited person, signed in with
  that verified email, sees it at `/invitations` and joins only by accepting
  it (`src/lib/membership.ts`: `invitationsFor`, `acceptInvitation`,
  `declineInvitation`). Signing in never links a member row by itself. A member may add a group at `/groups/new`. An
  uninvited account may create a household at `/setup` only while none
  exists, or always with `ABACUS_OPEN_SIGNUP=1`
  (`src/lib/household-setup.ts`). Sign-in itself is Better Auth, configured in `src/lib/auth.ts`; its tables are the `auth_*` ones in the schema.
- **The HTTP API** lives in `src/app/api/v1`. Each route is wrapped in
  `route()` (`src/lib/api.ts`), which signs in with `Authorization: Bearer
  abk_...` (`src/lib/api-tokens.ts`; only a hash is stored) and turns
  `ApiError` into its status and `UserError` into a 400. Routes call the same
  `src/lib` functions the server actions do. Tokens are made and revoked
  under Settings → Devices and act with their member's full rights.
- **The API spec** is `src/lib/openapi.ts`, served at `/api/v1/openapi.json`.
  `openapi.test.ts` fails if a route is missing from the spec or answers in a
  shape the spec doesn't describe, so a new or changed route changes the spec
  in the same commit. The iOS models in `apps/ios/Abacus/Models.swift` follow
  the spec by hand; update them too.
- **The phone shows `shares`** and calls `POST /expenses/preview` while an
  amount is typed.
- **The daily job** is `src/lib/daily-job.ts`, started from
  `src/instrumentation.ts`: soon after the server starts, then hourly, it
  posts every group's due recurring costs. A new daily task goes in its
  per-group loop. Pages and routes still call `postDue` before reading.
- **Bank connections** (optional, Plaid; hidden without keys): `src/lib/plaid.ts`
  is the API client and webhook check, `src/lib/bank.ts` connects, syncs and
  sorts, `src/lib/bank-link.ts` links, re-links and handles the webhook at
  `/api/plaid/webhook` (public in `src/proxy.ts`, trusted only by signature).
  Tests use `src/lib/testing/fake-plaid.ts`, never the network. Access tokens
  are stored sealed (`secret-box.ts`) and never logged. Setup: `docs/setup.md`.
- **Imports:** files under `src/db` and `src/lib` that `scripts/` use are
  imported with relative paths and `.ts` extensions, because Node runs the
  scripts directly without the `@/` alias. App code uses `@/`. Shared code
  comes from `@abacus/core/*`, which Node, Next and Vitest all resolve.
- **Tests** run against PGlite with the real migrations: `createTestDb()` in
  `src/db/test-db.ts`. Write the test first; the split engine especially.
- **Schema changes:** edit `src/db/schema.ts`, then `pnpm db:generate`. For
  SQL Drizzle can't express (triggers), `pnpm exec drizzle-kit generate
  --custom --name <name>`. Applied migrations are never edited.
- **Next.js 16:** request interception lives in `src/proxy.ts` (formerly
  middleware). This is not the Next.js in your training data: read
  `apps/web/AGENTS.md` and the docs in `apps/web/node_modules/next/dist/docs/`
  before writing Next code.
- **Seeing a change in the browser:** `pnpm check:live [port]` starts the
  database, makes a fresh one for that port with Alex and Sam in it, and
  serves the app with a sign-in stand-in (`scripts/check-live.sh`). Run it
  from a worktree, one port per worktree.
- **When typecheck fails on a route that no longer exists**, delete
  `apps/web/.next`: it holds route types from an earlier build.
- **Before a migration that changes rows**, `pnpm db:counts` prints row
  counts per status for the database in `DATABASE_URL`, read-only.
