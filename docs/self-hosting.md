# Host Abacus yourself

One machine, Docker, and an SMTP account are enough. `docker-compose.selfhost.yml`
runs three things: Postgres, a one-off step that applies database migrations,
and the web app.

## What you need

- A machine with Docker and the Compose plugin (`docker compose version`).
  The first build is the heavy part; give it a couple of gigabytes of memory.
- An SMTP account that can send mail. Abacus emails a confirmation link at
  sign-up, password resets, and invitations. Without working mail nobody can
  finish signing up.
- For anything beyond your own laptop: a domain name and a reverse proxy that
  terminates HTTPS (Caddy, nginx, Traefik).

## Start it

```bash
git clone https://github.com/andlum/abacus.git
cd abacus
cp .env.selfhost.example .env
```

Fill in `.env`. Every value is explained in the file. The five that must be
set:

| Variable | What it is |
| --- | --- |
| `POSTGRES_PASSWORD` | Password for the bundled database. `openssl rand -hex 24` |
| `BETTER_AUTH_SECRET` | Signs sessions. `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | The address people type, e.g. `https://abacus.example.com` |
| `SMTP_URL` | e.g. `smtps://user:password@smtp.example.com:465` |
| `MAIL_FROM` | e.g. `Abacus <abacus@example.com>` |

Then:

```bash
docker compose -f docker-compose.selfhost.yml up -d --build
```

The first build takes a few minutes. When `docker compose -f
docker-compose.selfhost.yml ps` shows `app` as `healthy`, open the address in
`BETTER_AUTH_URL`.

## Claim the site straight away

**The first account to sign up and create a group owns the site.** Until a
group exists, anyone who can reach the address can be that person. So sign up,
confirm your email and finish `/setup` before you share the address.

After that, new people get in only by invitation: you add their email to a
group, they sign up with that email and accept. Set `ABACUS_OPEN_SIGNUP=1`
only if you want strangers to be able to create their own groups on your
server.

## Put HTTPS in front

By default the app listens on `127.0.0.1:3000`, so it is reachable only from
the machine itself. Point a reverse proxy at it. With Caddy that is the whole
configuration:

```
abacus.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

With nginx:

```nginx
server {
    server_name abacus.example.com;
    listen 443 ssl;
    # ssl_certificate and ssl_certificate_key go here

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Two settings go with the proxy:

- `BETTER_AUTH_URL` must be the public `https://` address. Sign-in cookies and
  the links in emails are built from it.
- `ABACUS_CLIENT_IP_HEADER` should name a header your proxy sets and a
  visitor cannot: `x-real-ip` for the nginx block above. Sign-in attempts are
  limited per address (5 a minute). Without this setting no address header is
  trusted (`X-Forwarded-For` is ignored, since a visitor can fake it), so all
  visitors share one limit per page. Set it to whichever header your proxy
  overwrites with the real address: `x-real-ip` for the nginx block above,
  `fly-client-ip` on Fly, `cf-connecting-ip` behind Cloudflare.

Do not set `ABACUS_BIND=0.0.0.0` on a machine facing the internet; that
serves plain HTTP to everyone.

## Back up

Everything lives in Postgres. One command writes it all to a file:

```bash
docker compose -f docker-compose.selfhost.yml exec -T db \
  pg_dump -U abacus --clean --if-exists abacus > backup.sql
```

Run it on a schedule and copy the file off the machine. Keep `.env` somewhere
safe too: without `BETTER_AUTH_SECRET` everyone is signed out, which is
recoverable; without the backup, nothing is.

## Restore

Stop the app so nothing writes during the restore, load the file, start again:

```bash
docker compose -f docker-compose.selfhost.yml stop app
docker compose -f docker-compose.selfhost.yml exec -T db \
  psql -U abacus -d abacus -v ON_ERROR_STOP=1 < backup.sql
docker compose -f docker-compose.selfhost.yml up -d
```

Try this once on a spare machine before you need it.

## Upgrade

Take a backup first, then:

```bash
git pull
docker compose -f docker-compose.selfhost.yml up -d --build
```

Migrations run before the new app starts. If a migration fails the app does
not start on the new version; `docker compose -f docker-compose.selfhost.yml
logs migrate` says why. Migrations only go forward, so going back to an older
version means restoring the backup you took.

## Recurring costs post on their own

Nothing to set up. The app runs a job a few seconds after it starts and then
every hour, which posts each group's recurring costs once their date comes
in the group's timezone. `docker compose -f docker-compose.selfhost.yml logs
app` shows one `daily job:` line per run, with counts only. To switch it off,
set `ABACUS_DAILY_JOB=0` in `.env`; costs then post when someone opens the
app, as before.

## Things that catch people out

- **Changing `POSTGRES_PASSWORD` later does nothing.** Postgres reads it only
  when the data volume is first created. To change it, change it inside
  Postgres (`ALTER USER abacus PASSWORD '...'`) and then in `.env`.
- **`docker compose down -v` deletes the database.** Plain `down` keeps it.
- **No confirmation email arrives.** `docker compose -f
  docker-compose.selfhost.yml logs app` shows the SMTP error. Check the port
  matches the scheme: `smtps://` with 465, `smtp://` with 587.
- **Sign-in is refused or does not stick.** Check that `BETTER_AUTH_URL` is
  exactly the address in the browser, including `https`.
- **Sign-in limits are counted in memory**, so they reset when the app
  restarts. Fine for one machine, which is what this setup is.

## Your own Postgres

To use a database you already run, delete the `db` service and the
`depends_on` entry that waits for it from the Compose file, and set
`DATABASE_URL` in the `x-app` block to point at yours. The bundled setup is
tested with Postgres 17.
