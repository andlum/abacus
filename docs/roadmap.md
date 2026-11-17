# Roadmap

Done:

- **Workspace and shared core.** `apps/web` plus `packages/core`.
- **HTTP API.** `/api/v1` with device tokens and an OpenAPI spec, tested
  against every route's answers.
- **iOS app, first cut.** Sign in with a token, balance, a month's expenses,
  void, and add with a live split preview from the server.
- **One list of every expense.** The Ledger opens on every expense and
  payment of the group, newest first, a page at a time, filtered by month,
  date, category, payer, account, source, status, amount and description; a
  picked month shows its totals above the list. The expenses alone are
  `GET /api/v1/expenses`, and the phone scrolls through it.
- **Home-screen web app.** A manifest, so Android users can install the web
  app until there is a native one.
- **Self-hostable sign-in.** Better Auth inside the app: an invited email,
  a password, and a confirmation link, so self-hosting needs an SMTP server
  and no outside account.
- **Household setup in the browser.** The first person to sign up names the
  household and invites their partner at `/setup`; no env file or script.

Next, in order:

1. **Groups.** One person can now be in many groups, each a household or a
   small business, and switch between them in the header. A business may be
   one person; a group starts with one or two people, and more can be
   added in Settings: each counts in splits from the day they accept. Still
   to do: naming several people when a group is created, leaving or being
   removed from a group, and choosing a group
   from the phone, where a device token still acts in one group.
2. **Self-host guide.** Docker Compose with Postgres is in
   [self-hosting.md](self-hosting.md). Still to do: a demo with invented
   data.
3. **Business spaces.** A space owned by one person, with business categories
   and an agent that reads them through MCP (it cannot write). Done so far: each expense can say which
   card or account paid for it, and in a business each account is marked
   personal or business, and the expense list filters by account or by
   personal and business. The Balance page of a business says what it owes
   each member for costs they paid on a personal account (posted, or with a
   split that failed), less the repayments recorded to them (a repayment is
   its own record, since a business is not a member and a payment between
   members cannot say it). Such a cost is left out of what members owe each
   other, so it is not counted twice. Expenses with no account are not
   counted, and the page says what they come to.
   Once anything is paid from an account its kind is fixed: archive it and
   add a new one instead. The same figures come back from `GET /balance` as
   `owedBack` and from the MCP `get_balance` tool.

Later:

- Generate the Swift models from the OpenAPI spec.
- Custom split rules, payments and recurring costs in the iOS app.
- An Android app in Kotlin, built from the same spec.
