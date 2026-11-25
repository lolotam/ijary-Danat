# Research: IJARY Multi-Company SaaS Conversion

**Feature**: [spec.md](./spec.md) | **Date**: 2026-11-26

Each entry records a decision, why, and what lost. Entries marked **VERIFY** depend on a third-party detail that must be checked against current vendor documentation or a short spike before the dependent task starts; they are not open product questions.

Facts measured in the codebase on 2026-11-25/26: 76 tables; 248 migrations (last `253_`); about 248 RLS policies; `company_id` on about 20 tables; 186 distinct `public` functions with 336 `security definer` occurrences across migrations; 12+ global code sequences; 92 production files import the service-role client `supabaseAdmin`; 133 files under `src/db`.

## R1. How the database knows the caller's company

**Decision**: One SQL function, `public.current_company_id()`, is the only source of the caller's company. Every RLS policy compares `company_id` with `(select public.current_company_id())` (hoisted scalar sub-select, as `CLAUDE.md` requires).

It resolves in this order:

1. Role `company_service` (server and worker): the `company_id` claim of the request JWT.
2. Role `authenticated` with an `impersonation_session` claim: the session's company, only while the session is open and unexpired.
3. Role `authenticated`: `profiles.company_id` of `auth.uid()`.
4. Anything else: `null`.

It returns `null` when the company is suspended, unless the JWT carries `allow_suspended = true` (payment settlement only). `null` matches no row, so every policy fails closed.

**Rationale**: The company comes from the database row, not from a token minted earlier, so a deactivated or moved account cannot keep a stale company. One function means one place to audit and one place where suspension and impersonation expiry take effect.

**Alternatives considered**:

| Alternative | Why it lost |
|---|---|
| Company in a GoTrue custom access-token claim, read with `auth.jwt()` | Stale until the token refreshes; a misconfigured hook yields tokens with no claim, and a policy written as `claim is null or …` would then be open. |
| Application adds `.eq("company_id", …)` everywhere | Fails FR-003: a forgotten filter exposes data. This is the current state. |
| One schema or database per company | 248 migrations and 186 functions per company; cross-company platform views become hard; no gain at tens of companies. |

## R2. Server and worker code must not bypass RLS

**Decision**: Add a Postgres role `company_service` (no `BYPASSRLS`, granted to `authenticator`). Server functions and worker jobs obtain a client from `companyClient(companyId)`, which signs a short-lived JWT (`role: company_service`, `company_id`, optional `allow_suspended`) with the project JWT secret. PostgREST switches to that role, so RLS applies with the company fixed by the token. `companyClient` throws when `companyId` is missing.

The true `service_role` client stays only in `src/platform/` (super admin operations, host resolution, the outbox relay, the cron fan-out, GoTrue admin calls). An ESLint `no-restricted-imports` rule fails any other import of `client.server.ts`, with the allow-list in the config.

SQL functions that today test `auth.role() = 'service_role'` to skip permission checks are changed to accept `company_service` for the permission skip only; the company predicate still applies.

**Rationale**: 92 files run with a key that ignores every policy. Filtering them by hand would be 92 chances to miss one. Changing the role they run as moves the guarantee into the database.

**Alternatives considered**:

| Alternative | Why it lost |
|---|---|
| Wrapper that injects `.eq("company_id")` on `supabaseAdmin` | Application-level; RPC calls and joins escape it. |
| Direct Postgres connection with `set local app.company_id` per transaction | A second data-access stack beside PostgREST; all 92 files rewritten rather than re-pointed. |
| Keep `service_role` and rely on tests | Tests prove the cases written, not the ones forgotten. |

**Consequence — `security definer` audit**: A `security definer` function runs as its owner and ignores RLS. Each of the 186 functions is classified: (a) switch to `security invoker` where it only needs the caller's rights; (b) keep definer and add an explicit `company_id = (select public.current_company_id())` predicate to every statement. A structure test fails any definer function whose body does not reference `current_company_id`, with an explicit allow-list for platform functions.

## R3. Accounts unique per company on a single GoTrue

**Decision**: `auth.users.email` is always synthetic and derived from the user id: `<user-uuid>@auth.ijary.invalid`. Real email, phone and username live in `profiles`, unique per `(company_id, …)`. Sign-in goes through the existing `signInWithIdentifier` server function, which resolves `(host company, identifier)` to one profile, then performs the password grant with that profile's synthetic email. Password reset is an application flow (single-use token table, email sent by the worker, password set through the GoTrue admin API), because GoTrue's own recovery mail would go to the synthetic address.

**Rationale**: GoTrue enforces globally unique emails. Synthetic emails remove that constraint without a second auth system, and the id-based form never needs rewriting when a username or company short name changes.

**Alternatives considered**:

| Alternative | Why it lost |
|---|---|
| One GoTrue instance per company | A container and a JWT secret per company; PostgREST accepts one secret. |
| `email+company@…` aliasing | Leaks company names into auth; breaks when the real email changes. |
| One account across companies with a switcher | Rejected by the owner (decision 6); weaker isolation. |

## R4. Resolving the company from the address

**Decision**: A Nitro request middleware maps `Host` to a company through `company_domains`, with a 60-second in-memory cache. Outcomes: platform root host → temporary page; `admin.<root>` → super admin routes only; known company host → company context on the request; unknown host → 404. After authentication the user's `profiles.company_id` must equal the host's company, otherwise the request is treated as signed out.

The browser Supabase client keeps its session in `localStorage`, which is per origin, so sessions are already separate per subdomain. No cookie may be set with `Domain=.ijary.app`. A test asserts this.

GoTrue's redirect allow-list and the API's CORS origins use the wildcard `https://*.ijary.app`.

**Alternatives considered**: path prefix `/c/<name>` (shared origin, shared storage, rejected by the owner); company chosen after login (no branded sign-in page, ambiguous identifiers).

## R5. Wildcard address and certificates

**Decision**: Cloudflare proxied wildcard record `*.ijary.app` to the Contabo origin. Traefik (via Dokploy) serves one router with a host-regexp rule and a wildcard certificate obtained by DNS-01 using a Cloudflare API token scoped to the `ijary.app` zone.

**VERIFY**: that the Dokploy version on `dokploy2.walidmohamed.com` accepts a wildcard domain and a DNS-01 resolver through its Traefik configuration; if not, use a Cloudflare Origin CA wildcard certificate mounted into Traefik.

Custom domains (User Story 13): Cloudflare for SaaS custom hostnames, added by the super admin; ownership check and certificate are Cloudflare's. **VERIFY** plan limits at that time.

## R6. Queue: BullMQ and Redis, with an outbox in front

**Decision**: The web application never talks to Redis. Every deferred piece of work is a row inserted into `job_requests` through the same company-scoped database client, in the same transaction as the change that caused it where the caller is an SQL function. A relay loop in the worker claims unpublished rows with `for update skip locked`, adds each to BullMQ with `jobId = row id`, and marks it published. Handlers are idempotent and deduplicate on that id.

**Rationale**: The owner chose BullMQ and Redis. BullMQ alone cannot take part in a Postgres transaction, so a payment could commit and its notification be lost, or roll back and still notify. Putting the outbox in front of every job, not only money events, gives one enqueue path, keeps user actions working while Redis or the worker is down (the spec's edge case), and removes any dependency of the Bun web runtime on a Redis client.

**Alternatives considered**:

| Alternative | Why it lost |
|---|---|
| App calls `queue.add()` directly; outbox only for money | Two enqueue paths; the non-money path loses work when Redis is down. |
| pg-boss (queue in Postgres) | Recommended in the interview; the owner chose BullMQ. |
| Faster HTTP cron draining a table | No per-job retry, backoff or rate limiting. |

**Cost**: up to about one second between request and job start (relay poll interval), acceptable against SC-003.

**VERIFY**: BullMQ under Bun. The worker entry point is built for and run on Node LTS until a spike shows BullMQ workers are stable on Bun.

## R7. Fairness between companies and WhatsApp pacing

**Decision**: Separate queues by class so heavy work cannot block light work: `notify`, `docs`, `bulk`, `sync`, `inbound`, `cron`. `bulk` handlers process in chunks (default 200 rows) and re-enqueue a continuation, so two companies' bulk jobs interleave. WhatsApp pacing moves out of the request into the `notify` worker: before a send, the handler takes a Redis lock keyed by the WhatsApp connection with a TTL equal to the pace gap (1.5–3 s); if the lock is held, the job is moved to delayed. Pace is therefore per company connection (FR-067).

**Rationale**: Open-source BullMQ has no per-group fairness. Class queues plus chunking meet FR-019 without it.

## R8. Scheduled work

**Decision**: BullMQ job schedulers in the worker replace the external crontab that calls `POST /api/public/cron`. Each schedule enqueues one fan-out job, which inserts one `job_requests` row per active company with a deterministic key `<job>__<companyId>__<date>` so a repeated fan-out cannot double-run. The `/api/public/cron` route is removed. "Run now" in the admin panel inserts the same row for the caller's company.

## R9. Secrets per company

**Decision**: `company_secrets` stores `ciphertext`, `iv`, `auth_tag`, `key_version`, encrypted with AES-256-GCM under `INTEGRATIONS_MASTER_KEY` (32 random bytes, base64, environment). Encryption and decryption happen only in `src/lib/secrets.server.ts`, at the moment of use. The table has no grant to `authenticated`; `company_service` may read its own company's rows. Screens receive only `last4`. Audit entries record that a secret changed, never its value. Key rotation: add a new version, re-encrypt lazily on next write, keep old versions readable.

**Alternatives considered**: Supabase Vault (`pgsodium`) — ties key custody to the database dump, so a leaked backup contains keys and data together; env-var names in config, as today — cannot differ per company.

## R10. Sections per company

**Decision**: `company_modules(company_id, module_key, enabled)`. Each permission code already has a `module`; a static map assigns permission modules to the 17 switchable section keys. `has_permission` returns false when the section is off, including for the `admin` role, whose current short-circuit is moved after the module check. Navigation reads `get_my_modules()`; client cache lifetime is at most 60 seconds (FR-040), and the database check is authoritative on every request. The worker skips a module's jobs for a company that has it off.

## R11. Limits

**Decision**: `company_limits` holds the four optional limits. Enforcement lives in the database so imports and every other route are covered:

- Units and staff accounts: `before insert` triggers that count and raise a named error (`LIMIT_UNITS`, `LIMIT_STAFF`).
- WhatsApp per month: `company_usage_monthly`, incremented by the `notify` handler in the same statement that checks it; over the limit the notification becomes `skipped` with reason `limit_reached`.
- Storage: `company_storage_usage`, maintained by a trigger on `storage.objects`; the storage insert policy calls `public.storage_within_limit()`.

**VERIFY**: that a trigger on `storage.objects` is permitted for the owning role in the self-hosted Storage version in use; fallback is server-issued signed upload URLs with the check in the issuing function.

## R12. File isolation

**Decision**: Every object path in all 14 buckets starts with `companies/<company_id>/`. Storage policies require `(storage.foldername(name))[2] = (select public.current_company_id())::text` for insert, update, delete and for select on private buckets. Public buckets (`branding`, `landing`) keep public read. Paths without the prefix are rejected. Because IJARY starts empty, no file migration is needed.

## R13. Document numbering per company

**Decision**: `company_counters(company_id, kind, last_value)` with `update … returning` inside the inserting transaction replaces the global sequences. The `next_*_code()` functions keep their names and signatures and read the counter for `current_company_id()`, so callers do not change.

## R14. Payment gateways

**Decision**: A `PaymentGateway` interface (`createPayment`, `getPaymentStatus`, `verifyWebhook`, `parseWebhook`, `testConnection`, `supportedMethods`) with one adapter per provider. The existing MyFatoorah code becomes the first adapter; `settleGatewayPayment` stays the single settlement function and receives a normalised status. Webhooks arrive at `/api/public/webhooks/<provider>/<connectionId>`; the route verifies with that connection's secret, stores the raw event, inserts a `job_requests` row and returns. `payment_requests` stores `gateway_connection_id` and a credentials version, so an in-flight payment completes on what it started with (FR-057).

**VERIFY** for Tap and UPayments at the start of their tasks: current API version, webhook signature scheme, sandbox behaviour for KNET, and amount precision for KWD. They are built only when the owner supplies sandbox accounts.

## R15. WhatsApp per company

**Decision**:

- **QR**: one platform-hosted Evolution server; an instance per company named from the company id; per-connection webhook `/api/public/webhooks/evolution/<connectionId>` with a per-connection secret (current and previous, for rotation).
- **Official API**: one Meta application for the platform. A single webhook `/api/public/webhooks/meta`, verified with the app secret signature, routes by `phone_number_id` to the owning connection. An event for an unknown number is logged and dropped.
- **Coexistence**: Meta Embedded Signup launched from the company's panel; the server exchanges the returned code for a business token, stores it as a company secret, registers the number and subscribes the app to the business account.

`whatsapp_connections` replaces the singleton `evolution_connections`; a unique index on the normalised number prevents one number on two companies (FR-063).

**VERIFY**: the current Embedded Signup parameters for coexistence onboarding and the Graph API version, against Meta's documentation, before the task starts.

## R16. Super admin identity

**Decision**: Super admins are GoTrue users with a row in `platform_admins` and no `profiles` row, so `current_company_id()` is `null` for them and they can read no company data through RLS. `is_platform_admin()` requires the row and `auth.jwt() ->> 'aal' = 'aal2'` (GoTrue TOTP). Platform tables have policies on `is_platform_admin()`. Cross-company reads for the super admin panel go through server functions in `src/platform/` using `service_role`, each writing to `platform_audit_log`.

**Rationale**: The second factor is enforced by the database, not by a screen.

## R17. Support sessions

**Decision**: Starting a session inserts `impersonation_sessions` (reason required, `expires_at = now() + 60 min`) and the server mints a JWT with `role: authenticated`, `sub` = the target company admin, plus `impersonator` and `impersonation_session` claims, expiring with the session and not refreshable. `current_company_id()` checks the session is open on each statement, so ending it revokes access at once. `write_audit` records the `impersonator` claim as actor. Password and second-factor changes go through GoTrue, which rejects a token with no GoTrue session; application functions that touch secrets or credentials refuse when the claim is present.

## R18. Suspension

**Decision**: `companies.status in ('active','suspended')`. Enforcement points: `current_company_id()` returns `null` for a suspended company; the host middleware serves the suspended page; `signInWithIdentifier` refuses; the worker drops jobs for suspended companies except `payment.settle`, which runs with `allow_suspended`. `createPayment` refuses new links.

## R19. In-panel notices

**Decision**: `user_notices` rows written by job handlers on completion or final failure, delivered by Supabase Realtime (which applies RLS) with a 30-second polling fallback.

## R20. Migrations

**Decision**: Continue the numbered sequence from `254_`. A fresh IJARY database is built from `00_` to the end, as `bun run test:db` already does. Each new migration must also be correct on a database that already holds one company's data (backfill `company_id` from the single `companies` row), so Danat can adopt the same migrations later without a separate script.

`company_id` is added as `not null default public.current_company_id()`. Existing inserts from application code then keep working unchanged and can never insert for another company, because a different value fails the policy's `with check`.

Order within the isolation phase: context functions and role; `company_id` on tables in dependency groups with backfill, composite keys and per-company uniques; policy rewrite per group; function audit; singletons to per-company; counters; storage.

## R21. Repository and environment

**Decision needed from the owner (does not block design)**: `IJARY-DANAT` is an untracked folder inside the `lolotam/IJARY` repository and has no history of its own. `.env` is already ignored by `.gitignore`. Recommended: commit this folder to `lolotam/IJARY` on a feature branch before implementation starts, so every later change is reviewable and reversible. `CLAUDE.md` still describes Danat's production (auto-deploy on push to `main`, `ssh-danatfuture-mcp`); it is rewritten for IJARY in the first phase so that no agent acts on Danat's server from this folder.
