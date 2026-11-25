# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

**Danat Al Mustaqbal ERMP** (دانة المستقبل العقارية) — Estate Rental Management
Platform for Danat Al Mustaqbal Real Estate, Kuwait. Property/unit/tenant/contract
management, invoice & payment engine (MyFatoorah), tenant portal, notifications
(SMTP/Resend email + WhatsApp Cloud API), expenses, deposits, electricity billing.
Bilingual Arabic (RTL) / English via `src/i18n/`.

Phases 0–7 are implemented and the platform is live; `TODO.md` is the
authoritative list of remaining work (smaller gaps, missing tests, open business
decisions, and the decisions already recorded).
The repo is **Lovable-connected**: never force-push, rebase, amend, or squash
commits already pushed to `main`.

## Commands (Bun)

```bash
bun run dev          # Vite dev server
bun run build        # production build
bun run lint         # ESLint 9
bun run typecheck    # tsc --noEmit
bun run test         # Vitest — money-path tests in src/fns/*.test.ts
bun run format       # Prettier
bun run gen:types    # write generated types to database.types.generated.ts (reference only)
bun run test:sql     # SQL integration tests against a real Postgres (needs Docker)
bun run test:db      # provision/refresh that Postgres on its own
```

Run lint + typecheck + test before presenting or committing work.

### File size: 500–600 lines is the ceiling

Keep every new file under **500–600 lines**. Past that, split by responsibility —
not by technical layer — so each file has one clear job and things that change
together stay together. This is a maintainability and scalability rule, and it is
also a practical one: a file that fits in one context window is one an agent can
reason about correctly and edit reliably.

When a file you are already working in has grown past the ceiling, splitting it
is in scope. Do not refactor unrelated large files you merely happened to read.

State by `wc -l` on 2026-10-19 (regenerate it, don't trust memory): the
2026-09-23 offenders are all split and now under 500 lines. The only production
files past 600 are `src/integrations/supabase/database.types.ts` (hand-maintained
types, see below), `src/components/ui/sidebar.tsx` (vendored shadcn) and
`src/routeTree.gen.ts` (generated, ~1200) — leave all three. The rest past 600 are these eleven test files; split one when you next add
cases to it: `src/db/contractCloseout.sqltest.ts` (~1290),
`src/db/invoiceRegeneration.sqltest.ts`,
`src/fns/resendWebhook.test.ts`, `src/fns/createPayment.test.ts` (~770–870),
`src/lib/adminTableSortValues.test.tsx`, `src/fns/resolveTemplateVariables.test.ts`,
`src/db/depositInvoiceLink.sqltest.ts`, `src/db/contractScheduleSync.sqltest.ts`,
`src/db/dashboardAggregates.sqltest.ts`, `src/db/moduleSummaries.sqltest.ts`,
`src/lib/paymentReceiptPdf.test.ts` (~600–710).

### Document functions in Arabic, above the function

Every function gets a doc comment **before** it, and that comment leads with an
Arabic description of what the function does. English may follow for terms with
no settled Arabic equivalent, and for the _why_ — the reasoning, trade-off or
incident that explains a non-obvious choice.

```ts
/**
 * يحسب إجمالي الإيجار الشهري للعقد من إيجارات الوحدات المرتبطة به.
 *
 * Mirrors the database trigger that maintains `contracts.monthly_amount`;
 * the join table is the source of truth, this is the client-side view of it.
 */
export function totalMonthlyAmount(rows: Array<{ monthly_amount: number }>): number {
```

Arabic is the product's primary language and the UI is RTL — the people
maintaining this code read Arabic first. The rule still holds that comments
explain _why_, never restate _what_ the next line does.

### Guard skills are required, not optional

Gates prove the code runs. They do not prove it is any good. On **every** feature
implementation — your own or a subagent's — run the guard skills before
presenting, committing or merging:

- **`clean-code-guard`** after any production code is written, edited, refactored
  or fixed.
- **`test-guard`** after any test is written or edited, and when reviewing test
  files.
- **`docs-guard`** after any docstring, README, changelog or API-doc change.

Treat code produced by a delegated agent as untrusted until it has been through
these: inspect the diff, run the guard skill that matches what changed, then run
the project gates, and only then summarise or commit. A passing suite says
nothing about a test that asserts nothing, a mock of an internal helper, or a
catch block that swallows the error — which is exactly what the guards look for.

## Architecture

- **TanStack Start** (React 19) + Nitro server. File-based routing in
  `src/routes/` — read `src/routes/README.md` first; Next.js conventions
  (`src/pages/`, `app/layout.tsx`) are wrong here. `src/routeTree.gen.ts` is
  generated — never edit.
- **Server functions** in `src/fns/` hold all money-moving logic
  (`generateInvoices`, `applyAllocation`, `reversePayment`, `evaluateOverdue`,
  `createPayment`, `myfatoorahWebhook`) plus jobs (`cronJobs`,
  `contractExpiryJob`, `scheduledReportsJob`) and notification dispatch.
  Tests sit next to the code.
  `workflowRegistry` holds the shared pause-and-record gate: the `cron_jobs`
  table registers both scheduled jobs and event-triggered workflows, told apart
  by `kind` (migration 69). Event senders (`notifyDepositConfirmed`,
  `notifyPaymentSuccess`, `notifyUserCredentials`,
  `notifyWhatsappSessionDisconnected`) wrap themselves in
  `runEventWorkflow` rather than checking the switch at their call sites —
  scattered checks are where one gets missed, and a missed one is invisible.
  `notifyWhatsappSessionDisconnected` composes `runEventWorkflow`,
  `renderAdminEmailCopy`, and `enqueueNotification` directly (with a cheap
  pre-read and atomic `evolution_connections` claim order) instead of
  `notifyAdminEvent`.
  `loadTemplateCopy` reads the admin-edited subject/body from
  `notification_templates`; senders fall back to the built-in builder in
  `src/lib/emailTemplates.ts` only when a row is missing or inactive. Bodies are
  inner content wrapped by `renderEmailDocument`, unless they start with
  `<!doctype`/`<html`, in which case they are used verbatim. `due_reminder` has
  no sender and is seed-only.
- **Public API routes**: `src/routes/api/public/cron.ts` (Bearer `CRON_SECRET`;
  the ten jobs of the `JOBS` map in `src/fns/cronJobs.ts` — all idempotent, keep
  them that way), `myfatoorah-webhook.ts` (signature-verified),
  `evolution-webhook.ts` (constant-time `x-danat-webhook-secret` check; ingests
  WhatsApp messages/acks and confirms QR session disconnects), and
  `resend-webhook.ts` (Svix-signed email delivery events). The Resend one moves
  a permanently bounced notification to `needs_review` and **never** to
  `failed` — `runNotificationDrainJob` re-sends `failed` rows, so `failed`
  would resend to an address that already rejected the mail.
- **Self-hosted Supabase** (NOT Lovable Cloud): Postgres 17 + GoTrue + PostgREST +
  Storage + Realtime behind Kong. Browser and server clients in
  `src/integrations/supabase/`.
- **Migrations are manual SQL**: `db/migrations/` in numeric order by leading
  migration number (`sort -V` / parseInt — not bare lexicographic filename
  order; `"100_…"` sorts before `"50_…"` under lex), then `supabase/migrations/`.
  See `db/README.md`. Mostly idempotent, but not universally —
  `identify_contract_expiry_reminders` changes its OUT-parameter row type
  across 07/31/33, and `create or replace function` cannot do that, so
  re-applying the whole set to a migrated database fails. Verify any migration
  with `bun run test:db`, which builds a clean database from scratch.
- **`database.types.ts` is hand-maintained**, despite looking generated. It
  exports 73 named aliases the Supabase generator does not emit, imported by
  ~70 files. After a schema change run `bun run gen:types` — which writes a
  _reference_ file — then hand-copy the new table/RPC entry across. Never
  overwrite the real file.
- UI: Tailwind CSS 4 + shadcn/ui (Radix) in `src/components/`, forms via
  react-hook-form + Zod, RBAC enforced through `has_permission` / RLS.
- New RLS policies wrap the auth helpers in a scalar sub-select —
  `(select public.is_staff((select auth.uid())))`, never `is_staff(auth.uid())`.
  The bare form runs once per row (48 ms vs 3 ms counting invoices, migration
  243); `src/db/rlsHoistedAuth.sqltest.ts` fails on it.
- Archived contracts (`archived_at is not null`) are excluded from all four
  invoice-generation entry points and both reminder paths as of migration 82.
- Invoice state `waived` means written off; disputes are a separate flag
  (`disputed_at` / `dispute_reason`), not a state.
- `close_out_contract` writes audit rows from inside SQL via `write_audit` for
  atomicity — the first user-facing path to do so (same reason as
  `erase_all_data`: multi-table money must not commit without its audit row).

## Security rules

- `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS — server-only, never in a `VITE_`
  variable (anything `VITE_`-prefixed is compiled into the browser bundle).
- Never commit `.env` / `.env.production` or paste real keys into docs or code.
- Admin-triggered job paths stay user-scoped (`has_permission`); only the cron
  path runs as `service_role`.

## Production — Danat-Future server (MCP access)

Production moved here in July 2026. The previous host (`WaleedU`,
`116.202.66.131`, containers `danatkuwait-*`, MCP `ssh-musalam-2-mcp`) is the
**old** server — do not treat anything read from it as current.

| Item          | Value                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Host          | `Waleed3` (OS hostname `danat-future`) — Ubuntu 24.04.4 LTS, Docker 29.x, 4 vCPU / 15 GiB RAM                           |
| Public IP     | `49.12.59.137` (Hetzner)                                                                                                |
| Panel         | Dokploy + Traefik (auto-TLS); Cloudflare sits in front of both domains                                                  |
| App container | `danatfuture-danatfuture-vk5hnn` — this repo's `Dockerfile`, port 3000                                                  |
| App domain    | https://danat-future.com                                                                                                |
| Supabase      | Dokploy compose `danatfuture-supabase-ozoxsa` — Postgres, Kong, GoTrue, PostgREST, Storage, Realtime, Studio, Supavisor |
| Supabase URL  | https://supabase.danat-future.com (public); internal Docker network for the app container                               |
| DB container  | `danatfuture-supabase-ozoxsa-db-1` (`psql -U supabase_admin -d postgres`)                                               |

**MCP servers for this project** (use these and only these — not contabo /
curemed / musalam-1 / Abdelaziz / musalam-2 targets):

- **`ssh-danatfuture-mcp`** (`exec`, `sudo-exec`) — shell on the production host.
  Use for container status (`docker ps`), logs, Traefik config, psql against the
  Supabase Postgres container.

### Storage lives on a bind mount, and its metadata is in xattrs

Supabase Storage files are **not** in a Docker volume:

```
/etc/dokploy/compose/danatfuture-supabase-ozoxsa/files/volumes/storage
  └── stub/stub/<bucket>/<path>/<object-name>/<version-uuid>   ← the real file
```

Buckets: `landing` (largest by far), `branding`, `tenant-documents`,
`tenant-messages`, `deposit-attachments`.

Each **inner version file** carries its content type in POSIX extended
attributes — `user.supabase.content-type`, `user.supabase.cache-control`.
storage-api reads them on every request; without them it returns **HTTP 500
`ENODATA` / "The extended attribute does not exist."**, not a 404.

So **any copy, backup, or restore of this directory must preserve xattrs**:
`rsync -aX`, or `tar --xattrs --xattrs-include='*'`. Plain `cp`, `scp`, or
`rsync -a` silently drops them and every image 500s while looking perfectly
present on disk. This is exactly what broke the July 2026 server move.

Deploy flow: **any push or merge to `main` auto-deploys** — Dokploy watches the
branch and builds the multi-stage Dockerfile with no manual step. Pushing a
feature branch does **not** deploy, so branches are safe to push freely.
`VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` are **build args** baked
into the bundle — set them in Dokploy before building. The app container joins
the Supabase stack's Docker network so `SUPABASE_URL` resolves internally.
Cron: ten staggered entries hitting `POST /api/public/cron` (runbook +
crontab lines in `deploy/README.md`).

### Migrations do not auto-apply — run them over `ssh-danatfuture-mcp`

Dokploy deploys code, never schema. Apply migrations yourself against
`danatfuture-supabase-ozoxsa-db-1`, and apply them **before** the new code goes
live, or the new bundle runs against the old schema.

Getting the files onto the server is the awkward part, and the trick is that
**the merge itself delivers them**: Dokploy clones `main` into
`/etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code` at the start of
every build, so the new migrations are on disk minutes before the container
swaps. Concatenate them there rather than transferring anything:

```bash
cd /etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code/db/migrations
cat 110_*.sql 111_*.sql … > /root/apply.sql        # numeric order, one file each
md5sum /root/apply.sql                              # MUST match the local file
docker exec -i danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - < /root/apply.sql
docker exec danatfuture-supabase-ozoxsa-db-1 \
  psql -U supabase_admin -d postgres -Atc "notify pgrst, 'reload schema'"
```

- **Checksum against the local file.** It is the only thing proving production
  ran the same bytes the SQL suite validated.
- **`notify pgrst` is required.** Without it PostgREST keeps a stale signature
  cache and new RPCs 404 even though they exist.
- `drop … if exists` emits `NOTICE` lines on first application. Those are not
  errors; grep for `^ERROR` and trust `ON_ERROR_STOP=1` plus the exit code.
- **`pg_dump` first.** Schema changes are not reversible.

Two properties of the MCP bridge to plan around:

- Long-running commands (`pg_dump`, a big `psql -f`) exceed the call timeout and
  return `No response from server` while still running — or not running at all.
  Wrap them in `nohup sh -c '… ; echo $? > /root/status.txt' &` and poll the
  status file.
- Command size is capped at a few KB, so a 150 KB migration set cannot be piped
  in as an argument. Use the Dokploy checkout above rather than chunked base64.

Dokploy's checkout embeds a short-lived GitHub OAuth token in `.git/config` that
is refreshed per deploy and **is normally expired between deploys** — so
`git fetch` of an arbitrary branch on the server does not work. Only `main`, and
only what the last deploy pulled.

## graphify

A knowledge graph exists at `graphify-out/`. For codebase questions prefer
`graphify query "<question>"` (also `path`, `explain`) over raw grep; use
`graphify-out/wiki/index.md` for navigation and run `graphify update .` after
code changes. See `AGENTS.md` for the full graphify rules.
