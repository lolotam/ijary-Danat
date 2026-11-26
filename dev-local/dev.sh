#!/usr/bin/env bash
# Start the IJARY dev server against the LOCAL Docker stack only.
#
# The repo's .env points at a real server. Env vars already set in the process
# win over .env files (Vite and dotenv never overwrite them), so this script
# first blanks EVERY key found in .env / .env.local, then sets local values.
# A key added to .env later is therefore blanked too, never inherited.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
set -a; source "$HERE/.env"; set +a

for f in "$REPO_ROOT/.env" "$REPO_ROOT/.env.local" "$REPO_ROOT/.env.development"; do
  [[ -f "$f" ]] || continue
  while IFS= read -r key; do export "$key="; done \
    < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$f" | cut -d= -f1)
done

export VITE_SUPABASE_URL="http://localhost:54321"
export VITE_SUPABASE_PUBLISHABLE_KEY="$ANON_KEY"
export SUPABASE_URL="http://localhost:54321"
export SUPABASE_PUBLISHABLE_KEY="$ANON_KEY"
export SUPABASE_ANON_KEY="$ANON_KEY"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export SUPABASE_JWT_SECRET="$JWT_SECRET"
export INTEGRATIONS_MASTER_KEY
export REDIS_URL="redis://localhost:56380"
export PLATFORM_ROOT_HOST="localhost"
export PLATFORM_ADMIN_HOST="admin.localhost"
export TRUST_FORWARDED_HOST="false"
export CRON_SECRET="local-cron-secret-not-for-production"
export SMTP_HOST="localhost" SMTP_PORT="54325" SMTP_FROM="no-reply@ijary.local"
export NODE_ENV="development"

cd "$REPO_ROOT"
# Loopback only: the Lovable config binds every interface (Wi-Fi, Tailscale).
exec bun run dev --host 127.0.0.1 "$@"
