# CLAUDE.md

Guidance for coding agents working in this repository.

## What this project is

**IJARY** — Multi-company Estate Rental Management SaaS (Kuwait), converted in
place from the single-company Danat Al Mustaqbal ERMP codebase (see
`specs/001-multi-company-saas/`). Features include property/building/unit,
renter, and contract management; invoice and payment engine (per-company
gateways: MyFatoorah, Tap, UPayments); renter portal; notifications (SMTP/Resend
email with platform default sender + per-company WhatsApp via QR/Evolution or
official Cloud API); expenses, deposits, electricity billing, HR/salaries; a
super admin panel (`/platform/*`); and a background worker (BullMQ + Redis
fronted by a Postgres transactional outbox). Bilingual Arabic (RTL) / English via
`src/i18n/`.

The repo is **Lovable-connected**: never force-push, rebase, amend, or squash
commits already pushed to `main`.

### Terminology

Always use these terms consistently across code, specs, and docs:

- **Company**: a customer of the platform (a real-estate business). Keep the
  existing `companies` table and `company_id` column name; **never** use the
  word "tenant" to refer to a company.
- **Renter**: the person who rents a unit from a company (called `tenants` /
  `tenant` in legacy schema and code).
- **Staff**: a company's employees who use the company admin panel (`/admin/*`).
- **Super admin**: the platform owner's account, outside all companies, using
  the platform panel (`/platform/*`).

## Danat production is out of bounds

- **Danat's existing production deployment and data are strictly out of bounds.**
- **No command, migration, script, or deployment in this repository targets
  Danat's production** (`ssh-danatfuture-mcp`, `danatfuture-*` containers, or
  Danat's live server/database).
- IJARY is a separate deployment on the owner's Contabo server managed with
  Dokploy and Traefik behind Cloudflare (`ijary.app`). Danat's live data is not
  migrated in this conversion.
- Do not deploy or touch any server without the owner's explicit go-ahead at that
  moment.

## Commands (Bun)

```bash
bun run dev          # Vite dev server
bun run build        # production build
bun run lint         # ESLint
bun run typecheck    # tsc --noEmit
bun run test         # Vitest unit tests
bun run format       # Prettier
bun run gen:types    # write generated types to database.types.generated.ts (reference only)
bun run test:sql     # SQL integration tests against a real Postgres (needs Docker)
bun run test:db      # provision/refresh that Postgres from scratch
bun run worker       # background worker process (added in Phase 1 setup)
```

Run `bun run lint`, `bun run typecheck`, and `bun run test` (plus
`bun run test:sql` when SQL changes) before presenting or committing work.

## Coding standards

### File size: 500–600 lines is the ceiling

Keep every new file under **500–600 lines**. Past that, split by responsibility —
not by technical layer — so each file has one clear job and things that change
together stay together. When a file you are already working in has grown past
the ceiling, splitting it is in scope; do not refactor unrelated large files you
merely read.

Existing files past 600 lines: `src/integrations/supabase/database.types.ts`
(hand-maintained types), `src/components/ui/sidebar.tsx` (vendored shadcn),
`src/routeTree.gen.ts` (generated — leave all three), and eleven large legacy
test files (`src/db/contractCloseout.sqltest.ts`,
`src/db/invoiceRegeneration.sqltest.ts`, `src/fns/resendWebhook.test.ts`,
`src/fns/createPayment.test.ts`, `src/lib/adminTableSortValues.test.tsx`,
`src/fns/resolveTemplateVariables.test.ts`, `src/db/depositInvoiceLink.sqltest.ts`,
`src/db/contractScheduleSync.sqltest.ts`, `src/db/dashboardAggregates.sqltest.ts`,
`src/db/moduleSummaries.sqltest.ts`, `src/lib/paymentReceiptPdf.test.ts`) — split
one when you next add cases to it.

### Document functions in Arabic, above the function

Every function gets a doc comment **before** it, leading with an Arabic
description of what the function does. English may follow for terms with no
settled Arabic equivalent, and for the _why_ — the reasoning, trade-off, or
incident behind a non-obvious choice.

```ts
/**
 * يحسب إجمالي الإيجار الشهري للعقد من إيجارات الوحدات المرتبطة به.
 *
 * Mirrors the database trigger that maintains `contracts.monthly_amount`;
 * the join table is the source of truth, this is the client-side view of it.
 */
export function totalMonthlyAmount(rows: Array<{ monthly_amount: number }>): number {
```

Arabic is the product's primary language and the UI is RTL. Comments explain
_why_, never restate _what_ the next line does.

### Guard skills are required, not optional

Gates prove the code runs; they do not prove it is good. On **every** feature
implementation — your own or a delegated agent's — apply the matching guard
before presenting, committing, or merging:

- **`clean-code-guard`** after any production code is written, edited,
  refactored, or fixed.
- **`test-guard`** after any test is written or edited, and when reviewing test
  files.
- **`docs-guard`** after any docstring, README, changelog, or documentation
  change.

## Company context & multi-company isolation

Full contract: `specs/001-multi-company-saas/contracts/company-context.md`.

### Hosts and route gating

| Host | Serves | Company context |
|---|---|---|
| `ijary.app` | Temporary platform page with sign-in entry (later marketing page) | None |
| `admin.ijary.app` | Super admin panel (`/platform/*` routes only) | None |
| `<slug>.ijary.app` (or verified custom domain) | Company sign-in, admin panel (`/admin/*`), renter portal (`/portal/*`) | Owning company |
| Any other host | 404 page (reveals no company) | None |

- `/platform/*` returns 404 on company hosts; `/admin/*` and `/portal/*` return
  404 on the platform root and super admin hosts.
- Never set any cookie with a parent-domain scope (e.g., `Domain=.ijary.app`).

### Request context (server)

Resolved once per request by host middleware and read via `getRequestCompany()`
or `requireRequestCompany()` (throws `COMPANY_REQUIRED` when no company is set):

- `RequestCompany`: `{ id, slug, status: "active" | "suspended", host }`.
- After authentication, `profile.company_id !== requestCompany.id` must be
  treated as not signed in, without revealing that the account exists elsewhere.
- When `status === "suspended"`, every route except the suspended page and public
  webhook routes responds with the suspended page.

### Database clients & role separation

| Client | Postgres role | Who may import it | Company source |
|---|---|---|---|
| Browser `supabase` | `authenticated` / `anon` | Client code | `profiles.company_id` via `current_company_id()` |
| `companyClient(companyId, opts?)` | `company_service` | Server functions & job handlers | Signed JWT claim |
| `platformClient` (legacy `supabaseAdmin`) | `service_role` | Only allow-listed platform files (`src/platform/**`, `src/company/hostCompany.server.ts`, `src/worker/relay.ts`, `src/worker/scheduler.ts`) | None; bypasses RLS |

- `companyClient(companyId, opts?)` throws `COMPANY_REQUIRED` if `companyId` is
  empty or not a UUID, and signs a 5-minute JWT (`{ role: "company_service",
  company_id, allow_suspended?: true }`).
- `allowSuspended: true` may be passed **only** by the payment settlement path.
- Importing `client.server.ts` outside the ESLint allow-list fails `bun run lint`.

### JWT claims & SQL contract

- Claims read by Postgres: `role`, `sub` (`auth.uid()`), `aal`
  (`is_platform_admin()` requires `aal2`), `company_id` (read only for
  `company_service`; ignored on `authenticated`), `allow_suspended`,
  `impersonator`, and `impersonation_session`.
- Core SQL helpers: `public.current_company_id()` (returns `null` on missing,
  suspended, or expired context so every policy fails closed),
  `public.is_platform_admin()`, and `public.module_enabled(_key)`.
- Every company-scoped table policy targets `authenticated, company_service` and
  hoists the context call inside a scalar sub-select:
  `company_id = (select public.current_company_id())` alongside hoisted auth
  helpers such as `(select public.is_staff((select auth.uid())))`. Never write
  bare `is_staff(auth.uid())` or unhoisted `current_company_id()`.
- Structure rules enforced by SQL tests:
  1. Every `public` table off the platform allow-list (`permissions`,
     `reserved_slugs`, platform tables) has `company_id`, forced RLS, and
     policies containing `current_company_id`.
  2. Every `security definer` function in `public` references
     `current_company_id` or is on the platform allow-list; prefer
     `security invoker` where caller rights suffice.
  3. Never select `from companies … limit 1` ("oldest company" lookup is
     forbidden).
  4. Never grant `delete` on `companies` (suspension is the only access removal).

### Standard company-context error codes

`COMPANY_REQUIRED`, `COMPANY_SUSPENDED`, `MODULE_DISABLED`, `LIMIT_UNITS`,
`LIMIT_STAFF`, `LIMIT_STORAGE`, `LIMIT_WHATSAPP`, `SUPPORT_SESSION_FORBIDDEN`.

## Architecture

- **TanStack Start** (React 19) + Nitro server. File-based routing in
  `src/routes/` — read `src/routes/README.md` first; Next.js conventions
  (`src/pages/`, `app/layout.tsx`) are wrong here. `src/routeTree.gen.ts` is
  generated — never edit.
- **Server functions & background worker**: `src/fns/` holds company server
  functions, `src/platform/` holds super admin operations, `src/company/` holds
  host/context/module/limit helpers, and `src/jobs/` + `src/worker/` run
  deferred work via BullMQ and Redis fronted by the `job_requests` outbox table.
  - Money-moving mutations (recording/allocating/reversing payments, marking
    invoices paid/unpaid, closing out contracts, creating payment links) stay
    synchronous and atomic with their audit rows; any resulting notifications or
    events are enqueued via `enqueue_job()` inside the same SQL transaction.
  - `workflowRegistry` registers scheduled jobs and event-triggered workflows;
    event senders wrap themselves in `runEventWorkflow`.
  - `loadTemplateCopy` reads per-company templates from `notification_templates`,
    falling back to `src/lib/emailTemplates.ts` (`renderEmailDocument` wraps
    inner bodies unless they start with `<!doctype`/`<html`). `due_reminder`
    is seed-only.
  - Resend webhook moves permanently bounced notifications to `needs_review` and
    **never** to `failed` (the drain job retries `failed` rows).
- **Self-hosted Supabase**: Postgres 17 + GoTrue + PostgREST + Storage +
  Realtime behind Kong. Storage files are separated under
  `companies/<company_id>/...`.
- **Migrations are manual SQL**: `db/migrations/` in numeric order by leading
  migration number (`sort -V` / `parseInt`, not bare lexicographic order), then
  `supabase/migrations/`. See `db/README.md`. Verify every migration from a
  clean database with `bun run test:db`.
- **`database.types.ts` is hand-maintained**, despite looking generated. After a
  schema change run `bun run gen:types` (writes `database.types.generated.ts` as
  a reference), then hand-copy the new table/column/RPC entries into
  `src/integrations/supabase/database.types.ts`. Never overwrite the real file.
- **UI & domain invariants**: Tailwind CSS 4 + shadcn/ui (Radix) in
  `src/components/`, forms via react-hook-form + Zod, RBAC enforced through
  `has_permission` / RLS. Archived contracts (`archived_at is not null`) are
  excluded from invoice generation and reminders. Invoice state `waived` means
  written off; disputes use `disputed_at` / `dispute_reason`.
  `close_out_contract` writes audit rows from SQL via `write_audit` for
  atomicity.

## Security rules

- `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, and
  `INTEGRATIONS_MASTER_KEY` are server-only — never in a `VITE_` variable
  (anything `VITE_`-prefixed is compiled into the browser bundle).
- Never commit `.env` / `.env.production` or paste real keys into docs, code,
  or audit logs.
- Per-company gateway and provider secrets live encrypted (AES-256-GCM) in
  `company_secrets`; only `last4` may be returned to screens.

## graphify

A knowledge graph exists at `graphify-out/`. For codebase questions prefer
`graphify query "<question>"` (also `path`, `explain`) over raw grep; use
`graphify-out/wiki/index.md` for navigation and run `graphify update .` after
code changes. See `AGENTS.md` for the full graphify rules.
