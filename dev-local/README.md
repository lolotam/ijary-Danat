# IJARY local environment

A full local stack for testing user journeys: self-hosted Supabase services
(Postgres 17.6, GoTrue, PostgREST, Storage, Realtime, Kong, Studio), Mailpit
and Redis in Docker, plus the Vite dev server.

**Local only.** Nothing here talks to a server. `dev.sh` blanks every key it
finds in the repo's `.env`, `.env.local` and `.env.development`, then sets the
local values, so the dev server never uses the real Supabase URL in `.env`.
All ports, including the dev server, bind to `127.0.0.1`.

## Prerequisites

- Docker Desktop running
- Bun
- Git Bash (the scripts are bash)
- `dev-local/.env` with the local secrets: `JWT_SECRET`, `ANON_KEY`,
  `SERVICE_ROLE_KEY`, `POSTGRES_PASSWORD`, `SECRET_KEY_BASE`,
  `INTEGRATIONS_MASTER_KEY`. It is git-ignored and holds local-only values.

## Start

Run from the repo root, in this order:

```bash
docker compose -f dev-local/docker-compose.yml up -d
```

```bash
bash dev-local/migrate.sh
```

```bash
bash dev-local/seed.sh
```

```bash
bash dev-local/dev.sh
```

`migrate.sh` and `seed.sh` can be run again safely. `migrate.sh` records each
applied file in `_devlocal.applied` and applies only new ones. `seed.sh` skips
accounts that already exist.

## URLs

| What | URL |
|---|---|
| Company Alpha | http://alpha.localhost:8080 |
| Company Beta | http://beta.localhost:8080 |
| Staff sign-in | `/auth` on a company host |
| Renter portal sign-in | `/portal/auth` on a company host |
| Supabase Studio | http://localhost:54323 |
| Mailpit (sent emails) | http://localhost:54324 |
| Supabase API (Kong) | http://localhost:54321 |
| Postgres | `localhost:54322`, user `postgres` |
| Redis | `localhost:56380` |

The super admin panel (`admin.localhost`) cannot be tested yet: the
`platform_admins` table and `/platform/*` routes are not built.

## Test accounts

Both companies have the same usernames, because usernames are unique per
company only:

| Username | Role |
|---|---|
| `admin` | Admin |
| `accountant` | Accountant |
| `collector` | Collector |
| `readonly` | Read-only |
| `tenant` | Renter (linked to renter `T-<company>-001`) |

Password for every account: `Ijary-Local-2026!` (local test value; set
`SEED_PASSWORD` before running `seed.sh` to use another).

Company Alpha is the company the legacy migrations leave behind. Its slug is
immutable, so it keeps its generated slug and is reached through the
`alpha.localhost` domain row.

## Reset

Delete all local data and start over:

```bash
docker compose -f dev-local/docker-compose.yml down -v
```

Then repeat the Start steps.
