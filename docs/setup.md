# Setup

## Local development

Run commands from the repo root; they forward to `apps/web`.

1. `pnpm install`
2. `cp apps/web/.env.example apps/web/.env.local` and fill it in. Set
   `BETTER_AUTH_SECRET` to the output of `openssl rand -base64 32`. Leave
   `SMTP_URL` empty: locally, every sign-in email is printed to the
   `pnpm dev` log, and you open the link from there.
3. `pnpm db:up` (Postgres in Docker), then `pnpm db:migrate`.
4. `pnpm dev`. At `/sign-in`, choose "Create your account", then open the
   confirmation link from the server log.
5. The first account on an empty database lands on `/setup`: name the
   household, pick its timezone (it decides which day "today" is, and so
   when a recurring cost falls due), and enter your partner's name and email.
   Abacus emails your partner an invitation. They create their own account
   with that email and accept the invitation on the Join page. If the email
   fails, the invite stays pending and Settings has a "Send invite" button.

Once a household exists, an email nobody invited cannot create an account.
Set `ABACUS_OPEN_SIGNUP=1` to let anyone with a confirmed email create their
own household, which is what a hosted service wants.

Each account has daily ceilings on what reaches other people, so an open
site cannot be used to send mail to strangers. The defaults, and the
variable that changes each:

| Ceiling | Default | Variable |
| --- | --- | --- |
| Groups one account creates in 24 hours | 5 | `ABACUS_MAX_GROUPS_PER_DAY` |
| Invite emails one account sends in 24 hours | 10 | `ABACUS_MAX_INVITE_EMAILS_PER_DAY` |
| Invite emails one address receives in 24 hours | 1 | `ABACUS_MAX_INVITE_EMAILS_PER_ADDRESS` |
| Unanswered invitations across one account's groups | 20 | `ABACUS_MAX_OPEN_INVITES` |

To skip the form, fill in `HOUSEHOLD_NAME`, `HOUSEHOLD_TIMEZONE` and the
`MEMBER_*` variables and run `pnpm db:provision` before anyone signs up. It
creates the same rows.

`pnpm test` needs no database or keys: it runs on in-memory PGlite.

### Trying it without passwords

Set `ABACUS_E2E=1` in `apps/web/.env.local`. The app
then signs you in at `/dev-sign-in`: pick a member, no password. The same
page has "Pretend today is", which sets the date the app works from, so you
can watch rent get entered on the 1st without waiting for the 1st. Use
"switch person" in the header to act as the other partner.

This stand-in is off whenever `NODE_ENV` is `production`, whatever the
variable says, so it cannot be switched on in the deployed app.

### Browser tests

`pnpm e2e` runs the Playwright tests in `apps/web/e2e/`. It needs `pnpm db:up` and,
once, `pnpm --filter @abacus/web exec playwright install chromium`. Each run drops and recreates
its own database, `abacus_e2e`, with an invented household; your development
database is left alone.

The tests and `pnpm check:live` start `next dev` without Turbopack's cache
(`ABACUS_COLD_DEV=1`, read in `apps/web/next.config.ts`). A cache left over
from other branches in the same checkout can make every page reload itself
endlessly: the browser asks for the page many times a second, and a typed
date or a click never sticks. If plain `pnpm dev` does that, stop it and
delete `apps/web/.next/dev`.

### The HTTP API

The web app serves an API at `/api/v1`, described at `/api/v1/openapi.json`.

1. Sign in to the web app and open Settings → Devices.
2. Name the device and make a token. It is shown once; copy it then.
3. Call the API with it:

```bash
curl -H "Authorization: Bearer $ABACUS_TOKEN" http://localhost:3000/api/v1/me
```

Revoke a token on the same page. With the sign-in stand-in on
(`ABACUS_E2E=1`), the `x-abacus-today` header sets the date for one request,
as "Pretend today is" does in the browser. It is ignored in production.

### The iOS app

Needs Xcode. See `apps/ios/README.md`: open `apps/ios/Abacus.xcodeproj`, run
on a simulator, and sign in with the server address (`http://localhost:3000`
from a simulator) and a token from Settings → Devices.

### On a phone's home screen

The web app has a manifest, so Safari's Share → Add to Home Screen (or
Chrome's Install app on Android) opens it full screen like an app.

## Deploying

Abacus is one Next.js server and one Postgres database, so it runs on any
host that can run the `Dockerfile`. `docs/self-hosting.md` walks through one
machine with Docker Compose; on a platform host the same pieces apply:

1. **Email.** Sign-in sends two kinds of email: the link that confirms an
   address, and password resets. Any SMTP server will do (a mailbox you own,
   or a transactional mail service's SMTP endpoint). Note its
   `smtp://user:pass@host:port` URL and a `From` address.
2. **Database.** Any Postgres 17. If the provider gives you a pooled
   connection string, set it as `DATABASE_URL` and the direct one as
   `DATABASE_URL_UNPOOLED`; migrations use the direct one, because they
   should not go through a pooler.
3. **Secrets.** Set `DATABASE_URL`, `BETTER_AUTH_SECRET`
   (`openssl rand -base64 32`), `BETTER_AUTH_URL` (the public `https://`
   address), `SMTP_URL` and `MAIL_FROM`. `apps/web/.env.example` lists the
   optional ones.

   `ABACUS_CLIENT_IP_HEADER` names the header the sign-in rate limit reads the
   client's address from. A header the client can set itself lets them dodge
   the limit, so with this unset no header is read and everyone shares one
   limit per page (safe, but one person guessing can lock out the rest). Set
   it to a header your host or proxy overwrites with the real address:
   `fly-client-ip` on Fly, `x-real-ip` behind nginx.
4. **Migrations** run with `node scripts/migrate.ts` from `apps/web`. Run them
   before each new version starts (most platforms call this a release
   command).
5. **Set up the household**, straight after the first deploy. Open
   `/sign-in`, create your account, confirm it from the email, and fill in the
   form at `/setup`. Until this is done the site belongs to whoever gets there
   first, so do not leave a fresh deploy sitting. (To close that gap
   entirely, run `scripts/provision-household.ts` against the database before
   the first deploy, with `DATABASE_URL` and the `HOUSEHOLD_*` and `MEMBER_*`
   values in a gitignored env file.)
6. Your partner opens `/sign-in`, creates their account with the email you
   entered for them, and confirms it in the same browser. (If they open the
   link in a different browser, the password they typed is discarded and they
   are sent to "Reset your password" to choose one, so a password typed by
   someone else can never become usable.) Sign-up answers the same way for
   every address, so it does not reveal who was invited. They land on `/invitations` and press
   Join; signing in alone never adds anyone to a group. Recent activity on the home page shows
   `household: created` and then a `member.linked` entry for them.

## The daily job

Recurring costs post from a job inside the app, a few seconds after it
starts and then every hour (`src/lib/daily-job.ts`). `ABACUS_DAILY_JOB=0`
switches it off. A host that stops the server when nobody is using it also
stops the job, because a stopped server runs no timers. On such a host,
request `/api/health` once a day from a scheduler (a cron job, a scheduled
GitHub Actions workflow): that starts the server, and the job runs on start.

### The ops email

Set `ABACUS_OPS_EMAIL` to get one email a day from the job: sign-ups since
the last email and how many never confirmed their address, groups created,
invite emails sent, the most of each by any one account, and how the job's
own run went. It leads with warnings when something looks wrong: sign-ups at
or above `ABACUS_OPS_SIGNUP_ALERT` (default 20), five or more sign-ups with
most unconfirmed, one account reaching a daily ceiling, or a failed posting
or bank sync. It holds counts only, never names or addresses.

It goes out on the first run of each UTC day, so on a host that stops when
idle it arrives with the daily wake-up. The `ops_report` table keeps one row
per day, which stops a second server sending it twice; a failed send is tried
again on a run at least half an hour later. It uses the same `SMTP_URL` as
sign-in mail.

## Connect a bank (optional)

Abacus can pull purchases from a bank through Plaid. It is off until you set
four variables, and nothing about it shows in the app before then. You use your
own Plaid account and keys; Abacus has none.

1. Sign up at plaid.com and copy the `client_id` and the Sandbox `secret`
   from the dashboard.
2. Make the key that seals bank tokens in the database:
   `openssl rand -base64 32`
3. Set these (on Fly: `fly secrets set ...`):
   - `PLAID_CLIENT_ID` and `PLAID_SECRET`
   - `PLAID_ENV`: `sandbox` or `production`. Leave it out for `sandbox`;
     fake banks and fake purchases only. Switch to `production` once Plaid has
     approved your account, and use the production secret with it.
   - `ABACUS_ENCRYPTION_KEY`: the value from step 2.
4. Webhooks tell Abacus about new purchases within minutes instead of at the
   next daily sync. Plaid calls `<BETTER_AUTH_URL>/api/plaid/webhook`, so the
   app must be reachable on a public `https://` address set as
   `BETTER_AUTH_URL`. Without that address the app still syncs once a day.
   Nothing is to be entered in the Plaid dashboard for this.

Then open Settings, Accounts, and press Connect a bank. In Sandbox, sign in
with Plaid's test user `user_good` and password `pass_good`.

Only credit cards are followed. Plaid's window offers just the cards, and a
sign-in with no credit card is refused. A new connection brings in the last 30
days of purchases; older ones are left out.

Keep a copy of `ABACUS_ENCRYPTION_KEY`. If it is lost or changed, the stored
tokens cannot be opened: no connection can sync, and each bank has to be
disconnected and connected again. Expenses already added are not affected.

## If someone is locked out

A forgotten password is handled by "Forgot password" on the sign-in page.

A member row is tied to one sign-in account (`member.auth_user_id`). If that
account is deleted from `auth_user` and recreated, sign-in is refused and a
`member.link_rejected` audit entry is written. There is no UI for re-linking
yet; it is a manual database change: clear `auth_user_id` and `linked_at` on
the member row, and the person accepts it again at `/invitations` after their
next verified sign-in.

## Taking someone's access away

Under Settings → People, **Remove access** next to a joined member (not
yourself) signs them out of every device, revokes their device and agent
tokens, disconnects any bank they connected (even if Plaid cannot be reached),
and stops their email from linking to the group again. Their `member` row
stays, with `removed_at` and `removed_by`.

Only access changes. A removed member still counts in split rules, splits,
recurring costs, the balance and payments, exactly as before; leaving a
household for money purposes is not built yet. **Invite again** gives the same
row back as an invitation, which they accept like any other; their old tokens
stay revoked and their history is unchanged.
