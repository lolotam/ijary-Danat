#!/usr/bin/env bash
# pack-migration.sh — prepare a migration for transfer through a 1000-char
# remote shell command channel (orchestrator MCP exec).
#
# Why gzip first: a ~40 KB migration is ~46 chunks as raw base64, but only ~13
# after gzip -9. Fewer round-trips, less operator error.
#
# What this does (and only this):
#   1. gzip -9 the migration file
#   2. base64-encode the compressed bytes (no line wraps)
#   3. split the encoding into <=900-char chunks written to <outdir>/chunk_NN
#   4. print md5, byte size, chunk count, and the remote reassembly command
#
# It does NOT apply the migration. It does NOT connect to any host.
#
# Usage:
#   bash scripts/pack-migration.sh db/migrations/93_foo.sql [outdir]
#
# Exit non-zero if the source file is missing.
set -euo pipefail

SRC="${1:-}"
if [ -z "$SRC" ]; then
  echo "usage: bash scripts/pack-migration.sh db/migrations/NN_name.sql [outdir]" >&2
  exit 1
fi

if [ ! -f "$SRC" ]; then
  echo "error: migration file not found: $SRC" >&2
  exit 1
fi

BASENAME="$(basename "$SRC")"
# Leading digits of the filename become the remote /tmp/NN.sql name, e.g. 93.
NUM="$(printf '%s' "$BASENAME" | sed -n 's/^\([0-9][0-9]*\).*/\1/p')"
if [ -z "$NUM" ]; then
  NUM="migration"
fi

OUTDIR="${2:-/tmp/migration-pack}"
mkdir -p "$OUTDIR"
# Clear only our chunk files so a stale pack cannot mix with a new one.
rm -f "$OUTDIR"/chunk_*

# Source integrity before any transform.
if command -v md5sum >/dev/null 2>&1; then
  SRC_MD5="$(md5sum "$SRC" | awk '{print $1}')"
else
  # macOS / BSD fallback (not required on Git Bash, but cheap).
  SRC_MD5="$(md5 -q "$SRC")"
fi

# Byte size of the original file (not the compressed form).
SRC_BYTES="$(wc -c < "$SRC" | tr -d '[:space:]')"

# gzip -9 → base64 with no wraps. -w0 is GNU coreutils (Git Bash).
ENCODED="$(gzip -9 -c "$SRC" | base64 -w0)"

# Split into <=900-char chunks so each remote write fits the 1000-char cap
# with room for the shell wrapper around the payload.
CHUNK_SIZE=900
CHUNK_COUNT=0
OFFSET=0
LEN="${#ENCODED}"

while [ "$OFFSET" -lt "$LEN" ]; do
  CHUNK="${ENCODED:$OFFSET:$CHUNK_SIZE}"
  CHUNK_FILE="$(printf '%s/chunk_%02d' "$OUTDIR" "$CHUNK_COUNT")"
  # No trailing newline: reassembly must be pure base64.
  printf '%s' "$CHUNK" > "$CHUNK_FILE"
  CHUNK_COUNT=$((CHUNK_COUNT + 1))
  OFFSET=$((OFFSET + CHUNK_SIZE))
done

# Build the remote reassembly command the operator runs after writing
# each chunk to /tmp/p_NN on the host (one MCP command per chunk).
CAT_PARTS=""
i=0
while [ "$i" -lt "$CHUNK_COUNT" ]; do
  PART="$(printf '/tmp/p_%02d' "$i")"
  if [ -z "$CAT_PARTS" ]; then
    CAT_PARTS="$PART"
  else
    CAT_PARTS="$CAT_PARTS $PART"
  fi
  i=$((i + 1))
done

REMOTE_SQL="/tmp/${NUM}.sql"
REASSEMBLE="cat ${CAT_PARTS} | base64 -d | gunzip > ${REMOTE_SQL} && md5sum ${REMOTE_SQL}"

echo "source:       $SRC"
echo "md5:          $SRC_MD5"
echo "bytes:        $SRC_BYTES"
echo "chunks:       $CHUNK_COUNT  (in $OUTDIR/chunk_NN, each <= ${CHUNK_SIZE} chars)"
echo "remote sql:   $REMOTE_SQL"
echo "reassemble:   $REASSEMBLE"
echo ""
echo "After reassembly the remote md5 MUST equal: $SRC_MD5"
echo "Only then apply with:"
echo "  docker exec -i <db-container> psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 --single-transaction < ${REMOTE_SQL}"
