# Implementation Plan: IJARY Multi-Company SaaS Conversion

**Branch**: `001-multi-company-saas` (no git branch exists yet; see Open Items) | **Date**: 2026-11-26 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-multi-company-saas/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command; its definition describes the execution workflow.

## Summary

Convert the single-company Danat platform into IJARY, serving many companies from one deployment with complete separation between them, a super admin panel, per-company payment gateways and WhatsApp, and a background worker for slow operations.

Technical approach, from [research.md](./research.md):

- **Isolation in the database.** Every table carries `company_id`. One SQL function, `current_company_id()`, tells every RLS policy which company the caller belongs to; it returns nothing for an unknown, suspended or expired caller, so access fails closed.
- **No more RLS bypass in feature code.** The 92 files that use the service-role key switch to `companyClient(companyId)`, which runs as a new non-bypassing role bound to one company. The service-role key stays only in a small, lint-enforced platform area.
- **Outbox in front of BullMQ.** The web app records deferred work in a `job_requests` table; a worker relays it to BullMQ on Redis. Enqueueing is transactional with the change, survives Redis or worker downtime, and gives one path for all jobs.
- **Company from the address.** `<slug>.ijary.app` resolves to a company in server middleware; accounts are per company on a single GoTrue through synthetic auth emails.
- **Per-company integrations.** Encrypted secrets per company; a `PaymentGateway` interface with three adapters; one WhatsApp connection table replacing the singleton; webhooks routed by connection id.

## Technical Context

**Language/Version**: TypeScript 5 (strict); SQL for PostgreSQL 17. Web runtime Bun 1.x; worker runtime Node LTS until BullMQ on Bun is verified (R6).

**Primary Dependencies**: TanStack Start (React 19) on Nitro, Tailwind CSS 4, shadcn/ui, react-hook-form, Zod, `@supabase/supabase-js`, pdfkit, nodemailer, jszip. New: `bullmq`, `ioredis` (worker only), `jose` (signing company and support-session tokens).

**Storage**: Self-hosted Supabase — PostgreSQL 17, GoTrue, PostgREST, Storage, Realtime, Kong, Supavisor. New: Redis 7 (job tickets only; Postgres remains the source of truth). Encrypted secrets in Postgres with the master key in the environment.

**Testing**: Vitest unit tests beside the code (`bun run test`); SQL integration tests on a real Postgres (`bun run test:sql`, database built by `bun run test:db`). New suites: `src/db/isolation/` (structure and two-company behaviour), `src/db/outbox/`, gateway adapter contract tests against sandboxes, worker handler idempotency tests.

**Target Platform**: Linux containers on the owner's Contabo server under Dokploy and Traefik, behind Cloudflare. Containers: web, worker, redis, the Supabase stack, one Evolution server.

**Project Type**: Web application — a single full-stack TanStack Start project plus a worker entry point in the same codebase.

**Performance Goals**: Deferred actions respond in under 2 s at the 95th percentile (SC-003); a job starts within about 1 s of its request; another company's notification is delivered within 1 minute during a 10,000-row import (SC-006); policies use hoisted scalar sub-selects so the company check runs once per statement.

**Constraints**: Danat production untouched (SC-016). No second company before the isolation suite is fully green (FR-011). Files under 500–600 lines; an Arabic doc comment above every function; `database.types.ts` hand-maintained; migrations are manual numbered SQL verified by `bun run test:db`. No cookie scoped to the parent domain. No external call while holding a database transaction.

**Scale/Scope**: Tens of companies, each up to a few thousand units. Existing surface to convert: 76 tables, about 248 policies, 186 functions, 92 service-role call sites, 14 storage buckets, 10 scheduled jobs. New: about 16 tables, 6 queues, about 30 job kinds, 8 webhook routes, about 35 server functions, a super admin panel.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is still the unfilled template, so it defines no gates. Until `/speckit-constitution` is run, the gates are the standing project rules in `CLAUDE.md`:

| Gate | Source | Status after design |
|---|---|---|
| RLS policies wrap auth helpers in scalar sub-selects | `CLAUDE.md`, `rlsHoistedAuth.sqltest.ts` | Pass — policy shape in [contracts/company-context.md](./contracts/company-context.md) uses `(select public.current_company_id())`. |
| Money-moving logic stays in SQL server functions; multi-table money changes are atomic with their audit row | `CLAUDE.md` | Pass — those functions stay synchronous (FR-013); their events use `enqueue_job` in the same transaction. |
| Service-role key is server-only and never the default | `CLAUDE.md` security rules | Pass, strengthened — confined to an allow-list. |
| Scheduled jobs are idempotent | `CLAUDE.md` | Pass — deterministic dedupe keys; handlers idempotent by contract. |
| A bounced email goes to `needs_review`, never `failed` | `CLAUDE.md` | Pass — carried in [contracts/webhooks.md](./contracts/webhooks.md). |
| File ceiling 500–600 lines; Arabic doc comment per function | `CLAUDE.md` | Pass by structure — new code is split by responsibility (see tree). |
| Guard skills on every implementation; lint, typecheck, test before commit | `CLAUDE.md` | Applies to every task. |
| Migrations verified from a clean database | `CLAUDE.md` | Pass — R20. |
| Never commit `.env`; no secrets in docs | `CLAUDE.md` | Pass — `.env` is ignored; secrets are encrypted at rest. |

No violation needs justification. Two rules in `CLAUDE.md` are wrong for IJARY and are corrected in Phase 1a rather than followed: "any push to `main` auto-deploys" and "use `ssh-danatfuture-mcp`", both of which describe Danat's production.

## Project Structure

### Documentation (this feature)

```text
specs/001-multi-company-saas/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: 21 decisions
├── data-model.md        # Phase 1: tables, rules, context functions
├── quickstart.md        # Phase 1: validation per delivery phase
├── contracts/
│   ├── company-context.md   # Hosts, clients, claims, policy shape, errors
│   ├── jobs.md              # Enqueue, relay, handlers, queues, catalogue
│   ├── webhooks.md          # Public routes and settlement guarantee
│   └── server-functions.md  # Super admin, company and changed functions
├── checklists/requirements.md
└── tasks.md             # Created later by /speckit-tasks
```

### Source Code (repository root)

```text
db/migrations/                    # 254_… onward: context, company_id per table group,
                                  # policies, function audit, singletons, counters, storage,
                                  # platform tables, jobs, gateways, whatsapp
src/
├── company/                      # NEW — company context
│   ├── hostCompany.server.ts     #   Host → company (platform client, cached)
│   ├── requestCompany.server.ts  #   getRequestCompany / requireRequestCompany
│   ├── companyClient.server.ts   #   companyClient(companyId) and token signing
│   ├── modules.ts                #   section keys, permission → section map
│   └── limits.ts                 #   limit error mapping
├── platform/                     # NEW — the only feature code allowed the service role
│   ├── companies.ts  users.ts  modules.ts  subscriptions.ts  limits.ts
│   ├── supportSession.ts  overview.ts  audit.ts  authAdmin.server.ts
├── jobs/                         # NEW — job catalogue and handlers
│   ├── catalog.ts  enqueue.ts
│   └── handlers/                 #   one file per kind family
├── worker/                       # NEW — worker entry point
│   ├── main.ts  relay.ts  queues.ts  scheduler.ts  pacing.ts
├── gateways/                     # NEW — PaymentGateway interface and adapters
│   ├── types.ts  registry.ts  myfatoorah.ts  tap.ts  upayments.ts
├── whatsapp/                     # NEW — per-company connections
│   ├── evolutionInstance.ts  cloudApi.ts  embeddedSignup.ts  routing.ts
├── lib/secrets.server.ts         # NEW — AES-256-GCM encrypt and decrypt
├── fns/                          # CHANGED — 80 files move to companyClient; slow ones enqueue
├── integrations/supabase/        # CHANGED — client.server.ts becomes the platform client;
│                                 #   database.types.ts hand-updated
├── components/
│   ├── admin/AdminSidebar.tsx    # CHANGED — built from enabled sections
│   ├── admin/settings/           # NEW cards: payment gateway, WhatsApp, usage
│   └── platform/                 # NEW — super admin screens
├── routes/
│   ├── platform.*.tsx            # NEW — super admin routes (admin host only)
│   ├── suspended.tsx             # NEW
│   ├── index.tsx                 # CHANGED — temporary page or redirect to sign-in
│   └── api/public/webhooks/      # NEW — provider and connection routes
└── db/
    ├── isolation/                # NEW — structure and two-company tests
    └── outbox/                   # NEW — transactional enqueue tests
server/middleware/                # NEW — host resolution, suspended page
deploy/ijary/                     # NEW — compose for redis and worker, Traefik wildcard, runbook
Dockerfile                        # CHANGED — second target for the worker
CLAUDE.md                         # CHANGED — rewritten for IJARY
```

**Structure Decision**: Keep the single TanStack Start project. New code goes into six responsibility folders (`company`, `platform`, `jobs`, `worker`, `gateways`, `whatsapp`) rather than into the already large `src/fns`. The worker is a second entry point of the same codebase, not a separate package, so handlers reuse the existing notification, PDF and settlement code unchanged. A monorepo split was considered and rejected: it would move every import path in a codebase whose main risk is already the breadth of the change.

## Delivery Phases

The order was agreed with the owner. Each phase ends at a gate; the checks are in [quickstart.md](./quickstart.md).

### Phase 1a — Isolation foundation (User Story 1)

1. Housekeeping: put the folder under version control (Open Items); rewrite `CLAUDE.md` for IJARY; add the lint rule restricting `client.server.ts`.
2. Migrations: `company_service` role and `current_company_id()`; extend `companies`; `company_domains`, `reserved_slugs`.
3. Migrations by table group (identity, lists, properties, contracts, billing, money ledgers, closeout, electricity, HR, notifications, messaging, landing, system): add or tighten `company_id`, backfill, composite keys, per-company uniques, lead indexes with `company_id`.
4. Rewrite the policies of each group to the contract shape.
5. Audit all 186 functions: invoker where possible, explicit company predicate otherwise; remove the 17 "oldest company" lookups.
6. Singletons to per-company; `company_counters` behind the existing `next_*_code()` names.
7. Storage: path prefix in all upload sites; bucket policies.
8. Code: `companyClient`; move the 92 call sites; remove the 15 "oldest company" lookups; remove `eraseAllData` from the panel.
9. Tests: structure tests and the generated two-company matrix.

**Gate**: isolation suite 100% green (SC-001); `bun run test:db` clean; all existing tests still pass.

### Phase 1b — Background worker (User Story 2)

1. `job_requests`, `user_notices`, `enqueue_job`; Redis and worker containers; relay, queues, schedulers.
2. Move sending: `notification.dispatch` with per-connection pacing; then documents; then bulk kinds; then syncs and cron fan-out.
3. Money outbox: emit events from the SQL functions; convert the event senders to handlers.
4. Notices in the panel; failed-job list and retry.
5. Remove `/api/public/cron` and the external crontab from the runbook.

**Gate**: SC-003 to SC-006; worker-down check passes.

### Phase 2 — Addresses, sign-in, super admin (User Stories 3 to 7)

1. Host middleware; route gating by host; temporary root page; not-found and suspended pages; wildcard address and certificate on the server.
2. Per-company accounts: synthetic auth emails, `signInWithIdentifier`, password reset flow, user management functions.
3. Super admin: `platform_admins`, enforced second factor, panel shell, platform audit log.
4. Companies: create with seeding, list, edit, suspend and reactivate.
5. Sections: `company_modules`, `has_permission` change, sidebar and dashboard from enabled sections, worker skip.
6. Subscriptions: records, reminder job, banner.
7. Limits: triggers, counters, storage check, usage screen.

**Gate**: quickstart Phase 2 steps 1 to 11; SC-002, SC-007 to SC-010, SC-015. From here a second real company may be onboarded.

### Phase 3 — Payment gateways (User Story 8)

1. `company_secrets` and the secrets module; `gateway_connections`; settings card with test and activate.
2. `PaymentGateway` interface; MyFatoorah adapter from the existing code; webhook route by connection; `payment_requests` binding; reconciliation per company.
3. Tap adapter, then UPayments adapter, each when its sandbox account exists.

**Gate**: per gateway, SC-012 in sandbox before live mode is allowed; SC-011.

### Phase 4 — WhatsApp and default email (User Stories 9 and 10)

1. `whatsapp_connections`; Evolution instance per company; webhook by connection; inbox tables scoped; disconnect alert per company.
2. Official API: Meta webhook routing by number; Embedded Signup with coexistence; manual credentials path; template binding checks.
3. Email: per-company sender secrets; platform default sender with company name and reply address; Resend webhooks per company and for the platform sender.

**Gate**: quickstart Phase 4; SC-013, SC-014.

### Phase 5 — Support access and overview (User Stories 11 and 12)

1. Support sessions: start with reason, token mint, banner, expiry, audit actor, refusals.
2. Overview: aggregate functions, health flags, usage, failed items.

**Gate**: quickstart Phase 5.

### Last — Custom domains and landing pages (User Story 13)

Custom hostnames through Cloudflare; super admin screens to add and verify; landing page section switched on per company; platform marketing page replacing the temporary page.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| A `security definer` function is missed in the audit | Cross-company read or write | Structure test fails any definer function not naming `current_company_id`; behaviour tests per table. |
| A service-role call site is missed | RLS bypass | Lint rule with an allow-list; the build fails. |
| The policy rewrite breaks an existing behaviour | Regression in money paths | All 133 existing SQL test files must stay green group by group; one table group per change. |
| `current_company_id()` adds cost to every statement | Slower lists | Hoisted sub-select, stable function, primary-key lookup; measure with the existing invoice-count benchmark from migration 243. |
| BullMQ on Bun is unstable | Worker crashes | Worker on Node LTS; web app does not use Redis at all. |
| Three gateways and three WhatsApp methods | Long tail of provider detail | One adapter at a time behind a fixed interface; provider specifics marked VERIFY and checked before each task. |
| Wildcard certificate under Dokploy | Company addresses do not open | Verified first in Phase 2; fallback is a Cloudflare origin certificate. |
| An agent follows the old `CLAUDE.md` | Action against Danat's production | `CLAUDE.md` rewritten in the first task; SC-016 check before every deployment step. |
| Unofficial WhatsApp QR connections get numbers blocked | A company loses its channel | Per-connection pacing; official API offered alongside. |

## Open Items for the Owner

None blocks the design. Each blocks only the task named.

1. **Version control** (blocks all implementation): this folder is untracked inside `lolotam/IJARY` and has no history. Recommended: commit it to that repository on a `001-multi-company-saas` branch. `.env` is already ignored.
2. **Sandbox accounts for Tap and UPayments** (blocks Phase 3 step 3).
3. **Meta application details** — app id, app secret, Embedded Signup configuration id (blocks Phase 4 step 2).
4. **Cloudflare API token** scoped to the `ijary.app` zone, and access to the Dokploy instance (blocks Phase 2 step 1).
5. **Platform default email sender** — which address and provider IJARY sends from (blocks Phase 4 step 3).
6. **Constitution**: run `/speckit-constitution` to turn the `CLAUDE.md` rules into formal gates, if wanted.

## Complexity Tracking

No constitution violations to justify. Three additions go beyond the simplest possible build and are recorded here with their reason:

| Addition | Why needed | Simpler alternative rejected because |
|---|---|---|
| Second Postgres role and token signing (`company_service`) | Server code must be subject to RLS (FR-003, FR-004) | Filtering in application code is the current state and is the defect being fixed. |
| Outbox table in front of BullMQ | Transactional enqueue for money events; work survives Redis downtime (FR-018, FR-020) | Direct `queue.add()` can notify for a rolled-back payment or lose a notification. |
| Redis and a worker container | Owner's decision; retries, backoff, rate limiting and schedules | A Postgres-only queue was offered and declined. |
