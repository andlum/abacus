#!/bin/sh
# Runs the app for a look in the browser: `pnpm check:live [port]`.
#
# Starts the local database if it is not up, makes a fresh database for this
# port with the invented household of two (Alex and Sam, e2e/reset-db.ts),
# and serves the app with the sign-in stand-in. Sign in as either of them.
#
# Each port has its own database, so two checks in two worktrees do not
# reset each other. Stop it with Ctrl-C, or kill the process listening on
# the port (`lsof -ti tcp:<port> -sTCP:LISTEN`).
set -eu

PORT="${1:-3150}"
cd "$(dirname "$0")/.."

docker compose -f ../../docker-compose.yml up -d --wait db

export ABACUS_E2E=1
# Start without Turbopack's dev cache, which can go stale (next.config.ts).
export ABACUS_COLD_DEV=1
export DATABASE_URL="postgres://abacus:abacus@localhost:5432/abacus_e2e_${PORT}"

node e2e/reset-db.ts
echo "check-live: http://localhost:${PORT}"
exec pnpm exec next dev -p "$PORT"
