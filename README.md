# IJARY

IJARY is a multi-company estate rental management SaaS for Kuwait. One deployment serves many customer businesses, each with its own properties, buildings, units, renters, contracts, invoices, payments, staff and integrations.

The code was converted in place from a single-company ERMP codebase; the conversion is specified in [`specs/001-multi-company-saas/`](specs/001-multi-company-saas/). The UI is bilingual Arabic (RTL) and English.

Terminology used throughout the code and docs:

| Term        | Meaning                                                       |
| ----------- | ------------------------------------------------------------- |
| Company     | A customer business of the platform; never called a "tenant". |
| Renter      | A person who rents a unit from a company.                     |
| Staff       | A company employee using the company admin panel.             |
| Super admin | The platform owner's account, outside all companies.          |

## Hosts

| Host               | Serves                                                                 | Company context    |
| ------------------ | ---------------------------------------------------------------------- | ------------------ |
| `ijary.app`        | Temporary platform page with a sign-in entry                           | None               |
| `admin.ijary.app`  | Super admin panel (`/platform/*`)                                      | None               |
| `<slug>.ijary.app` | Company sign-in, admin panel (`/admin/*`), renter portal (`/portal/*`) | The owning company |

Any other host gets a 404 without revealing a company. `/platform/*` returns 404 on company hosts; `/admin/*` and `/portal/*` return 404 on the platform and super admin hosts. `/api/public/*` provider callbacks are exempt from host gating and resolve their own company in the handler. See [`contracts/company-context.md`](specs/001-multi-company-saas/contracts/company-context.md) and [`src/routes/README.md`](src/routes/README.md).

## Runtime

- **Web**: TanStack Start (React 19) on Nitro, built by Vite as a single full-stack application.
- **Worker**: a second entry point of the same codebase (`src/worker/main.ts`), running BullMQ queue processors, the outbox relay and schedules.
- **Redis**: queue state for those jobs only. The `job_requests` Postgres outbox is the source of truth; the web app does not use Redis.
- **Database**: self-hosted Supabase — PostgreSQL, GoTrue, PostgREST, Storage, Realtime and Kong. Company secrets are encrypted in Postgres; storage paths are separated under `companies/<company_id>/...`.
- **Deployment**: separate Dokploy applications for the web app, the Supabase stack and `deploy/ijary/docker-compose.yml` (Redis and the worker), behind Traefik and Cloudflare.

## Commands

Every `bun run` command below is declared in [`package.json`](package.json). `bun install` is Bun's own dependency-install command, not a package script.

| Command             | What it does                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| `bun install`       | Install dependencies from the lockfile.                                     |
| `bun run dev`       | Start the Vite dev server.                                                  |
| `bun run build`     | Build the web app for production.                                           |
| `bun run build:dev` | Build the web app in development mode.                                      |
| `bun run preview`   | Preview the built web app.                                                  |
| `bun run lint`      | Run ESLint.                                                                 |
| `bun run typecheck` | Run TypeScript with `--noEmit`.                                             |
| `bun run format`    | Format the repository with Prettier.                                        |
| `bun run test`      | Run the Vitest unit suite.                                                  |
| `bun run gen:types` | Write `database.types.generated.ts` as a reference for hand-merging.        |
| `bun run test:db`   | Provision or reuse the Postgres instance used by the SQL integration tests. |
| `bun run test:sql`  | Run the SQL integration tests against that Postgres instance.               |
| `bun run worker`    | Run the background worker process locally.                                  |

## Database and types

Schema changes are plain SQL migrations, applied manually. See [`db/README.md`](db/README.md) for the numeric run order, the enforced company-isolation rules and the SQL test commands. `src/integrations/supabase/database.types.ts` is hand-maintained; `bun run gen:types` does not overwrite it.

## Deployment

The stack, environment variables, migration procedure, backups, worker and wildcard address are documented in [`deploy/ijary/README.md`](deploy/ijary/README.md).

Danat's production deployment and data are out of bounds. No command or deployment from this repository targets it; IJARY is a separate deployment. Do not touch any server without the owner's explicit go-ahead at that moment.

## Agent guidance

Rules for coding agents are in [`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md).
