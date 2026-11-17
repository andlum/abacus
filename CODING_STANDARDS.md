# Coding standards

The rules a change to Abacus is reviewed against. A review reads the diff
with this file beside it and reports every rule the diff breaks, naming the
rule and the line.

## Money and dates

- **Money is integer cents.** Arithmetic stays in integers end to end.
- **Percentages are integer basis points**: 10000 = 100%.
- **Dates are ISO `YYYY-MM-DD`**; instants are `timestamptz`. A date shown to
  a person is worked out in the group's timezone.
- **Every computed share stores its formula and inputs**, so anyone can
  re-derive the number from the row alone.
- **Shares sum exactly to the total**, to the cent. The rule that places
  leftover cents is written down and stored with the result.
- **Clients never compute a split.** The web form and the phone show what
  the server returned.

## History

- **History is kept.** A row that stops being true is voided, or superseded
  by a new row whose `supersedes_id` points back at it. `audit_log` enforces
  this with a trigger; other tables follow it by convention.
- **A save that changes nothing writes nothing**: no new version and no
  audit entry.
- **Every state change calls `writeAudit` with the transaction handle**, so
  the entry commits with the change it describes. The detail holds ids, and
  amounts only where the reader of the log may already see them.
- **A migration that changes rows writes their audit entries too**, marked
  with the migration's name as the actor.
- **Applied migrations are never edited.** A fix is a new migration.

## Locking

- **Lock, then look.** A change to an existing row takes the row
  `FOR UPDATE` and checks its status, its group and its place in the chain
  after the lock is held. A check made before the lock proves nothing about
  the row being written.

## Who may see and change what

- **Every query for a group's data filters by `householdId`**, taken from
  `requireMember()` or the API token, never from the request.
- **An income's amount reaches only the people `incomeAmountVisible`
  allows** (`src/lib/incomes.ts`). Everything else that shows an income goes
  through it.
- **A change takes effect when it is saved.** There are no proposed, waiting
  or agreed states, in the data or in the wording on a page. The log of who
  changed what is the safeguard.
- **Agent writes take effect at once.** A `write` agent token adds, edits
  and voids expenses through the same `src/lib/expenses.ts` functions as the
  web, and each is recorded as the agent's (`actor_token_id`); a `read` token
  only reads. Old `proposed` and `rejected` expenses stay in the table and
  never count.

## The HTTP API

- **A new or changed route changes `src/lib/openapi.ts` in the same
  commit**, and `apps/ios/Abacus/Models.swift` with it.
- **A response shape changes only on purpose.** The pull request says so.

## Tests

- **The test comes first**, against PGlite with the real migrations
  (`createTestDb()`), and fails before the change is made.
- **A change to what a page shows or asks updates `e2e/household.spec.ts`**
  where the story passes through it.

## A public repository

- **People and figures are invented**: Alex and Sam, `alex@example.com`,
  round numbers. This holds for tests, fixtures, docs, commit messages and
  pull requests.
