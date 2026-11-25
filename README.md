# Danat Al Mustaqbal ERMP — دانة المستقبل العقارية

Estate Rental Management Platform (ERMP) for **Danat Al Mustaqbal Real Estate** (Kuwait).
A full-stack TanStack Start application covering property/tenant/contract management, an
invoice & payment engine (MyFatoorah), a tenant self-service portal, notifications
(Email + WhatsApp), expenses, deposits, and electricity billing — backed by a
**self-hosted Supabase** stack.

- **Live app:** https://danat-future.com
- **Supabase (self-hosted):** https://supabase.danat-future.com
- **GitHub:** https://github.com/lolotam/Dana-kuwait
- **Lovable:** connected — commits pushed to `main` sync back to the Lovable editor

---

## Tech stack

| Layer                     | Technology                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| Runtime / package manager | Bun end-to-end (`bun.lock`, `bunfig.toml`; Docker runs `oven/bun:1-slim`, `NITRO_PRESET=bun`) |
| Framework                 | TanStack Start (React 19) + Nitro 3 server                                                    |
| Routing / data            | TanStack Router (file-based, `src/routes/`) + TanStack Query 5                                |
| UI                        | Tailwind CSS 4, shadcn/ui (Radix primitives), lucide-react, Recharts, sonner                  |
| Forms / validation        | react-hook-form + Zod                                                                         |
| Backend-as-a-service      | Self-hosted Supabase (Postgres 17, GoTrue auth, PostgREST, Storage, Realtime, Kong)           |
| Payments                  | MyFatoorah gateway (Kuwait) — server functions + signed webhook                               |
| Notifications             | SMTP / Resend (email), WhatsApp Cloud API                                                     |
| i18n                      | Custom dictionary (`src/i18n/`) — Arabic (RTL) + English                                      |
| Build / quality           | Vite 8, TypeScript 5.8, ESLint 9, Prettier, Vitest                                            |
| Containerization          | Multi-stage `Dockerfile` (non-root, healthchecked), `docker-compose.yml`                      |
| Hosting                   | Dokploy (Docker Swarm + Traefik) on Hetzner Ubuntu 24.04 — the Danat-Future host              |

## Project structure

```
src/
  routes/            # File-based routes (see src/routes/README.md)
    admin.*.tsx      # 15 admin modules: properties, units, tenants, contracts,
                     # invoices, payments, deposits, expenses, electricity,
                     # reports, audit, settings (users/roles/lists/notifications)
    portal.*.tsx     # Tenant portal: invoices, payments, receipts, lease, profile
    api/public/      # cron.ts (scheduled jobs), myfatoorah-webhook.ts
    index.tsx        # Public landing page
    auth.tsx         # Login (staff + tenant)
  fns/               # Server functions (money-moving logic + jobs + tests)
  auth/              # AuthProvider, login identifier resolution
  components/        # UI components (admin/, portal/, ui/ …)
  i18n/              # AR/EN dictionary + provider
  integrations/supabase/  # Clients + generated database.types.ts
db/
  migrations/        # 00–15 plain SQL migrations, run manually (see db/README.md)
  policies/          # RLS policies
supabase/migrations/ # Later incremental migrations (e.g. MyFatoorah v3 webhook events)
deploy/              # Dokploy/nginx deployment docs (deploy/README.md)
scripts/gen-types.sh # Regenerate Supabase TS types
```

## Getting started (local dev)

```bash
bun install
cp .env.example .env       # fill in Supabase URL + keys (see below)
bun run dev                # Vite dev server
```

Quality gates:

```bash
bun run lint        # ESLint
bun run typecheck   # tsc --noEmit
bun run test        # Vitest (money-path unit tests in src/fns/*.test.ts)
bun run build       # production build
```

## Environment variables

Copy `.env.example`. Key groups (full list and comments in that file):

- **Client (baked into the browser bundle at build time):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SENTRY_DSN` (optional; empty disables Sentry)
- **Build-time secret (never baked, never at runtime):** `SENTRY_AUTH_TOKEN` (optional; lets the Vite plugin upload source maps). Supply it as a BuildKit secret (`docker build --secret id=SENTRY_AUTH_TOKEN,env=SENTRY_AUTH_TOKEN`, or Dokploy **Build Secrets**), never as an env var or build arg
- **Server-only:** `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS — never `VITE_`-prefix it), `SENTRY_DSN` (optional; falls back to `VITE_SENTRY_DSN`)
- **Payments:** `MYFATOORAH_API_KEY`, `MYFATOORAH_BASE_URL`, `MYFATOORAH_WEBHOOK_SECRET`
- **Notifications:** `SMTP_*` or `RESEND_*`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`
- **Cron:** `CRON_SECRET` — required or `POST /api/public/cron` returns 503

## Database

All schema ships as **plain SQL migrations applied manually** to the self-hosted
Supabase Postgres (the project intentionally does _not_ use Lovable Cloud).
Apply `db/migrations/00_*.sql` → `09_*.sql` in numeric order (`10`–`15` are
optional: contact inquiries, mock data, reset, option lists, property media,
Kuwait mock data), then anything under `supabase/migrations/`. All migrations are
idempotent. After schema changes, regenerate types:

```bash
bun run gen:types   # scripts/gen-types.sh → src/integrations/supabase/database.types.ts
```

## Deployment — Dokploy on the Danat-Future host

Production moved to this host in July 2026; the previous one (`WaleedU`,
`116.202.66.131`) is retired. Managed through Dokploy (full runbook:
`deploy/README.md`; container names in `CLAUDE.md` → "Production").

| Item            | Value                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Server hostname | `danat-future` (OS hostname; `Waleed3` in `CLAUDE.md` names the same machine)                                                 |
| Public IP       | `49.12.59.137`, behind Cloudflare                                                                                             |
| OS              | Ubuntu 24.04.4 LTS (kernel 6.8), Docker 29.x in Swarm mode                                                                    |
| Resources       | 4 vCPU · 15 GiB RAM · 193 GB disk                                                                                             |
| Panel           | Dokploy (Traefik reverse proxy, auto-TLS)                                                                                     |
| Dokploy project | app `danatfuture-danatfuture-vk5hnn` + compose `danatfuture-supabase-ozoxsa`                                                  |
| App URL         | https://danat-future.com (Traefik `Host` rule → container port 3000)                                                          |
| Supabase stack  | Compose on same host: Postgres 17.6, Kong 3.9, GoTrue, PostgREST 14, Storage, Realtime, Studio, Supavisor, Logflare, imgproxy |

Deploy flow: push to `main` → Dokploy builds the multi-stage `Dockerfile`
(remember `VITE_*` vars are build args) → Traefik routes the domain to the new
container. The app joins the Supabase stack's network so `SUPABASE_URL` resolves.

### Scheduled jobs

Ten idempotent jobs — the keys of `JOBS` in `src/fns/cronJobs.ts` — run via
`POST /api/public/cron` with `Authorization: Bearer $CRON_SECRET`. Cadences,
crontab entries and the `asOf` rules are in `deploy/README.md`.

## Direction & roadmap

Phases 0–7 of `.lovable/plan.md` are implemented (all 15 admin modules, tenant
portal, invoice/payment engine, notifications, expenses, electricity), and the
platform is live at https://danat-future.com with all ten scheduled jobs
running. What remains is tracked in `TODO.md`:

1. **Smaller gaps** — chronological invoice order as a real invariant, CSV
   deposit import linking, leasing-request email, the decided 1-day default
   grace period, fail-fast env validation at startup, civil ID/document
   retention enforcement.
2. **Test coverage** — the `evaluateOverdue` day/grace boundary.
3. **Open business decisions** — whether existing contracts move to the 1-day
   grace period, final brand colour tokens.
4. **Out of scope by design** — Phase 8 "Dana-bot", native mobile apps,
   Lovable Cloud.

## For AI agents

Agent-facing rules live in [`AGENTS.md`](AGENTS.md) and [`CLAUDE.md`](CLAUDE.md)
(MCP server names for SSH/Dokploy access, Lovable git-history rules, graphify
knowledge-graph usage).

## Testing guide

Use [`docs/ENDPOINTS_GUIDE.md`](docs/ENDPOINTS_GUIDE.md) for the complete route,
server-function, public HTTP endpoint, authorization, test-data, and TestSprite
guidance. For direct API tests, use only the allowlist in
[`docs/TESTSPRITE_BACKEND_TARGETS.md`](docs/TESTSPRITE_BACKEND_TARGETS.md).
Keep real test credentials only in ignored local files such as
`.testsprite/test-credentials.local.md`.
