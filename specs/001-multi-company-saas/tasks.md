# Tasks: IJARY Multi-Company SaaS Conversion

**Input**: Design documents from `/specs/001-multi-company-saas/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Required. The isolation suite (User Story 1) and the outbox tests (User Story 2) are launch gates. Within each story, write the tests first and see them fail before implementing.

**Organization**: Tasks are grouped by user story, in the delivery order agreed with the owner. Phase names from plan.md are shown in brackets.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: User story from spec.md (US1 to US13)
- **⛔ BLOCKED(owner: …)**: cannot start until the owner supplies the named item
- **VERIFY**: check a third-party detail against current vendor documentation or a spike, and record the result in research.md before the dependent task

## Rules for every task (from `CLAUDE.md`)

- New files stay under 500–600 lines; split by responsibility.
- Every function gets an Arabic doc comment above it.
- After production code: `clean-code-guard`. After tests: `test-guard`. After docs: `docs-guard`.
- Before any commit: `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run test:sql` when SQL changed.
- Every migration is verified from a clean database with `bun run test:db`, and its new tables, columns and functions are hand-copied into `src/integrations/supabase/database.types.ts` in the same task.
- No task deploys or touches a server without the owner's go-ahead at that moment. Nothing in this feature targets Danat's production.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Make the repository ready and safe to work in.

- [x] T001 Create branch `001-multi-company-saas` from `main` in `lolotam/ijary-Danat` and confirm a clean `git status`
- [x] T002 Rewrite `CLAUDE.md` for IJARY: remove the Danat production section (server table, `ssh-danatfuture-mcp`, auto-deploy on push to `main`, migration runbook against `danatfuture-*`), state that Danat production is out of bounds, add the company-context rules from `specs/001-multi-company-saas/contracts/company-context.md` and the terminology from spec.md
- [x] T003 [P] Add `bullmq`, `ioredis` and `jose` to `package.json` and update `bun.lock`
- [x] T004 [P] Add a `redis` service to `docker-compose.yml` and a `worker` script to `package.json`
- [x] T005 [P] Add the new variables to `.env.example` (`SUPABASE_JWT_SECRET`, `INTEGRATIONS_MASTER_KEY`, `REDIS_URL`, `PLATFORM_ROOT_HOST`, `PLATFORM_ADMIN_HOST`, platform default sender, Meta app, Evolution server) and validate them at start-up in `src/lib/env.server.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The company-context primitives every story builds on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T006 Write migration `db/migrations/254_company_context.sql`: role `company_service`; `current_company_id()`, `is_platform_admin()` stub; new `companies` columns; `company_domains`; `reserved_slugs` with its seed (data-model.md: `companies.slug`, `companies.status`, `companies.currency`, `companies.timezone`, `company_domains.kind`, `company_domains.verification_status`, `reserved_slugs.slug`; research.md R1, R2)
- [x] T007 Implement `companyClient(companyId, opts)` with token signing in `src/company/companyClient.server.ts`, with unit tests in `src/company/companyClient.server.test.ts` (throws `COMPANY_REQUIRED`; 5-minute expiry; `allow_suspended` only when asked)
- [x] T008 [P] Define the error codes of `contracts/company-context.md` section 6 in `src/company/errors.ts`
- [x] T009 Implement host resolution and request context in `src/company/hostCompany.server.ts` and `src/company/requestCompany.server.ts`, wired through `server/middleware/company.ts` (60-second cache; `*.localhost` in development)
- [x] T010 Add the `no-restricted-imports` rule for `src/integrations/supabase/client.server.ts` to `eslint.config.js`, with a temporary allow-list file `eslint.platform-allowlist.js` listing today's 92 importers
- [x] T011 [P] Build the two-company SQL test harness in `src/db/isolation/twoCompanies.ts` (companies A and B, one user per role in each, helpers to run as a user and as `company_service`)

**Checkpoint**: Context function, company-bound client, host resolution and test harness exist.

---

## Phase 3: User Story 1 - A company's data is invisible to every other company (Priority: P1) 🎯 MVP [plan Phase 1a]

**Goal**: Every table, function, file and server operation is bound to one company, enforced by the database.

**Independent Test**: `bun run test:sql src/db/isolation` is 100% green (quickstart.md Phase 1a).

### Tests for User Story 1

- [x] T012 [P] [US1] Structure test: every `public` table off the allow-list has `company_id`, forced RLS and a policy naming `current_company_id`, in `src/db/isolation/tablesScoped.sqltest.ts`
- [x] T013 [P] [US1] Structure test: every `security definer` function names `current_company_id` or is allow-listed, in `src/db/isolation/definerFunctions.sqltest.ts`
- [x] T014 [P] [US1] Structure test: no `from companies … limit 1` in `db/migrations` latest definitions or in `src`, in `src/db/isolation/noOldestCompany.structure.test.ts`
- [x] T015 [P] [US1] Generated behaviour matrix: for each table, a user of A selects, updates and deletes 0 rows of B and cannot insert with B's `company_id`, in `src/db/isolation/crossCompanyMatrix.sqltest.ts`
- [x] T016 [P] [US1] Cross-company link and per-company uniqueness tests in `src/db/isolation/linksAndUniques.sqltest.ts`
- [x] T017 [P] [US1] `company_service` tests (token for A reads none of B; no claim reads nothing) in `src/db/isolation/companyService.sqltest.ts`
- [x] T018 [P] [US1] Storage path tests for all 14 buckets in `src/db/isolation/storagePaths.sqltest.ts`
- [x] T019 [P] [US1] Per-company numbering test in `src/db/isolation/counters.sqltest.ts`
- [x] T020 [P] [US1] Extend `src/db/rlsHoistedAuth.sqltest.ts` to cover `current_company_id` and the `company_service` role

### Implementation for User Story 1

Each group task writes two migrations — columns (add or tighten `company_id`, backfill, composite keys, per-company uniques, indexes led by `company_id`) and policies (rewrite to the shape in `contracts/company-context.md` section 5) — per data-model.md section 1. Run in this order; each must leave the existing SQL suite green.

- [x] T021 [US1] Identity group (`profiles`, `user_roles`, `role_permissions`, `custom_roles`, `custom_role_permissions`, `user_custom_roles`, `user_tenants`, `audit_logs`, `failed_login_attempts`) in `db/migrations/255_company_identity_columns.sql` and `db/migrations/256_company_identity_policies.sql`
- [x] T022 [US1] Lists group (`option_lists`, `option_list_items`, `building_categories`, `expense_categories`, `invoice_years`, `card_visibility`) in `db/migrations/257_company_lists_columns.sql` and `db/migrations/258_company_lists_policies.sql`
- [x] T023 [US1] Properties group (`properties`, `buildings`, `units`, `maintenance_requests`) in `db/migrations/259_company_properties_columns.sql` and `db/migrations/260_company_properties_policies.sql`
- [x] T024 [US1] Renters and contracts group (`tenants`, `tenant_documents`, `contracts`, `contract_units`, `contract_extra_charges`, `concessions`, `concession_invoices`, `commercial_brands`, `commercial_brand_contracts`, `contract_operational_events`) in `db/migrations/261_company_contracts_columns.sql` and `db/migrations/262_company_contracts_policies.sql`
- [x] T025 [US1] Billing group (`invoices`, `invoice_items`, `payments`, `payment_allocations`, `receipts`, `payment_requests`, `webhook_events`, `email_webhook_events`) in `db/migrations/263_company_billing_columns.sql` and `db/migrations/264_company_billing_policies.sql`
- [x] T026 [US1] Ledgers group (`deposits`, `partial_payments`, `insurance_payments`, `refunds`, `expenses`) in `db/migrations/265_company_ledgers_columns.sql` and `db/migrations/266_company_ledgers_policies.sql`
- [x] T027 [US1] Closeout group (`contract_closeouts`, `contract_closeout_deductions`, `contract_closeout_invoice_actions`) in `db/migrations/267_company_closeout_columns.sql` and `db/migrations/268_company_closeout_policies.sql`
- [x] T028 [US1] Electricity group (`electricity_tariffs`, `electricity_meters`, `meter_readings`, `electricity_charges`) in `db/migrations/269_company_electricity_columns.sql` and `db/migrations/270_company_electricity_policies.sql`
- [x] T029 [US1] HR group (`employees`, `employee_documents`, `salaries`) in `db/migrations/271_company_hr_columns.sql` and `db/migrations/272_company_hr_policies.sql`
- [x] T030 [US1] Notifications and system group (`notification_templates`, `notifications`, `provider_configs`, `report_schedules`, `generated_reports`, `cron_jobs`, `backups`) in `db/migrations/273_company_notifications_columns.sql` and `db/migrations/274_company_notifications_policies.sql`
- [x] T031 [US1] Messaging group (`gmail_connections`, `gmail_messages`, `email_signatures`, `evolution_connections`, `whatsapp_chats`, `whatsapp_contacts`, `whatsapp_messages`, `whatsapp_contact_contracts`, `tenant_messages`, `contact_inquiries`) in `db/migrations/275_company_messaging_columns.sql` and `db/migrations/276_company_messaging_policies.sql`
- [x] T032 [US1] Landing group (`landing_media`, `landing_page_settings`, `landing_page_sections`, `landing_carousel_slides`, `leasing_inquiries`) in `db/migrations/277_company_landing_columns.sql` and `db/migrations/278_company_landing_policies.sql`
- [x] T033 [US1] Function audit, identity and permission helpers (`has_permission`, `is_staff`, `has_role`, `write_audit`, sign-in helpers): invoker where possible, explicit company predicate otherwise, accept `company_service` for the permission skip, in `db/migrations/279_functions_identity.sql`, now split into 279–282 by T052l (research.md R2)
- [x] T034 [US1] Function audit, invoice generation and schedule functions in `db/migrations/280_functions_billing.sql`, now split into 283–289 by T052l
- [x] T035 [US1] Function audit, payment, allocation, reversal, deposit, refund and insurance functions in `db/migrations/281_functions_payments.sql`, now split into 290–293 by T052l
- [x] T036 [US1] Function audit, closeout, electricity and salary functions in `db/migrations/282_functions_closeout_electricity_hr.sql`, now split into 294–297 by T052l
- [x] T037 [US1] Function audit, notification, reminder, report, summary and KPI functions, removing every "oldest company" lookup, in `db/migrations/283_functions_notifications_reports.sql`, now split into 298–302 by T052l
- [x] T038 [US1] Replace the global code sequences with `company_counters` behind the existing `next_*_code()` names in `db/migrations/303_company_counters.sql` (was 284 before the T052l split) (data-model.md: `company_counters.kind`; research.md R13)
- [x] T039 [US1] Storage bucket policies for the `companies/<company_id>/` prefix in `db/migrations/304_storage_company_paths.sql` (was 285 before the T052l split; research.md R12)
- [x] T040 [US1] Add `src/company/storagePath.ts` and use it at every upload and download site: `src/hooks/useTenants.ts`, `usePayments.ts`, `useExpenses.ts`, `useDeposits.ts`, `useTenantMessages.ts`, `src/components/admin/settings/CompanySettingsForm.tsx`, `ImageSourceInput.tsx`, `src/fns/uploadShopMedia.ts`, `sendCompanyInfo.ts`, `backupCore.ts`, `evolutionDelivery.ts`, `src/lib/reportPdfAttachment.ts`, `gmailAttachment.ts`
- [x] T041 [P] [US1] Move the 11 `src/lib/*` service-role importers (`audit`, `env.server`, `gmailClient.server`, `invoiceDocumentPdf`, `invoiceRelations`, `paymentReceiptPdf`, `phoneConflicts.server`, `recordSentResendMessage`, `reportPdfAttachment`, `suppressedPayments`, `userConflicts.server`) to `companyClient`
- [x] T042 [P] [US1] Move the notification family in `src/fns/` (`notify*.ts`, `enqueueNotification.ts`, `sendNotification.ts`, `sendBulkNotification.ts`, `dispatch*.ts`, `loadTemplateCopy.ts`, `notificationDrainJob.ts`, `workflowRegistry.ts`) to `companyClient`
- [x] T043 [P] [US1] Move the payment family in `src/fns/` (`createPayment.ts`, `confirmGatewayPayment.ts`, `gatewaySettlement*.ts`, `myfatoorahWebhook.ts`, `paymentReconcileJob.ts`) to `companyClient`
- [x] T044 [P] [US1] Move the messaging family in `src/fns/` (`evolution*.ts`, `gmail*.ts`, `resend*.ts`) and `src/routes/api/oauth/google/callback.ts` to `companyClient`
- [x] T045 [P] [US1] Move the user family in `src/fns/` (`createAppUser.ts`, `updateAppUser.ts`, `deleteAppUser.ts`, `signInWithIdentifier.ts`, `sendTenantCredentials.ts`) to `companyClient`, leaving GoTrue admin calls for T083
- [x] T046 [P] [US1] Move the jobs and reports family in `src/fns/` (`cronJobs.ts`, `contractExpiryJob.ts`, `scheduledReportsJob.ts`, `runReportSchedule.ts`, `backup*.ts`, `restoreBackup.ts`, `bulkImport.ts`, `generate*.ts`) to `companyClient`
- [x] T047 [P] [US1] Move the public family in `src/fns/` (`publicBranding.ts`, `submit*Inquiry.ts`) to the request's company
- [x] T048 [US1] Remove the remaining "oldest company" lookups in code (`src/hooks/useCompany.ts`, `src/hooks/useLandingSettings.ts`, and any site T014 still reports)
- [x] T049 [US1] Make `src/fns/cronJobs.ts` run each job once per active company with `companyClient`, isolating failures per company (interim until T076)
- [x] T050 [US1] Remove "erase all data" from company panels: `src/fns/eraseAllData.ts`, its settings control, and its permission seed
- [x] T051 [US1] Shrink `eslint.platform-allowlist.js` to the paths in `contracts/company-context.md` section 3 and fix every remaining violation
- [x] T052 [US1] Gate: `bun run test:db`, full `bun run test:sql`, lint, typecheck, unit tests, guard skills; record the SC-001 result in `specs/001-multi-company-saas/quickstart.md`

### Review fixes for User Story 1 (found after T052, 2026-11-26)

An independent review of T012–T052 found isolation holes the suite did not cover. Fixed before closing the phase:

- [x] T052a [US1] Drop `erase_all_data()` (still granted to `authenticated` after T050 removed the UI) in `db/migrations/299_functions_backup.sql`
- [x] T052b [US1] Make `reassign_contract_tenant_records` trigger-only: company passed from the contract row, no fallback lookup, no API role can execute it, in `db/migrations/287_functions_billing_contract_save_triggers.sql`
- [x] T052c [US1] Replace every "oldest company" backfill in migrations 255–277 with `_legacy_single_company_id()` (fails when more than one company exists) in `db/migrations/254_company_context.sql`; extend `src/db/isolation/noOldestCompany.structure.test.ts` to scan whole migrations
- [x] T052d [US1] Move the login-audit service_role client to `src/platform/loginAuditClient.server.ts`; lint rule against reading the service_role key outside the allow-list in `eslint.config.js`
- [x] T052e [US1] Block staff and `company_service` from changing `companies.id`, `slug`, `status` and `suspended_*` (trigger `companies_guard_platform_columns`) in `db/migrations/256_company_identity_policies.sql`; tests in `src/db/isolation/platformGuards.sqltest.ts`

Lower-severity findings from the same review:

- [x] T052f [US1] `extractRequestHost` trusted `x-forwarded-host` from any client; it is now read only when `TRUST_FORWARDED_HOST=true` (default `false`: Traefik passes `Host` through) in `src/company/hostCompany.server.ts`, `src/lib/env.server.ts`, `.env.example`, `docker-compose.yml`
- [x] T052g [US1] Nothing created `company_domains` rows of kind `subdomain`, so `<slug>.ijary.app` resolved nowhere in production; host lookup now tries a verified domain row, then the slug under `PLATFORM_ROOT_HOST` (no migration needed) in `src/company/hostCompany.server.ts`
- [x] T052h [US1] `src/fns/uploadShopMedia.ts` fell back to the profile's company when there was no host context; it now requires the request company (`requireSupabaseAuth` already treats a mismatch as signed out)
- [x] T052i [US1] `src/company/companyClient.server.ts` fell back to `http://localhost:54321` when the URL or key was missing; it now throws
- [x] T052j [US1] Security definer functions in migrations 279–281 filtered with `(v_company_id is null or company_id = v_company_id)`; they now read `public.current_company_id_strict()` (`db/migrations/254_company_context.sql`), which raises `COMPANY_REQUIRED` unless the caller is a platform role (`service_role`, `postgres`, `supabase_admin`, or none). `validate_electricity_charge_insert` drops the null branch outright
- [x] T052k [US1] `getAuthAdmin()` handed the full GoTrue admin API to any importer; `src/platform/authAdmin.server.ts` now exports only `createAuthUser`, `updateAuthUserById` and `deleteAuthUser` (synthetic emails still T083)
- [x] T052l [US1] Split migrations 279–283 (1289–2468 lines) by responsibility into 279–302 (each under 520 lines, bodies unchanged, grants moved next to their functions); `284_company_counters` and `285_storage_company_paths` renumbered to 303 and 304
- [x] T052m [US1] The `to public` select on `branding`, `landing` and `property-images` let anyone list every company's file names; it is now `to authenticated` and scoped to the caller's company (public URLs are served without RLS and keep working) in `db/migrations/304_storage_company_paths.sql`; `src/company/storagePath.ts` lowercases the company id

### Second review fixes for User Story 1 (found after T052m, 2026-11-26)

An independent review of `24090cf..4abc6cc` (`waleed_general_reviewer`) returned BLOCK:

- [x] T052n [US1] Regression tests first: call every SECURITY DEFINER RPC in migrations 290–297 as `authenticated` and as `company_service` with a null company context and another company's ids, expecting `COMPANY_REQUIRED` or `42501` and no change; a renter and a `readonly` user calling `delete_contract_insurance` get `42501`, in `src/db/isolation/definerNullContext.sqltest.ts`
- [x] T052o [US1] Inside a SECURITY DEFINER function `current_user` is the owner, so every `current_user in ('authenticated', …)` check in 290–297 never fired: `delete_contract_insurance` lost its `insurance.delete` check and 19 functions ran unscoped on a null context. Add `public.request_api_role()` in `db/migrations/254_company_context.sql`; read the company from `current_company_id_strict()` and the role from `request_api_role()` in `db/migrations/290`–`297`
- [x] T052p [US1] `src/db/isolation/definerFunctions.sqltest.ts` also rejects `current_user in (` inside a SECURITY DEFINER body
- [x] T052q [US1] Payment redirect and the WhatsApp-disconnect link fell back to Danat's production domain; build them from the request company's host and drop the `danat-future.com` fallback in `src/fns/createPayment.ts`, `src/fns/notifyWhatsappSessionDisconnected.ts`, `src/lib/emailTemplates/reminders.ts`
- [x] T052r [US1] `signInWithIdentifier` returned tokens and logged a success for another company's account; it now checks the signed-in profile belongs to the host company and answers `INVALID_CREDENTIALS` otherwise, in `src/fns/signInWithIdentifier.ts`
- [x] T052s [US1] Evolution pairing fell back to instance `danat` and could re-point another company's webhook; the instance name is now per company (`ijary-<company_id>`) and pairing, status, disconnect and delete-for-everyone never read a stored or literal name, in `src/fns/evolutionSession.ts` and `src/fns/whatsappChat.ts`. Webhook URLs stay platform-wide until T157, T158 and T172: until then only one company may connect WhatsApp or Resend
- [x] T052t [US1] Migrations 263–273 kept 54 legacy single-column foreign keys beside their composite `(company_id, …)` twins, so PostgREST refused every embed between those tables with PGRST201 (HTTP 300) and the renter dashboard failed to load; `db/migrations/305_drop_duplicate_company_fks.sql` drops each legacy key whose twin is validated and has the same delete and update actions, then fails if any duplicate remains. Guarded by `src/db/isolation/duplicateForeignKeys.sqltest.ts`

**Checkpoint**: Isolation suite 100% green. Until then no second company exists in any shared environment.

---

## Phase 4: User Story 2 - Slow work happens in the background (Priority: P1) [plan Phase 1b]

**Goal**: Sending, documents, bulk work and syncs leave the request; the user is told when long jobs end.

**Independent Test**: quickstart.md Phase 1b checks 1 to 5.

### Tests for User Story 2

- [x] T053 [P] [US2] Transactional enqueue tests (commit yields one job, rollback yields none, dedupe key returns the existing job) in `src/db/outbox/enqueueJob.sqltest.ts`
- [ ] T054 [P] [US2] Relay tests (claims pending rows, republish is harmless) in `src/worker/relay.test.ts`
- [ ] T055 [P] [US2] Handler wrapper tests (skips suspended and switched-off, statuses, notice on final failure) in `src/worker/runJob.test.ts`
- [ ] T056 [P] [US2] Idempotency tests, one per handler family, in `src/jobs/handlers/idempotency.test.ts`
- [ ] T057 [P] [US2] Per-connection pacing tests in `src/worker/pacing.test.ts`

### Implementation for User Story 2

- [x] T058 [US2] VERIFY: spike BullMQ workers on Bun against Node LTS and record the outcome in `specs/001-multi-company-saas/research.md` R6
- [x] T059 [US2] Write migration `db/migrations/306_job_requests.sql`: `job_requests`, `user_notices`, `enqueue_job()` (data-model.md: `job_requests.kind`, `job_requests.status`, `job_requests.dedupe_key`, `user_notices.level`)
- [ ] T060 [US2] Define the job catalogue (kinds, Zod payloads, queue, section) from `contracts/jobs.md` section 5 in `src/jobs/catalog.ts`
- [ ] T061 [US2] Implement `enqueueJob` in `src/jobs/enqueue.ts`
- [ ] T062 [US2] Implement queues and the worker entry point in `src/worker/queues.ts` and `src/worker/main.ts`
- [ ] T063 [US2] Implement the outbox relay in `src/worker/relay.ts`
- [ ] T064 [US2] Implement the handler wrapper in `src/worker/runJob.ts` (`contracts/jobs.md` section 3)
- [ ] T065 [US2] Implement per-connection pacing in `src/worker/pacing.ts` and remove `paceSends` from `src/lib/providers/evolution.ts`
- [ ] T066 [US2] Add the worker build target to `Dockerfile` and the worker and redis services to `deploy/ijary/docker-compose.yml`
- [ ] T067 [US2] Notification handler in `src/jobs/handlers/notification.ts`; make `src/fns/enqueueNotification.ts` and `src/fns/sendNotification.ts` insert and enqueue without sending
- [ ] T068 [US2] Document handlers (`invoice.send`, `payment.receipt`, `company.info.send`, `contract.pdf`, `report.run`, `report.export`) in `src/jobs/handlers/documents.ts`; make `sendInvoiceToTenant.ts`, `notifyPaymentSuccess.ts`, `sendCompanyInfo.ts`, `runReportSchedule.ts`, `resendGeneratedReport.ts` enqueue
- [ ] T069 [US2] Bulk handlers with 200-row chunks (`notification.bulk`, `invoices.generate`, `invoices.regenerate`, `import.run`, `electricity.generate`, `salaries.generate`) in `src/jobs/handlers/bulk.ts`; make `sendBulkNotification.ts`, `generateInvoices.ts`, `regenerateContractInvoices.ts`, `bulkImport.ts`, `generateElectricityCharges.ts` enqueue
- [ ] T070 [US2] Sync handlers (`company.export`, `company.restore`, `whatsapp.history.sync`, `whatsapp.avatars.sync`, `gmail.sync`, `payment.reconcile`) in `src/jobs/handlers/sync.ts`; make `backup.ts`, `restoreBackup.ts`, `evolutionHistorySync.ts`, `evolutionAvatars.ts` enqueue
- [ ] T071 [US2] Write migration `db/migrations/307_money_event_outbox.sql`: emit `payment.succeeded`, `payment.reversed`, `deposit.confirmed`, `refund.recorded`, `invoice.written_off`, `invoice.disputed`, `contract.closed_out`, `contract.restored` with `enqueue_job` inside the owning SQL functions
- [ ] T072 [US2] Event handlers mapping each money event to its existing sender in `src/jobs/handlers/events.ts`; remove the direct sender calls from their call sites
- [ ] T073 [US2] Notices: `src/fns/notices.ts` (`myNotices`, `markNoticeRead`), `src/hooks/useNotices.ts` (Realtime with 30-second polling fallback), `src/components/admin/NoticesBell.tsx`
- [ ] T074 [US2] Failed jobs: `src/fns/companyJobs.ts` (`companyFailedJobs`, `retryJob`) and `src/components/admin/settings/FailedJobsCard.tsx`
- [ ] T075 [US2] Show the immediate confirmation for deferred actions in the screens that call the functions changed in T067 to T070
- [ ] T076 [US2] Schedules and per-company fan-out in `src/worker/scheduler.ts` (`contracts/jobs.md` section 7); delete `src/routes/api/public/cron.ts`; remove the crontab from `deploy/README.md`
- [ ] T077 [US2] Gate: quickstart.md Phase 1b checks 1 to 5; record SC-003 to SC-006

**Checkpoint**: No slow operation runs inside a request; money events are never lost or sent for a rolled-back change.

---

## Phase 5: User Story 3 - Each company has its own address and sign-in (Priority: P1) [plan Phase 2]

**Goal**: `<slug>.ijary.app` opens that company's branded sign-in; accounts exist per company.

**Independent Test**: quickstart.md Phase 2 steps 3 to 6.

### Tests for User Story 3

- [ ] T078 [P] [US3] Host tests (company host, platform root, admin host, unknown host, route gating by host) in `src/company/hostCompany.server.test.ts`
- [ ] T079 [P] [US3] Sign-in tests (same identifier in two companies, other company's address fails like a wrong password, suspended refused, session of another company treated as signed out) in `src/fns/signInWithIdentifier.test.ts`
- [ ] T080 [P] [US3] Test that no response sets a cookie with a parent-domain scope, in `src/company/cookieScope.test.ts`

### Implementation for User Story 3

- [ ] T081 [US3] Gate routes by host in `server/middleware/company.ts`: `/platform/*` only on the admin host, `/admin/*` and `/portal/*` only on company hosts, 404 otherwise
- [ ] T082 [US3] Write migration `db/migrations/288_company_accounts.sql`: single-use `password_reset_tokens`, and a must-change-password flag on `profiles` (research.md R3)
- [ ] T083 [US3] Implement GoTrue admin helpers with synthetic auth emails in `src/platform/authAdmin.server.ts`; use them from `src/fns/createAppUser.ts`, `updateAppUser.ts`, `deleteAppUser.ts`; make `src/lib/userConflicts.server.ts` and `phoneConflicts.server.ts` check within the company
- [ ] T084 [US3] Resolve identifiers within the host's company in `src/fns/signInWithIdentifier.ts`, `src/auth/loginIdentity.ts` and `src/auth/AuthProvider.tsx`
- [ ] T085 [US3] Application password reset in `src/fns/passwordReset.ts` and `src/routes/reset-password.tsx`, sending through a `notification.dispatch` job
- [ ] T086 [US3] Branded sign-in: `src/fns/publicBranding.ts` by host; `src/routes/auth.tsx` and `src/routes/portal_.auth.tsx`
- [ ] T087 [US3] Temporary platform page, redirect of a company root to sign-in, and a not-found page in `src/routes/index.tsx` and `src/routes/not-found.tsx`; landing section off for every company
- [ ] T088 [US3] ⛔ BLOCKED(owner: Cloudflare API token for `ijary.app`, Dokploy access) VERIFY that Dokploy accepts a wildcard domain with DNS-01; write `deploy/ijary/traefik-wildcard.yml` and the steps in `deploy/ijary/README.md`; fallback Cloudflare origin certificate (research.md R5)
- [ ] T089 [US3] Wildcard redirect allow-list and CORS origins for GoTrue and the API in `deploy/ijary/supabase.env.example`
- [ ] T090 [US3] Gate: quickstart.md Phase 2 steps 3 to 6

**Checkpoint**: Two companies open on separate addresses with separate accounts.

---

## Phase 6: User Story 4 - The super admin creates and manages companies and their users (Priority: P1) [plan Phase 2]

**Goal**: A separate, second-factor-protected panel where the owner creates companies and manages their users.

**Independent Test**: quickstart.md Phase 2 steps 1, 2 and 11.

### Tests for User Story 4

- [ ] T091 [P] [US4] SQL tests: `is_platform_admin()` needs the row and `aal2`; a super admin reads 0 company rows through RLS; `platform_audit_log` is insert-only, in `src/db/platform/platformAdmin.sqltest.ts`
- [ ] T092 [P] [US4] Company creation tests (seeds roles, templates, lists, workflows, sections, limits, first admin; `SLUG_TAKEN`, `SLUG_RESERVED`, `SLUG_INVALID`) in `src/platform/companies.test.ts`

### Implementation for User Story 4

- [ ] T093 [US4] Write migration `db/migrations/289_platform_admins.sql`: `platform_admins`, full `is_platform_admin()`, `platform_audit_log`, `seed_company_defaults()` (data-model.md: `companies.slug`, `reserved_slugs.slug`; research.md R16)
- [ ] T094 [US4] Platform audit writer with secret stripping in `src/platform/audit.ts`
- [ ] T095 [US4] `platformCreateCompany`, `platformListCompanies`, `platformUpdateCompany` in `src/platform/companies.ts`
- [ ] T096 [US4] `platformListUsers`, `platformCreateUser`, `platformSetUserActive`, `platformResetPassword` in `src/platform/users.ts`
- [ ] T097 [US4] Super admin layout with guard and forced second-factor enrolment in `src/routes/platform.tsx`, `src/routes/platform.login.tsx`, `src/routes/platform.mfa.tsx`
- [ ] T098 [P] [US4] Companies screens: `src/routes/platform.companies.tsx`, `src/routes/platform.companies.$id.tsx`, `src/components/platform/CompaniesTable.tsx`, `src/components/platform/CompanyCreateDialog.tsx`
- [ ] T099 [P] [US4] Company users panel in `src/components/platform/CompanyUsersPanel.tsx`
- [ ] T100 [P] [US4] Audit log screen in `src/routes/platform.audit.tsx`
- [ ] T101 [US4] Enforce the first-sign-in password change in `src/routes/admin.tsx` and `src/routes/portal.tsx`
- [ ] T102 [P] [US4] Bootstrap script for the first super admin in `scripts/create-platform-admin.ts`
- [ ] T103 [P] [US4] Arabic and English strings for the super admin panel in `src/i18n/`
- [ ] T104 [US4] Gate: quickstart.md Phase 2 steps 1, 2 and 11; record SC-002 and SC-015

**Checkpoint**: The owner can create a working company end to end.

---

## Phase 7: User Story 5 - The super admin shows and hides sections per company (Priority: P2) [plan Phase 2]

**Goal**: Per-company section switches enforced by the database.

**Independent Test**: quickstart.md Phase 2 step 7.

### Tests for User Story 5

- [ ] T105 [P] [US5] SQL tests: with a section off `has_permission` is false for every role including `admin`, data is kept, the other company is unaffected, in `src/db/modules/moduleGate.sqltest.ts`
- [ ] T106 [P] [US5] Test that every permission code in `src/lib/permissions.ts` maps to a section or is marked always-on, in `src/company/modules.test.ts`

### Implementation for User Story 5

- [ ] T107 [US5] Write migration `db/migrations/290_company_modules.sql`: `company_modules`, `module_enabled()`, the `has_permission` change, `get_my_modules()` (data-model.md: `company_modules.module_key`; research.md R10)
- [ ] T108 [US5] Section keys and the permission-to-section map in `src/company/modules.ts`
- [ ] T109 [US5] `platformSetModules` in `src/platform/modules.ts` and `src/components/platform/ModuleSwitches.tsx`
- [ ] T110 [US5] `myModules` in `src/fns/myModules.ts` and `src/hooks/useModules.ts` (cache at most 60 seconds)
- [ ] T111 [US5] Build navigation and dashboard from enabled sections in `src/components/admin/AdminSidebar.tsx` and `src/lib/cardRegistry.ts`; add `src/company/requireModule.ts` and call it in the `beforeLoad` of each `src/routes/admin.*.tsx` section route
- [ ] T112 [US5] Skip a switched-off section's jobs in `src/worker/runJob.ts` using the section field of `src/jobs/catalog.ts`
- [ ] T113 [US5] Gate: quickstart.md Phase 2 step 7; record SC-007

**Checkpoint**: A hidden section is unreachable by every route.

---

## Phase 8: User Story 6 - The super admin tracks subscriptions and suspends companies (Priority: P2) [plan Phase 2]

**Goal**: Manual subscription records with reminders; suspension that locks a company out but keeps payments already made.

**Independent Test**: quickstart.md Phase 2 steps 9 and 10.

### Tests for User Story 6

- [ ] T114 [P] [US6] SQL tests: a suspended company's users read 0 rows; `allow_suspended` still settles a payment; reactivation restores access, in `src/db/platform/suspension.sqltest.ts`
- [ ] T115 [P] [US6] Reminder tests for the 14, 7 and 1 day marks and the overdue flag in `src/jobs/handlers/subscriptionRemind.test.ts`

### Implementation for User Story 6

- [ ] T116 [US6] Write migration `db/migrations/291_company_subscriptions.sql` (data-model.md: `company_subscriptions.status`, `companies.status`)
- [ ] T117 [US6] `platformRecordSubscription` in `src/platform/subscriptions.ts` and `src/components/platform/SubscriptionPanel.tsx`
- [ ] T118 [US6] `subscription.remind` handler in `src/jobs/handlers/subscriptionRemind.ts`, its schedule in `src/worker/scheduler.ts`, and the warnings list on `src/routes/platform.companies.tsx`
- [ ] T119 [US6] Renewal banner: `src/fns/companySubscriptionBanner.ts` and `src/components/admin/SubscriptionBanner.tsx`
- [ ] T120 [US6] `platformSetCompanyStatus` with a required reason in `src/platform/companies.ts` and its control in `src/routes/platform.companies.$id.tsx`
- [ ] T121 [US6] Suspended page in `src/routes/suspended.tsx`; serve it from `server/middleware/company.ts`; refuse in `src/fns/signInWithIdentifier.ts` and `src/fns/createPayment.ts`
- [ ] T122 [US6] In `src/worker/runJob.ts` skip jobs of suspended companies except `payment.settle`, which uses `companyClient(…, { allowSuspended: true })`
- [ ] T123 [US6] Gate: quickstart.md Phase 2 steps 9 and 10; record SC-008 and SC-010

**Checkpoint**: Subscriptions are tracked and suspension works without losing a paid payment.

---

## Phase 9: User Story 7 - Each company has limits the super admin can raise (Priority: P2) [plan Phase 2]

**Goal**: Four limits enforced on every route.

**Independent Test**: quickstart.md Phase 2 step 8 and Phase 4 step 6.

### Tests for User Story 7

- [ ] T124 [P] [US7] SQL tests for the unit, staff and storage limits by direct insert and by import, raising the limit, and a limit lowered below usage, in `src/db/limits/limits.sqltest.ts`

### Implementation for User Story 7

- [ ] T125 [US7] VERIFY that a trigger on `storage.objects` is allowed in the self-hosted Storage version; record in `specs/001-multi-company-saas/research.md` R11 (fallback: server-issued signed upload URLs)
- [ ] T126 [US7] Write migration `db/migrations/292_company_limits.sql`: `company_limits`, `company_usage_monthly`, `company_storage_usage`, the unit and staff triggers, `storage_within_limit()` (data-model.md: `company_limits.max_units`, `company_limits.max_staff_users`, `company_limits.max_whatsapp_per_month`, `company_limits.max_storage_bytes`)
- [ ] T127 [US7] Map `LIMIT_*` errors to messages in `src/company/limits.ts` and `src/i18n/`
- [ ] T128 [US7] `platformSetLimits` in `src/platform/limits.ts` and `src/components/platform/LimitsPanel.tsx`
- [ ] T129 [US7] Count and cap WhatsApp sends per month in `src/jobs/handlers/notification.ts`, marking over-limit messages skipped (data-model.md: `notifications.skip_reason`)
- [ ] T130 [US7] Report rows refused by a limit in `src/jobs/handlers/bulk.ts` (`import.run`)
- [ ] T131 [US7] `companyUsage` in `src/fns/companyUsage.ts` and `src/components/admin/settings/UsageCard.tsx` with the 80% notice
- [ ] T132 [US7] `usage.rebuild` handler in `src/jobs/handlers/sync.ts`
- [ ] T133 [US7] Gate: quickstart.md Phase 2 step 8; record SC-009

**Checkpoint**: Plan Phase 2 gate reached; a second real company may be onboarded.

---

## Phase 10: User Story 8 - Each company collects online payments through its own gateway account (Priority: P2) [plan Phase 3]

**Goal**: Per-company gateway credentials, one active gateway, payments settled exactly once.

**Independent Test**: quickstart.md Phase 3 steps 1 to 8 in the MyFatoorah sandbox.

### Tests for User Story 8

- [ ] T134 [P] [US8] Encryption tests (round trip, wrong key fails, key version, `last4`) in `src/lib/secrets.server.test.ts`
- [ ] T135 [P] [US8] Shared adapter contract suite run against every adapter in `src/gateways/contract.test.ts`
- [ ] T136 [P] [US8] SQL tests: one active connection, activation needs a passing test, secrets unreadable by another company and by `authenticated`, in `src/db/gateways/gatewayConnections.sqltest.ts`
- [ ] T137 [P] [US8] Webhook route tests (unknown connection 404, bad signature stored and ignored, duplicate event enqueues nothing) in `src/routes/api/public/webhooks/gateway.test.ts`
- [ ] T138 [P] [US8] Settlement tests: recorded once by webhook, return page and reconciliation; an in-flight payment settles on its original connection, in `src/fns/gatewaySettlement.test.ts`

### Implementation for User Story 8

- [ ] T139 [US8] Write migration `db/migrations/293_company_secrets.sql` (data-model.md: `company_secrets.owner_kind`; research.md R9)
- [ ] T140 [US8] Implement AES-256-GCM encrypt and decrypt with key versions in `src/lib/secrets.server.ts`
- [ ] T141 [US8] Write migration `db/migrations/294_gateway_connections.sql`: `gateway_connections`, `payment_requests` and `webhook_events` extensions (data-model.md: `gateway_connections.provider`, `gateway_connections.mode`, `gateway_connections.is_active`)
- [ ] T142 [US8] `PaymentGateway` interface and registry in `src/gateways/types.ts` and `src/gateways/registry.ts`
- [ ] T143 [US8] MyFatoorah adapter in `src/gateways/myfatoorah.ts`, moved from `src/fns/myfatoorahGateway.ts`
- [ ] T144 [US8] Bind each payment request to its connection and credentials version in `src/fns/createPayment.ts`, `src/fns/confirmGatewayPayment.ts` and `src/fns/gatewaySettlement*.ts`
- [ ] T145 [US8] Webhook route `src/routes/api/public/webhooks/$provider.$connectionId.ts` and the `webhook.process` and `payment.settle` handlers in `src/jobs/handlers/inbound.ts`; delete `src/routes/api/public/myfatoorah-webhook.ts`
- [ ] T146 [US8] Reconcile per company and connection in `src/fns/paymentReconcileJob.ts`
- [ ] T147 [US8] Make the return page session-free and company-bound in `src/routes/portal_.payments.callback_.$preq.tsx` (`contracts/webhooks.md`)
- [ ] T148 [US8] `gatewayList`, `gatewaySaveCredentials`, `gatewayTestConnection`, `gatewayActivate`, `gatewayDeactivate` in `src/fns/gatewaySettings.ts`
- [ ] T149 [US8] Payment gateway card in `src/components/admin/settings/PaymentGatewayCard.tsx`, shown from `src/routes/admin.settings.integrations.tsx`
- [ ] T150 [US8] Hide online payment in the portal when no gateway is active, in `src/routes/portal.invoices.tsx` and `src/routes/portal.payments.tsx`
- [ ] T151 [US8] `platformSetGatewayLiveAllowed` in `src/platform/gateways.ts` and its switch in `src/components/platform/GatewayLaunchPanel.tsx`
- [ ] T152 [US8] Run quickstart.md Phase 3 for MyFatoorah in sandbox and record SC-011 and SC-012
- [ ] T153 [US8] ⛔ BLOCKED(owner: Tap sandbox account) VERIFY Tap's API version, webhook signature and KWD precision in research.md R14; implement `src/gateways/tap.ts`; run quickstart.md Phase 3 for Tap
- [ ] T154 [US8] ⛔ BLOCKED(owner: UPayments sandbox account) VERIFY UPayments' API version and webhook verification in research.md R14; implement `src/gateways/upayments.ts`; run quickstart.md Phase 3 for UPayments
- [ ] T155 [US8] Gate: lint, typecheck, tests, guard skills for the phase

**Checkpoint**: A company collects through its own MyFatoorah account; Tap and UPayments follow when unblocked.

---

## Phase 11: User Story 9 - Each company connects its own WhatsApp (Priority: P3) [plan Phase 4]

**Goal**: QR, official API and coexistence per company, with isolated inboxes.

**Independent Test**: quickstart.md Phase 4 steps 1 to 6.

### Tests for User Story 9

- [ ] T156 [P] [US9] SQL tests: one active method per company, one number on one company, another company cannot read a connection, in `src/db/whatsapp/connections.sqltest.ts`
- [ ] T157 [P] [US9] Routing tests: Evolution event by connection id and secret; Meta event by `phone_number_id`; unknown number dropped, in `src/whatsapp/routing.test.ts`

### Implementation for User Story 9

- [ ] T158 [US9] Write migration `db/migrations/<next free number>_whatsapp_connections.sql` (295 is taken since the T052l split): `whatsapp_connections` replacing `evolution_connections`; `connection_id` on the four `whatsapp_*` tables (data-model.md: `whatsapp_connections.method`, `whatsapp_connections.status`, `whatsapp_connections.is_active`, `whatsapp_connections.connected_number`, `whatsapp_connections.phone_number_id`)
- [ ] T159 [US9] Per-company Evolution instance lifecycle in `src/whatsapp/evolutionInstance.ts`
- [ ] T160 [US9] Route `src/routes/api/public/webhooks/evolution.$connectionId.ts` and connection lookup in `src/fns/evolutionWebhook.ts`; delete `src/routes/api/public/evolution-webhook.ts`
- [ ] T161 [US9] Per-company disconnect detection and alert in `src/fns/evolutionSessionWatch.ts` and `src/fns/notifyWhatsappSessionDisconnected.ts`
- [ ] T162 [US9] `whatsappStatus`, `whatsappStartQr`, `whatsappDisconnect`, `whatsappActivate` in `src/fns/whatsappSettings.ts`; replace `EvolutionConnectionCard` with `src/components/admin/settings/WhatsAppCard.tsx`
- [ ] T163 [US9] Scope inbox queries by connection in the WhatsApp hooks under `src/hooks/`
- [ ] T164 [US9] ⛔ BLOCKED(owner: Meta app id, app secret, Embedded Signup configuration id) VERIFY current Embedded Signup parameters for coexistence and the Graph API version in research.md R15
- [ ] T165 [US9] Official API sending with the approved-template check in `src/whatsapp/cloudApi.ts`
- [ ] T166 [US9] Meta webhook route `src/routes/api/public/webhooks/meta.ts` and routing in `src/whatsapp/routing.ts`
- [ ] T167 [US9] Embedded Signup with coexistence in `src/whatsapp/embeddedSignup.ts`; `whatsappEmbeddedSignupConfig`, `whatsappCompleteEmbeddedSignup`, `whatsappSaveCloudCredentials` in `src/fns/whatsappSettings.ts`; the sign-up button in `WhatsAppCard.tsx`
- [ ] T168 [US9] Gate: quickstart.md Phase 4 steps 1 to 6; record SC-013

**Checkpoint**: Each company sends and receives on its own number.

---

## Phase 12: User Story 10 - A company can send email before configuring its own (Priority: P3) [plan Phase 4]

**Goal**: Platform default sender with the company's name and reply address; a company's own sender takes precedence.

**Independent Test**: quickstart.md Phase 4 step 7.

### Tests for User Story 10

- [ ] T169 [P] [US10] Tests: no company sender uses the platform sender with company name and reply-to; own sender takes precedence; a possibly-delivered failure is not resent, in `src/fns/dispatchEmailChannel.test.ts`

### Implementation for User Story 10

- [ ] T170 [US10] Write migration `db/migrations/296_email_sender_per_company.sql`: move `provider_configs` secret references to `company_secrets`
- [ ] T171 [US10] ⛔ BLOCKED(owner: platform default sender address and provider) Default sender in `src/fns/dispatchEmailChannel.ts`; read company secrets in `src/lib/providers/smtp.ts` and `src/lib/providers/types.ts`
- [ ] T172 [US10] Routes `src/routes/api/public/webhooks/resend.$companyId.ts` and `src/routes/api/public/webhooks/resend-platform.ts`; update `src/fns/resendWebhook.ts`; delete `src/routes/api/public/resend-webhook.ts`
- [ ] T173 [US10] `emailSenderStatus` in `src/fns/emailSenderStatus.ts` and its display in `src/routes/admin.settings.notifications.tsx`
- [ ] T174 [US10] Gate: quickstart.md Phase 4 step 7; record SC-014

**Checkpoint**: Plan Phase 4 gate reached.

---

## Phase 13: User Story 11 - The super admin enters a company's panel for support (Priority: P3) [plan Phase 5]

**Goal**: Time-limited, reasoned, fully audited support sessions.

**Independent Test**: quickstart.md Phase 5 steps 1 to 5.

### Tests for User Story 11

- [ ] T175 [P] [US11] SQL tests: an open session grants the company, an ended or expired one grants nothing, `write_audit` records the impersonator, in `src/db/platform/impersonation.sqltest.ts`
- [ ] T176 [P] [US11] Tests: start refused without a reason; credential and secret functions refuse during a session, in `src/platform/supportSession.test.ts`

### Implementation for User Story 11

- [ ] T177 [US11] Write migration `db/migrations/297_impersonation_sessions.sql`: the table, the session branch of `current_company_id()`, the impersonator in `write_audit` (data-model.md: `impersonation_sessions.reason`, `impersonation_sessions.expires_at`; research.md R17)
- [ ] T178 [US11] `platformStartSupportSession` and `platformEndSupportSession` with token minting in `src/platform/supportSession.ts`
- [ ] T179 [US11] Accept the support token on the company host in `src/routes/support-session.tsx` and `src/auth/AuthProvider.tsx`
- [ ] T180 [US11] Persistent red banner in `src/components/admin/SupportSessionBanner.tsx`, mounted in `src/routes/admin.tsx`
- [ ] T181 [US11] Refuse with `SUPPORT_SESSION_FORBIDDEN` in `src/fns/gatewaySettings.ts`, `src/fns/whatsappSettings.ts`, `src/fns/updateAppUser.ts` and `src/fns/passwordReset.ts`
- [ ] T182 [US11] Start and end controls in `src/routes/platform.companies.$id.tsx`
- [ ] T183 [US11] Gate: quickstart.md Phase 5 steps 1 to 5

**Checkpoint**: Support access works and leaves a complete trail.

---

## Phase 14: User Story 12 - The super admin watches the whole platform (Priority: P3) [plan Phase 5]

**Goal**: Totals and per-company health in one view.

**Independent Test**: quickstart.md Phase 5 step 6.

### Tests for User Story 12

- [ ] T184 [P] [US12] SQL tests for the totals and health flags with one healthy and one degraded company, in `src/db/platform/overview.sqltest.ts`

### Implementation for User Story 12

- [ ] T185 [US12] Write migration `db/migrations/298_platform_overview.sql`: read-only aggregate functions callable only by a platform admin
- [ ] T186 [US12] `platformOverview` in `src/platform/overview.ts`
- [ ] T187 [US12] Overview screen in `src/routes/platform.index.tsx` with `src/components/platform/OverviewTotals.tsx` and `src/components/platform/CompanyHealthTable.tsx`
- [ ] T188 [US12] Gate: quickstart.md Phase 5 step 6

**Checkpoint**: Plan Phase 5 gate reached.

---

## Phase 15: User Story 13 - A company gets its own domain and landing page (Priority: P4, last) [plan Last]

**Goal**: Owner-managed custom domains; per-company landing pages; a platform marketing page.

**Independent Test**: quickstart.md "Last phase" steps 1 and 2.

### Tests for User Story 13

- [ ] T189 [P] [US13] Tests: a verified custom host resolves to its company, an unverified one does not; landing content is the host company's only, in `src/company/customDomain.test.ts`

### Implementation for User Story 13

- [ ] T190 [US13] VERIFY Cloudflare for SaaS custom hostname limits and API on the owner's plan; record in research.md R5
- [ ] T191 [US13] Write migration `db/migrations/299_custom_domains.sql` for custom rows and their state (data-model.md: `company_domains.kind`, `company_domains.verification_status`)
- [ ] T192 [US13] `platformAddCustomDomain` and `platformVerifyCustomDomain` in `src/platform/domains.ts`, with the Cloudflare client in `src/platform/cloudflare.server.ts`
- [ ] T193 [US13] Domains panel in `src/components/platform/DomainsPanel.tsx`
- [ ] T194 [US13] Accept verified custom hosts in `src/company/hostCompany.server.ts`; document the allow-list update in `deploy/ijary/README.md`
- [ ] T195 [US13] Per-company landing: scope `src/hooks/useLandingSettings.ts` by the host's company and serve it from `src/routes/index.tsx` when the section is on
- [ ] T196 [US13] Platform marketing page replacing the temporary page in `src/routes/index.tsx` and `src/components/platform/MarketingPage.tsx`
- [ ] T197 [US13] Gate: quickstart.md "Last phase"

**Checkpoint**: All user stories delivered.

---

## Phase 16: Polish & Cross-Cutting Concerns

- [ ] T198 [P] Update `README.md`, `db/README.md` and `src/routes/README.md` for the multi-company model, the worker and the new route groups
- [ ] T199 [P] Write the IJARY deployment and operations runbook in `deploy/ijary/README.md` (stack, environment, migrations, backups with extended attributes preserved, worker, wildcard address)
- [ ] T200 Measure `current_company_id()` cost with the invoice-count benchmark from migration 243 and record it in `specs/001-multi-company-saas/research.md` R1
- [ ] T201 Run the `security-review` skill over isolation, tokens, secrets and webhooks; fix or record each finding
- [ ] T202 Run every phase of `specs/001-multi-company-saas/quickstart.md` end to end on a staging stack and record the results
- [ ] T203 Confirm SC-016: no command, migration or deployment in this feature targeted Danat's production
- [ ] T204 [P] Run `graphify update .` and refresh `graphify-out/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: after Setup; blocks every story.
- **US1 (Phase 3)**: after Foundational. **Hard gate**: nothing in a shared environment holds a second company before T052 passes.
- **US2 (Phase 4)**: after US1 (handlers use `companyClient`; tables are company-scoped).
- **US3 (Phase 5)** and **US4 (Phase 6)**: after US2 (password reset and credentials are sent by jobs). US4 needs US3's host gating (T081).
- **US5, US6, US7 (Phases 7 to 9)**: after US4; independent of each other.
- **US8 (Phase 10)**: after US6 (suspension rules) and US5 (`online_payments` section).
- **US9 (Phase 11)**: after US7 (WhatsApp limit) and T139 to T140 (secrets).
- **US10 (Phase 12)**: after T139 to T140; independent of US9.
- **US11 (Phase 13)**: after US8 and US9 (their functions are the ones refused in a session).
- **US12 (Phase 14)**: after US7, US8 and US9 (the data it reports).
- **US13 (Phase 15)**: last.
- **Polish (Phase 16)**: after the stories being released.

### Owner-blocked tasks

| Task | Needs |
|---|---|
| T088 | Cloudflare API token for `ijary.app`; Dokploy access |
| T153 | Tap sandbox account |
| T154 | UPayments sandbox account |
| T164 (and T165 to T167 after it) | Meta app id, app secret, Embedded Signup configuration id |
| T171 | Platform default sender address and provider |

### VERIFY tasks

T058 (BullMQ on Bun), T088 (Dokploy wildcard), T125 (storage trigger), T153 (Tap), T154 (UPayments), T164 (Meta coexistence), T190 (Cloudflare for SaaS).

### Within Each User Story

- Tests are written first and must fail before implementation.
- Migrations before the code that uses them; each migration task updates `database.types.ts`.
- Server functions before screens.
- The gate task closes the story.

### Parallel Opportunities

- Setup: T003, T004, T005.
- US1 tests T012 to T020 together; call-site moves T041 to T047 together once T021 to T039 are in. The group migrations T021 to T032 are sequential (foreign-key order).
- US2 tests T053 to T057 together; handler families T067 to T070 touch different files but share `catalog.ts`, so land T060 first.
- US4 screens T098 to T100, T102 and T103 together.
- After US4, stories US5, US6 and US7 can be worked by different people.
- US9 and US10 can run side by side once secrets exist.

---

## Parallel Example: User Story 1

```bash
# Tests first, together:
Task: "Structure test tablesScoped in src/db/isolation/tablesScoped.sqltest.ts"            # T012
Task: "Structure test definerFunctions in src/db/isolation/definerFunctions.sqltest.ts"    # T013
Task: "Behaviour matrix in src/db/isolation/crossCompanyMatrix.sqltest.ts"                 # T015

# After the migrations, call sites together:
Task: "Move src/lib service-role importers to companyClient"                               # T041
Task: "Move notification family in src/fns to companyClient"                               # T042
Task: "Move payment family in src/fns to companyClient"                                    # T043
```

---

## Implementation Strategy

### MVP First

1. Phase 1 and Phase 2.
2. Phase 3 (US1). **Stop and validate**: isolation suite 100% green.
3. Phase 4 (US2). **Stop and validate**: outbox and worker checks.

At this point the product is still used by one company but is safe to host a second.

### Incremental Delivery

1. US3 and US4: a second company can be created and reached. First usable multi-company release.
2. US5, US6, US7: the owner controls sections, subscriptions and limits.
3. US8: per-company online collection (MyFatoorah, then Tap and UPayments as unblocked).
4. US9 and US10: per-company WhatsApp and email.
5. US11 and US12: support access and overview.
6. US13: custom domains and landing pages.

Each step ends at its gate in quickstart.md and can be demonstrated on its own.

### Parallel Team Strategy

One person owns the migration sequence (T021 to T039) to keep numbering and ordering consistent. Others write US1 tests, then the call-site moves. After US4, split by story.

---

## Notes

- 204 tasks: Setup 5, Foundational 6, US1 41, US2 25, US3 13, US4 14, US5 9, US6 10, US7 10, US8 22, US9 13, US10 6, US11 9, US12 5, US13 9, Polish 7.
- Migration numbers 254 to 299 are reserved by this plan; if another change takes a number first, renumber and keep the order.
- Commit after each task or logical group; never push to a deploying branch without the owner's go-ahead.
- `.specify/memory/constitution.md` is unfilled; the gates used are the rules at the top of this file.
