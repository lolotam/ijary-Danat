#!/usr/bin/env bash
# Provision the Postgres instance used by the SQL integration tests
# (`bun run test:sql`) and print its connection URL on stdout.
#
# Source of truth = db/migrations/*.sql, applied in numeric order by the
# leading migration number (sort -V), not bare lexicographic filename order.
# Lex order breaks at migration 100: "100_…" sorts before "50_…" because
# character '1' precedes '5'. Numeric/version sort keeps 50 → 99 → 100 → 101.
# Applied with ON_ERROR_STOP=1 — exactly as scripts/gen-types.sh does, and
# exactly as a clean production database would be built. A migration that does
# not parse fails here, which is the cheapest guard we have against the class
# of error that shipped in the (since removed) migration 52.
#
# Reuse strategy
# --------------
# Rebuilding from scratch takes ~75s, so the container is long-lived. It is NOT
# safe to simply re-apply the migrations to an already-migrated database: the
# set is not fully re-runnable. `identify_contract_expiry_reminders` is defined
# in 07 and redefined with a different OUT-parameter row type in 31 and 33, and
# `create or replace function` cannot change a function's return type — so
# re-running 07 against a fully-migrated DB aborts. (db/README.md's blanket
# "all migrations are idempotent" claim does not hold for signature changes.)
#
# Instead we fingerprint the migration sources. Matching fingerprint → reuse the
# database untouched, which is both correct and instant. Any change to db/ →
# rebuild from scratch.
#
# Requirements: docker
#
# Usage:
#   bash scripts/test-db.sh [--fresh]   # prints postgres://...@127.0.0.1:54329/postgres
set -euo pipefail


# Prefer a working Docker CLI. On Windows hosts, WSL/Git-Bash often ship a
# Linux `docker` client that expects a unix socket the host does not have;
# Docker Desktop's docker.exe (npipe) is the one that actually works.
if ! docker info >/dev/null 2>&1; then
  if command -v docker.exe >/dev/null 2>&1 && docker.exe info >/dev/null 2>&1; then
    docker() { docker.exe "$@"; }
    export -f docker
  fi
fi


REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/db/migrations"
SCAFFOLD="$REPO_ROOT/db/testing/00_service_scaffold.sql"

CONTAINER="${TEST_DB_CONTAINER:-danat-sqltest}"
HOST_PORT="${TEST_DB_PORT:-54329}"
PG_PASSWORD="postgres"
# Matches scripts/gen-types.sh. Production runs 17.6; this image is what the
# repo's type generation is validated against and ships the auth/storage
# baseline the migrations need. Override with TEST_DB_IMAGE once a 17.x
# supabase/postgres tag has been verified against db/migrations.
IMAGE="${TEST_DB_IMAGE:-supabase/postgres:15.1.1.78}"

# Informational output goes to stderr so stdout carries only the URL.
log() { echo "$@" >&2; }
psql_in() {
  # client_min_messages=warning silences the hundreds of "already exists,
  # skipping" NOTICEs that idempotent DDL emits; real errors still surface.
  docker exec -i -e PGPASSWORD="$PG_PASSWORD" \
    -e PGOPTIONS="-c client_min_messages=warning" "$CONTAINER" \
    psql -U postgres -d postgres "$@"
}

psql_admin() {
  docker exec -i -e PGPASSWORD="$PG_PASSWORD" \
    -e PGOPTIONS="-c client_min_messages=warning" "$CONTAINER" \
    psql -h 127.0.0.1 -U supabase_admin -d postgres "$@"
}

# Same numeric order as the apply loop so the hash is deterministic and does
# not flip merely because a file was added where glob and loop disagree.
FINGERPRINT="$(
  {
    cat "$SCAFFOLD"
    while IFS= read -r sql; do
      cat "$sql"
    done < <(ls "$MIGRATIONS_DIR"/*.sql | sort -V)
  } | sha256sum | cut -c1-64
)"

if [[ "${1:-}" == "--fresh" ]]; then
  log "→ --fresh: removing $CONTAINER"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
fi

if [[ -n "$(docker ps -q -f "name=^${CONTAINER}$")" ]]; then
  existing="$(psql_in -Atc \
    "select value from _sqltest.state where key = 'fingerprint'" 2>/dev/null || true)"
  if [[ "$existing" == "$FINGERPRINT" ]]; then
    log "→ reusing $CONTAINER (migrations unchanged)"
    echo "postgres://postgres:${PG_PASSWORD}@127.0.0.1:${HOST_PORT}/postgres"
    exit 0
  fi
  log "→ migrations changed since last build — rebuilding"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
fi

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
log "→ starting $IMAGE as $CONTAINER on :$HOST_PORT …"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -p "${HOST_PORT}:5432" \
  "$IMAGE" >/dev/null

# The image bootstraps with a temporary server on the unix socket only, then
# shuts it down and starts the real one. `pg_isready` over the socket reports
# ready during that window, and a migration started then dies partway through
# with "terminating connection due to administrator command". Probing over TCP
# avoids the race: only the post-init server accepts TCP connections.
log "→ waiting for readiness (TCP, post-init) …"
ready=0
for _ in $(seq 1 90); do
  if docker exec -e PGPASSWORD="$PG_PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  log "✗ Postgres did not become ready in 90s"
  docker logs --tail 40 "$CONTAINER" >&2 || true
  exit 1
fi

apply() {
  local file="$1"
  if ! psql_in -v ON_ERROR_STOP=1 -q < "$file" >/dev/null; then
    log "✗ failed: $(basename "$file")"
    # Re-run without -q so the operator sees the actual Postgres error.
    psql_in -v ON_ERROR_STOP=1 < "$file" >&2 || true
    exit 1
  fi
}

# The bare image ships an older auth/storage baseline than a running Supabase
# stack. See db/testing/00_service_scaffold.sql.
log "→ applying service scaffold …"
if ! psql_admin -v ON_ERROR_STOP=1 -q < "$SCAFFOLD" >/dev/null; then
  log "✗ failed: $(basename "$SCAFFOLD")"
  psql_admin -v ON_ERROR_STOP=1 < "$SCAFFOLD" >&2 || true
  exit 1
fi

log "→ applying migrations from db/migrations …"
count=0
# Numeric/version sort: 50_ before 100_ (lexicographic glob order is wrong).
while IFS= read -r sql; do
  apply "$sql"
  count=$((count + 1))
done < <(ls "$MIGRATIONS_DIR"/*.sql | sort -V)
log "✓ $count migrations applied"

# Harness bookkeeping lives in its own schema, never in `public`. Anything in
# public is picked up by `supabase gen types --schema public`, and a test-only
# table appearing in the application's types would be both confusing and wrong.
psql_in -v ON_ERROR_STOP=1 -q >/dev/null <<SQL
create schema if not exists _sqltest;
create table if not exists _sqltest.state (key text primary key, value text not null);
insert into _sqltest.state (key, value) values ('fingerprint', '$FINGERPRINT')
  on conflict (key) do update set value = excluded.value;
SQL

echo "postgres://postgres:${PG_PASSWORD}@127.0.0.1:${HOST_PORT}/postgres"
