#!/usr/bin/env bash
# Generate Supabase types from db/migrations applied to a clean, ephemeral
# Postgres, and write them to a SCRATCH file for manual merging.
#
# Source of truth = db/migrations/*.sql (NOT the deployed self-hosted DB).
#
# ⚠ THIS SCRIPT DOES NOT OVERWRITE src/integrations/supabase/database.types.ts.
#
# That file is HAND-MAINTAINED. It exports 73 named aliases — AppRole,
# LocaleCode, InvoiceState, PaymentMethod, … — which `supabase gen types` does
# not emit at all (it nests everything under `Database["public"]["Enums"]`).
# 70 files import those aliases. Overwriting the file breaks all of them.
#
# So: this script produces the generated shape next to the real file, and you
# copy across the one table or function you added, by hand, in the existing
# style. Pass --force only if you have decided to migrate the whole codebase off
# the named aliases, which is a refactor, not a regeneration.
#
# Requirements:
#   - docker
#   - npx (bundled with Node) — pulls `supabase` CLI on demand
#
# Usage:
#   bun run gen:types            # writes database.types.generated.ts
#   bash scripts/gen-types.sh --force   # overwrites the real file (don't)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/db/migrations"
REAL_FILE="$REPO_ROOT/src/integrations/supabase/database.types.ts"
OUT_FILE="$REPO_ROOT/src/integrations/supabase/database.types.generated.ts"

if [[ "${1:-}" == "--force" ]]; then
  echo "⚠ --force: overwriting the hand-maintained $REAL_FILE" >&2
  OUT_FILE="$REAL_FILE"
fi

CONTAINER="ermp-gen-types-$$"
HOST_PORT="$(( ( RANDOM % 20000 ) + 40000 ))"
PG_PASSWORD="postgres"
DB_URL="postgres://postgres:${PG_PASSWORD}@127.0.0.1:${HOST_PORT}/postgres"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "→ starting ephemeral Postgres on :${HOST_PORT} …"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -p "${HOST_PORT}:5432" \
  supabase/postgres:15.1.1.78 >/dev/null

# Probe over TCP, not the unix socket: the image bootstraps with a temporary
# socket-only server, so pg_isready reports ready during init and the first
# migrations then die with "terminating connection due to administrator
# command". Only the post-init server accepts TCP.
echo "→ waiting for Postgres readiness (TCP, post-init) …"
for _ in $(seq 1 90); do
  if docker exec -e PGPASSWORD="$PG_PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -U postgres -d postgres -c 'select 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# The bare image ships an older auth/storage baseline than a running Supabase
# stack; eight migrations insert into storage.buckets(…, public), a column the
# image does not have. See db/testing/00_service_scaffold.sql.
echo "→ applying service scaffold …"
docker exec -i -e PGPASSWORD="$PG_PASSWORD" "$CONTAINER" \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$REPO_ROOT/db/testing/00_service_scaffold.sql"

echo "→ applying migrations from $MIGRATIONS_DIR …"
# Numeric/version sort by leading migration number, not bare lexicographic
# filename order. Lex order breaks at migration 100: "100_…" sorts before
# "50_…" because character '1' precedes '5'.
while IFS= read -r sql; do
  echo "   • $(basename "$sql")"
  docker exec -i -e PGPASSWORD="$PG_PASSWORD" "$CONTAINER" \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q < "$sql"
done < <(ls "$MIGRATIONS_DIR"/*.sql | sort -V)

echo "→ generating TypeScript types …"
npx --yes supabase gen types typescript \
  --db-url "$DB_URL" \
  --schema public \
  > "$OUT_FILE"

echo "✓ wrote $OUT_FILE"
if [[ "$OUT_FILE" != "$REAL_FILE" ]]; then
  cat >&2 <<'NOTE'

  This is a REFERENCE file, not the one the app compiles against.
  Copy the table/function you added into
  src/integrations/supabase/database.types.ts by hand, matching the
  surrounding style, then delete the generated file.
NOTE
fi
