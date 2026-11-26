#!/usr/bin/env bash
# Apply every IJARY migration to the LOCAL dev stack (dev-local/docker-compose.yml).
# Order: db/migrations by leading number (sort -V), then supabase/migrations.
# Records applied files in _devlocal.applied so a re-run only applies new ones.
# LOCAL ONLY: talks to the ijary-local db container, never to a server.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_USER="${MIGRATE_DB_USER:-postgres}"

psql_db() {
  docker compose -f "$REPO_ROOT/dev-local/docker-compose.yml" exec -T \
    -e PGOPTIONS="-c client_min_messages=warning" db \
    psql -h 127.0.0.1 -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 -q "$@"
}

psql_db -c "create schema if not exists _devlocal;
  create table if not exists _devlocal.applied (file text primary key, applied_at timestamptz default now());"

applied=0
while IFS= read -r sql <&3; do
  rel="${sql#"$REPO_ROOT"/}"
  done_already="$(psql_db -Atc "select 1 from _devlocal.applied where file = '$rel'")"
  [[ -n "$done_already" ]] && continue
  echo "→ $rel" >&2
  if ! psql_db < "$sql" >/dev/null; then
    echo "✗ failed: $rel" >&2
    exit 1
  fi
  psql_db -c "insert into _devlocal.applied (file) values ('$rel')"
  applied=$((applied + 1))
done 3< <(ls "$REPO_ROOT"/db/migrations/*.sql | sort -V; ls "$REPO_ROOT"/supabase/migrations/*.sql 2>/dev/null | sort)

psql_db -c "notify pgrst, 'reload schema';"
echo "✓ $applied new migration(s) applied" >&2
