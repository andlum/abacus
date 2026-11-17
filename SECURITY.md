# Security

Abacus holds people's money records, so reports are taken seriously and
answered quickly.

## Reporting a problem

**Please do not open a public issue.** Use GitHub's private reporting instead:
on this repository, **Security → Report a vulnerability**. Only the
maintainers can see what you send.

Say what you found, how to reproduce it, and what someone could do with it.
A failing test or a short script is ideal. Use invented data, never a real
person's.

You should hear back within three working days. If the report holds up, we
will agree a fix and a date with you, and credit you in the release notes
unless you would rather not be named.

## What counts

- Reading or changing a group's data without being a member of it.
- Reading another member's personal rows that are not marked shared.
- Getting around sign-in, email confirmation, invitations or device tokens.
- Making a stored share, balance or audit entry say something that did not
  happen.
- Anything that runs code or queries on the server that the app did not
  intend.

On the hosted service, please test only against accounts and groups you
created yourself. Do not run load tests or automated scanners against it;
host your own copy for that ([docs/self-hosting.md](docs/self-hosting.md)).

## What does not

- Problems that need a self-hoster to misconfigure their own server (no
  HTTPS, a published database port, a weak `BETTER_AUTH_SECRET`).
- Missing hardening with no way shown to exploit it.
- Reports from scanners with no working example.

## Supported versions

Fixes land on `main`, which is what the hosted service runs. There are no
maintained older releases; self-hosters get a fix by upgrading to `main`.
