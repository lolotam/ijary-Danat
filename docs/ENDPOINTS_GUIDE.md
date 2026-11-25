# Danat Al Mustaqbal ERMP: Endpoint and TestSprite Guide

This is the source-of-truth test map for the Danat Al Mustaqbal Estate Rental
Management Platform (ERMP). It complements the high-level project README and
the ordered manual journeys in [E2E_ADMIN_TEST_JOURNEYS.md](E2E_ADMIN_TEST_JOURNEYS.md).

For direct TestSprite backend requests, use the narrow HTTP allowlist in
[TESTSPRITE_BACKEND_TARGETS.md](TESTSPRITE_BACKEND_TARGETS.md). The server
function catalog in this document is an operation reference, not a list of URL
paths.

Use this file when configuring TestSprite to generate frontend and backend test
plans. It distinguishes stable browser and HTTP URLs from TanStack Start server
functions, whose transport URLs are framework-managed and must not be hardcoded.

## 1. Application summary

| Item                  | Value                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| Product               | Danat Al Mustaqbal Real Estate Rental Management Platform (ERMP)                                      |
| Primary users         | Staff: admin, accountant, collector, readonly; tenant portal users                                    |
| Public landing page   | `/` serves the Danat Al Jahra shopping and leasing landing site, managed through the landing-page CMS |
| Staff authentication  | `/auth`                                                                                               |
| Tenant authentication | `/portal/auth`                                                                                        |
| Staff workspace       | `/admin` and child routes                                                                             |
| Tenant workspace      | `/portal` and child routes                                                                            |
| Data platform         | Self-hosted Supabase: Auth, Postgres, PostgREST, Storage, Realtime, and RLS                           |
| Payment provider      | MyFatoorah hosted payments with signed webhook settlement                                             |
| Notifications         | SMTP or Resend email; WhatsApp Cloud API or Twilio                                                    |
| Local test URL        | `http://localhost:5173` when started with `bun run dev`                                               |
| Production URL        | `https://danat-future.com`                                                                            |

## 2. Test boundaries and terminology

### Stable browser routes

The routes in Section 3 are stable URLs and are the correct targets for
TestSprite frontend tests.

### Public HTTP endpoints

The routes in Section 4 accept direct HTTP requests and are the correct targets
for backend integration tests. They require secrets and should only run against
a safe test environment.

### TanStack Start server functions

The functions in Section 5 are backend operations defined with
`createServerFn`. TanStack Start generates their wire transport internally at
build time. Do not invent or hardcode REST paths for them. Test them through
the browser workflow that calls them, or through the existing/new Vitest unit
tests that import the function module.

In particular, paths such as `/generateInvoices`, `/createPayment`,
`/submitLeasingInquiry`, and `/publicBranding` are not registered HTTP routes.
A direct `POST` to one of those paths correctly returns the app's HTML `404`
page; that response is not a backend handler failure.

### Direct Supabase operations

Most CRUD pages use the Supabase JavaScript client directly through React Query
hooks. These operations are protected by Supabase Row Level Security (RLS), not
by app-owned REST endpoints. Test them through the UI under the appropriate role.

## 3. Browser route map

The staff auth route and both workspace layouts use client rendering
(`ssr: false`). The layout guards redirect unauthenticated users, while Supabase
RLS remains the data-security boundary.

### Public and authentication routes

| Route                             | Access                      | Purpose                                                  | Key test coverage                                                                                                                     |
| --------------------------------- | --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                               | Public                      | Danat Al Jahra landing page and leasing inquiry form     | AR/EN, RTL/LTR, theme, CMS content, media, map link, leasing form validation and submission                                           |
| `/auth`                           | Public, staff-only sign-in  | Managerial login                                         | Valid staff login redirects to `/admin`; invalid password stays on page; tenant-only credentials are rejected and signed out          |
| `/portal/auth`                    | Public, tenant-only sign-in | Tenant portal login                                      | Valid tenant login redirects to `/portal/payments` or safe `?redirect=/portal...`; staff-only credentials are rejected and signed out |
| `/portal/payments/callback`       | Gateway redirect            | Receives MyFatoorah payment identifier from query string | Pending, paid, failed, missing and malformed payment reference states; preserves string identifiers                                   |
| `/portal/payments/callback/:preq` | Gateway redirect            | Fallback callback with `PREQ-...` code                   | Resolves payment request code when gateway query parameters are incomplete                                                            |

### Admin routes

| Route                           | Module and direct data surface                                           | Primary frontend tests                                                                            |
| ------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `/admin`                        | Authenticated shell; sidebar, inbox bell, locale/theme controls          | Unauthenticated redirect to `/auth`; nav loads; sign-out; AR/EN direction switch                  |
| `/admin/`                       | Dashboard; KPI and report reads                                          | Empty-state stability; values update after a payment flow                                         |
| `/admin/properties`             | `properties`, bulk import/export, media                                  | Create, edit, detail navigation, search/filter, CSV template/import validation                    |
| `/admin/properties/:id`         | Property detail                                                          | Valid ID loads; unknown ID fails gracefully; persisted edit is visible after reload               |
| `/admin/units`                  | `units`                                                                  | Create under a property; required property; status filters and default rent                       |
| `/admin/units/:id`              | Unit detail                                                              | Valid ID loads; edit persistence; related contract state is visible                               |
| `/admin/tenants`                | `tenants`, tenant document storage                                       | Create/edit, portal enabled flag, search/filter, safe empty state                                 |
| `/admin/tenants/:id`            | Tenant detail                                                            | Valid ID loads; notes and profile fields persist                                                  |
| `/admin/tenants/:id/documents`  | Tenant document upload/share                                             | Upload permitted type; preview/share; storage failure has actionable error                        |
| `/admin/contracts`              | `contracts`, `concessions`                                               | Requires tenant and unit; create draft then activate; reject second active contract for same unit |
| `/admin/invoices`               | `invoices`, invoice details and visibility                               | Generate idempotently; print; tenant visibility; mark paid/unpaid; overdue evaluation             |
| `/admin/payments`               | `payments`, `payment_allocations`                                        | Manual payment, full/partial allocation, reversal reason required, invoice totals update          |
| `/admin/deposits`               | `deposits`, `deposit-attachments` storage                                | Create/edit/filter; attachment; confirmation notification; export/import if shown                 |
| `/admin/expenses`               | `expense_categories`, `expenses`, `expense-attachments` storage, budgets | Category CRUD; expense CRUD; attachment cleanup; totals and filters                               |
| `/admin/electricity`            | `electricity_tariffs`, `electricity_meters`, readings, charges           | Tariff to meter to reading to charge; reject negative consumption; period generation              |
| `/admin/maintenance`            | `maintenance`                                                            | Create/edit/list/import if route is enabled; note this module is currently hidden from sidebar    |
| `/admin/inbox`                  | Tenant messages and notifications                                        | Empty state; mark read; reply; unread badge consistency                                           |
| `/admin/reports`                | `report_schedules`, `generated_reports`                                  | Preview, period changes, schedule save, resend generated report                                   |
| `/admin/audit`                  | `audit_logs`                                                             | Read-only filters; money and user actions appear; no edit/delete UI                               |
| `/admin/settings`               | Settings layout                                                          | Tabs and child route navigation                                                                   |
| `/admin/settings/`              | `companies`                                                              | Company details, logo/favicon, KWD/timezone/bank fields, validation and reload persistence        |
| `/admin/settings/users`         | `profiles`, `user_roles`, Supabase Auth                                  | Admin creates/edits/deletes allowed user; admin cannot delete self; tenant link route             |
| `/admin/settings/roles`         | `custom_roles`, `custom_role_permissions`, `role_permissions`            | Default/custom role display; permission matrix; restricted role behavior                          |
| `/admin/settings/lists`         | Option/list tables                                                       | Create/edit/disable/reorder option; option appears in dependent forms                             |
| `/admin/settings/notifications` | Provider configs, templates, notifications                               | Provider configuration save; template edit/preview; missing provider clear error                  |
| `/admin/settings/landing-page`  | `landing_page_settings`, sections, media, brands, slides, inquiries      | CMS save is reflected on `/`; leasing inquiry management                                          |

### Tenant portal routes

| Route              | Access                                         | Direct data surface                | Primary frontend tests                                                              |
| ------------------ | ---------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| `/portal`          | Tenant, or staff with `?tenant=<uuid>` preview | Portal identity, invoice summary   | Tenant dashboard loads; disabled portal message; staff preview works only for staff |
| `/portal/lease`    | Tenant or staff preview                        | Active contract, unit, concessions | Only active tenant lease appears; empty state is stable                             |
| `/portal/invoices` | Tenant or staff preview                        | Visible unpaid tenant invoices     | Hidden invoices excluded; due order is correct; balances shown accurately           |
| `/portal/payments` | Tenant or staff preview                        | Confirmed/reversed tenant payments | History loads; pay action follows invoice ordering rules                            |
| `/portal/receipts` | Tenant or staff preview                        | Tenant-visible receipts            | Only `visible_to_tenant` receipts appear                                            |
| `/portal/profile`  | Tenant or staff preview                        | Tenant profile                     | Allowed profile updates persist; staff preview must not become tenant impersonation |

## 4. Public HTTP endpoints

Use direct backend HTTP tests only with a test database and test provider secrets.
Never send production payment events, real cron secrets, or destructive payloads.

### `POST /api/public/cron`

| Item                                 | Contract                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Authentication                       | `Authorization: Bearer <CRON_SECRET>`; alternate header parsing is implemented by `readCronSecretHeader` |
| Content type                         | `application/json`                                                                                       |
| Body                                 | `{ "job": <key>, "asOf": "YYYY-MM-DD" or null }` — `<key>` is one of the ten keys of `JOBS` in `src/fns/cronJobs.ts`; five of them ignore `asOf` (see `deploy/README.md`) |
| Success                              | `200` with `{ job, durationMs, result }`                                                                 |
| Secret absent                        | `503` with `CRON_SECRET is not configured` error                                                         |
| Missing/invalid secret               | `401`                                                                                                    |
| Non-JSON, bad job, or invalid `asOf` | `400`                                                                                                    |
| Job failure                          | `500` with job and error                                                                                 |
| Idempotency                          | All jobs are designed to tolerate repeated runs; test an immediate retry                                 |

Recommended backend cases:

1. No authorization header returns `401`.
2. Unsupported job returns `400` and lists valid names.
3. Invalid date returns `400`.
4. Each valid job returns `200` with its name and non-negative `durationMs`.
5. Repeating the same valid job does not create duplicate invoice, reminder, or report records.

### `POST /api/public/myfatoorah-webhook`

| Item                       | Contract                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| Authentication             | HMAC signature using `MYFATOORAH_WEBHOOK_SECRET`                                              |
| Accepted signature headers | `MyFatoorah-Signature` / `myfatoorah-signature`, `X-MyFatoorah-Signature`, or `Authorization` |
| Body                       | Raw JSON from MyFatoorah; event data is normalized from common root and `Data` key shapes     |
| Secret absent              | `503` with configuration error                                                                |
| Invalid signature          | `401`; event is recorded as invalid when possible                                             |
| Duplicate event            | `200` with `{ ok: true, replay: true }`                                                       |
| Non-success event          | `200` with `{ ok: true, ignored: true }`                                                      |
| Successful settlement      | `200` with `{ ok: true, replay: boolean }`                                                    |
| Settlement error           | `500` with an error message and failed event record                                           |

Recommended backend cases:

1. Missing secret returns `503`.
2. Invalid HMAC returns `401` and does not settle a payment.
3. Valid unsuccessful gateway event is acknowledged but ignored.
4. Valid paid event settles the matching payment request exactly once.
5. Replaying the identical provider event returns success without duplicate payment, allocation, receipt, or notification.

## 5. TanStack Start server-function operation catalog

All entries below are backend operations, but not stable public REST endpoints.
`Auth` means `requireSupabaseAuth`; `Admin` means an explicit `has_role('admin')`
check; a permission code is checked with `has_permission`.

### Public configuration and landing operations

| Function                  | Source                            | Method | Auth   | Validated input                                                                                                                                                           | Expected behavior and tests                                                                                  |
| ------------------------- | --------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `getPublicBranding`       | `src/fns/publicBranding.ts`       | GET    | Public | None                                                                                                                                                                      | Returns `logoUrl`, `faviconUrl`, `portalBgUrl`; cache lasts one minute; must never expose a service role key |
| `getPublicSupabaseConfig` | `src/fns/publicRuntimeConfig.ts`  | GET    | Public | None                                                                                                                                                                      | Returns only runtime Supabase URL and publishable key; empty values reveal missing configuration             |
| `resolveMapEmbed`         | `src/fns/resolveMapEmbed.ts`      | GET    | Public | `url`: trimmed string, 1-2048 chars                                                                                                                                       | Converts Google Maps links to an embed URL; non-Google hosts must be rejected to prevent SSRF                |
| `submitLeasingInquiry`    | `src/fns/submitLeasingInquiry.ts` | POST   | Public | `name` 1-200; optional `company_name`, `business_activity`, `preferred_size`, `preferred_contact_method`, `message` <=2000, `source`; `phone` 8-24; `email`; `locale` `ar | en`; honeypot `website` must be empty                                                                        | Inserts `leasing_inquiries`; per-IP limit is 5 per hour; test validation, honeypot, rate limit, and success |
| `submitContactInquiry`    | `src/fns/submitContactInquiry.ts` | POST   | Public | `name` required; `email` valid; optional nullable `phone`, `subject`; `message` required                                                                                  | Inserts `contact_inquiries`; test required fields and a successful record                                    |

### Identity, users, and audit operations

| Function                | Source                             | Method | Auth         | Validated input                                                                                             | Expected behavior and tests                                                                                                   |
| ----------------------- | ---------------------------------- | ------ | ------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAppUser`         | `src/fns/createAppUser.ts`         | POST   | Auth + Admin | `kind` `managerial                                                                                          | tenant`; `username`3-64,`[A-Za-z0-9._-]`; `password`8-128;`displayName`1-120; valid`email`; optional managerial `role` `admin | accountant                   | collector                                                                                                               | readonly`; optional `tenantId` UUID | Tenant requires `tenantId`; managerial requires `role`; creates Auth user/profile/role and enables portal tenant; test rollback and forbidden caller |
| `updateAppUser`         | `src/fns/updateAppUser.ts`         | POST   | Auth + Admin | `userId` UUID; optional username rule above, display name 1-120, nullable valid email, password 8-128       | Updates Supabase Auth and profile; test partial update, invalid email, and forbidden caller                                   |
| `deleteAppUser`         | `src/fns/deleteAppUser.ts`         | POST   | Auth + Admin | `userId` UUID                                                                                               | Deletes another user and audit logs it; self deletion must fail                                                               |
| `sendTenantCredentials` | `src/fns/sendTenantCredentials.ts` | POST   | Auth + Admin | `tenantId` UUID; `username`, `password` non-empty; `channels` one or more `email                            | whatsapp`; optional locale `ar                                                                                                | en`                          | Queues credential notifications only where recipient contact data exists; test administrator-only access and queued IDs |
| `logAudit`              | `src/fns/audit.ts`                 | POST   | Auth         | `action` non-empty; optional nullable `entityType`, UUID `entityId`, JSON `before`/`after`, result `success | failure                                                                                                                       | error`, nullable `errorCode` | Writes a structured audit record; test JSON nesting and default `success`                                               |
| `eraseAllData`          | `src/fns/eraseAllData.ts`          | POST   | Auth + Admin | None                                                                                                        | Calls destructive database reset; do not run in automated tests unless the test DB is isolated and disposable                 |

### Invoice and payment operations

| Function                   | Source                                | Method | Auth                                              | Validated input                                                                                       | Expected behavior and tests                                                                                                                                                        |
| -------------------------- | ------------------------------------- | ------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generateInvoices`         | `src/fns/generateInvoices.ts`         | POST   | Auth + `invoices.create`                          | Optional nullable UUID `contractId`; optional nullable integer `throughYear`, 2000-2200               | Generates missing contract invoices; rerun is idempotent                                                                                                                           |
| `backfillContractInvoices` | `src/fns/backfillContractInvoices.ts` | POST   | Auth + `invoices.create`                          | `contractId` UUID                                                                                     | Backfills start month through current month without duplicates                                                                                                                     |
| `evaluateOverdue`          | `src/fns/evaluateOverdue.ts`          | POST   | Auth + `invoices.update`                          | Optional nullable `asOf` ISO date                                                                     | Transitions eligible invoices to overdue; test date boundary and idempotent retry                                                                                                  |
| `setInvoicePaid`           | `src/fns/setInvoicePaid.ts`           | POST   | Auth + `invoices.update`                          | `invoiceId` UUID; `paid` boolean                                                                      | Creates/removes only the auto-created invoice payment; manual/gateway payments remain intact                                                                                       |
| `applyAllocation`          | `src/fns/applyAllocation.ts`          | POST   | Auth + `payments.create`                          | `paymentId` UUID; `allocations`: non-empty array of `{ invoice_id: UUID, amount: positive number }`   | Allocates payment against invoices; test full, partial, invalid amount, and permission denial                                                                                      |
| `reversePayment`           | `src/fns/reversePayment.ts`           | POST   | Auth + `payments.reverse`                         | `paymentId` UUID; `reason` trimmed 1-500                                                              | Reverses payment via database RPC; reason is mandatory and audit trail should exist                                                                                                |
| `createPayment`            | `src/fns/createPayment.ts`            | POST   | Auth + tenant ownership or payment permission     | `invoiceIds`: 1-100 UUIDs                                                                             | Creates a MyFatoorah hosted payment request; invoices must belong to one tenant, be chronologically payable, and retain a positive balance; test 400/403/409 cases and gateway 502 |
| `confirmGatewayPayment`    | `src/fns/confirmGatewayPayment.ts`    | POST   | Auth + tenant ownership or `payment_links.create` | At least one: `paymentId` alphanumeric/hyphen 1-100, or `paymentRequestCode` matching `PREQ-<digits>` | Looks up and settles a MyFatoorah request; test missing reference 400, unknown request 404, pending, paid, and forbidden cross-tenant access                                       |
| `notifyPaymentSuccessFn`   | `src/fns/notifyPaymentSuccess.ts`     | POST   | Auth + `payments.create`                          | `paymentIds`: non-empty UUID array                                                                    | Queues/returns payment success notification outcomes; test a configured and an unavailable provider                                                                                |

### Deposits, electricity, import, and notification operations

| Function                     | Source                                  | Method | Auth                                          | Validated input                                                             | Expected behavior and tests                                                                                                             |
| ---------------------------- | --------------------------------------- | ------ | --------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `notifyDepositConfirmed`     | `src/fns/notifyDepositConfirmed.ts`     | POST   | Auth + `deposits.update` or `deposits.create` | `depositId` UUID                                                            | Notifies only confirmed deposits; repeated call must not duplicate the confirmation notification                                        |
| `generateElectricityCharges` | `src/fns/generateElectricityCharges.ts` | POST   | Auth + `electricity.create`                   | `periodMonth` 1-12; `periodYear` 2000-2200; optional nullable `unitId` UUID | Generates charges for all eligible units or one unit; test meter/reading prerequisites and duplicate protection                         |
| `bulkImport`                 | `src/fns/bulkImport.ts`                 | POST   | Auth + entity create permission               | `entity`: `expenses                                                         | deposits                                                                                                                                | tenants                       | properties                                                             | buildings                                                                                                       | units                                                                                                                         | maintenance`; `rows`: 1-1000 arbitrary records, then entity-specific validation | Resolves codes and imports valid rows; test unknown property/building/unit/category codes and partial error reporting |
| `sendNotification`           | `src/fns/sendNotification.ts`           | POST   | Auth + `notifications.send`                   | `tenantId` UUID; `channel` `email                                           | whatsapp                                                                                                                                | both`; `type` `manual_message | document_send`; optional body <=10000, documentPath <=1000, locale `ar | en`, ISO datetime `scheduledAt`, subject <=300, templateCode <=120, string variables; requires body or template | Queues and dispatches a manual/document message; test template/body requirement, tenant lookup, schedule, and provider errors |
| `dispatchNotification`       | `src/fns/dispatchNotification.ts`       | POST   | Auth + `notifications.send`                   | `notificationId` UUID                                                       | Sends queued notification through configured Resend/SMTP/WhatsApp/Twilio provider; test delivery state and retry-safe failure reporting |

### Report and scheduled-job operations

| Function                | Source                             | Method | Auth                          | Validated input                                      | Expected behavior and tests                                                                                   |
| ----------------------- | ---------------------------------- | ------ | ----------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `contractExpiryJob`     | `src/fns/contractExpiryJob.ts`     | POST   | Auth + `notifications.create` | Optional nullable `asOf` ISO date                    | Finds upcoming expiries and queues milestone notifications; test one delivery per milestone/channel/recipient |
| `scheduledReportsJob`   | `src/fns/scheduledReportsJob.ts`   | POST   | Auth + `reports.read`         | Optional nullable `asOf` ISO date                    | Runs due active schedules and records per-schedule outcome                                                    |
| `runReportSchedule`     | `src/fns/runReportSchedule.ts`     | POST   | Auth + `reports.read`         | `scheduleId` UUID; optional nullable `asOf` ISO date | Generates a selected report, sends it, and advances `next_run_at` based on frequency                          |
| `resendGeneratedReport` | `src/fns/resendGeneratedReport.ts` | POST   | Auth + `reports.read`         | `reportId` UUID                                      | Requires a generated report with schedule and HTML artifact; queues a new email and updates send state        |

## 6. Direct Supabase CRUD surface by module

These are browser-side Supabase client operations wrapped in hooks. TestSprite
should drive the page actions and assert visible results, navigation, and RLS
failures rather than calling the database directly with a service key.

| Module               | Main hooks                                                                                                          | Tables/storage to exercise                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Company/settings     | `useCompany`, `useOptionLists`, `useCustomRoles`, `useUsers`, `useProviderConfigs`, `useNotificationTemplates`      | `companies`, option lists, roles/permissions, profiles, providers, templates                                                           |
| Landing CMS          | `useLandingSettings`, `useLinkedBrand`, `useMapEmbed`                                                               | `landing_page_settings`, `landing_page_sections`, `landing_media`, `commercial_brands`, `landing_carousel_slides`, `leasing_inquiries` |
| Properties/units     | `useProperties`, `useBuildings`, `useUnits`                                                                         | `properties`, `buildings`, `building_categories`, `units`                                                                              |
| Tenants/contracts    | `useTenants`, `useContracts`, `useTenantMessages`                                                                   | `tenants`, documents storage, `contracts`, `concessions`, messages                                                                     |
| Invoices/payments    | `useInvoices`, `usePayments`, `usePaymentAllocations`, `useCreatePayment`, `useConfirmPayment`, `useReversePayment` | `invoices`, invoice lines, `payments`, allocations, receipts, payment requests                                                         |
| Deposits/expenses    | `useDeposits`, `useExpenses`, `useBudget`                                                                           | `deposits`, `deposit-attachments`, `expense_categories`, `expenses`, `expense-attachments`, budget data                                |
| Electricity          | `useElectricityTariffs`, `useElectricityMeters`, `useMeterReadings`, `useElectricityCharges`                        | tariffs, meters, readings, charges                                                                                                     |
| Operations/reporting | `useMaintenance`, `useAuditLogs`, `useReportPreview`, `useReportSchedules`, `useGeneratedReports`                   | maintenance, audit logs, report schedules, generated reports                                                                           |
| Tenant portal        | `usePortalData`, `usePortalInvoices`, `useReceipts`                                                                 | tenant profile, active contracts, visible invoices/receipts, confirmed/reversed payments                                               |

## 7. Authorization and RLS test matrix

| Scenario                                                                 | Expected result                                                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Unauthenticated user opens `/admin/...`                                  | Redirect to `/auth`                                                                                              |
| Unauthenticated user opens `/portal/...`                                 | Redirect to `/portal/auth`                                                                                       |
| Tenant submits valid credentials at `/auth`                              | Session is signed out and an "not staff" error appears                                                           |
| Staff submits valid credentials at `/portal/auth`                        | Session is signed out and an "not tenant" error appears                                                          |
| Tenant accesses another tenant by changing URL/search parameters         | RLS blocks other tenant data; `?tenant=` is ignored for non-staff users                                          |
| Staff opens `/portal?tenant=<tenant UUID>`                               | Staff preview can load the selected tenant portal without changing their role                                    |
| Readonly or restricted role uses a write button                          | UI should hide/disable it where implemented, and server/database permission check must reject it even if invoked |
| Protected server function called without a `requireSupabaseAuth` session | Must fail before accessing protected data                                                                        |
| Admin deletes own user                                                   | Server function rejects the request                                                                              |

## 8. Required environment configuration for testing

Copy `.env.example` to `.env`. Never use production service-role or provider
secrets in automated tests.

| Group           | Variables                                                                | Testing impact                                                                                                |
| --------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Client Supabase | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`                     | Required for browser auth and all direct Supabase reads/writes                                                |
| Server Supabase | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`  | Required for server functions, public branding, user management, cron, webhook, and provider work             |
| Payment         | `MYFATOORAH_API_KEY`, `MYFATOORAH_BASE_URL`, `MYFATOORAH_WEBHOOK_SECRET` | Required for hosted payment creation, callback confirmation, and signed webhook tests; use MyFatoorah sandbox |
| Email           | SMTP variables or `RESEND_API_KEY`, `RESEND_FROM`                        | Required for real email dispatch; otherwise verify graceful provider failure                                  |
| WhatsApp        | Cloud API variables or Twilio variables                                  | Required for real WhatsApp dispatch; otherwise verify graceful provider failure                               |
| Cron            | `CRON_SECRET`                                                            | Required for direct cron endpoint tests; missing value intentionally returns `503`                            |
| App URL         | `PUBLIC_APP_URL`, `APP_BASE_URL`                                         | Required for absolute portal links and payment callbacks                                                      |

## 9. TestSprite workflow

### Preparation

1. Use a dedicated test Supabase project/database. The test suite creates and
   mutates properties, users, payments, invoices, notifications, storage files,
   and reports.
2. Start the app with `bun run dev`; Vite should serve `http://localhost:5173`.
3. Keep real local credentials out of Git. Store them in
   `.testsprite/test-credentials.local.md`, which is ignored by `.gitignore`.
   The committed docs must use `TEST_ADMIN_EMAIL` and `TEST_ADMIN_PASSWORD`
   placeholders only.
4. Create a dedicated tenant portal test user before tenant-only flows. Do not
   reuse a production tenant.
5. Configure sandbox or stubbed MyFatoorah and notification credentials for
   payment/notification journeys; otherwise mark those cases as environment-blocked.

### First-time TestSprite setup

No `.testsprite/config.json` existed when this guide was written. Initialize
TestSprite once against the running app:

```text
projectPath: F:\Danat-Mostakbal
localPort: 5173
type: frontend
testScope: codebase
```

Then generate separate plans:

1. Frontend plan with login enabled for staff and tenant route coverage.
2. Backend plan for the two public HTTP endpoints plus existing Vitest tests of
   server-function modules.
3. Execute only after reviewing generated cases. Dev-server frontend runs are
   intentionally limited to high-priority cases; use a production-like local
   server for broader execution.

### TestSprite authentication configuration

Do not configure the project-wide TestSprite Credential / Key field as Basic
Authentication for this app. The application does not accept an admin or tenant
email/password encoded as `email:password` in the `Authorization` header.

| Target                                | TestSprite authentication setting                                                   | Required value                                                                                      | Reason                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser routes and frontend journeys  | `None / No Authentication`                                                          | Sign in through `/auth` or `/portal/auth` form fields                                               | The browser establishes a Supabase session. Basic Authentication is not read by the app.                                                    |
| `POST /api/public/cron`               | `Bearer Token` if TestSprite supports it, otherwise a custom `Authorization` header | `Bearer <CRON_SECRET>`                                                                              | `readCronSecretHeader` accepts only a non-empty Bearer token that matches `CRON_SECRET`. It does not accept Basic credentials.              |
| `POST /api/public/myfatoorah-webhook` | `None / No Authentication` plus custom signature header                             | Valid HMAC in `MyFatoorah-Signature` or an accepted alternative signature header                    | The endpoint verifies a raw-body signature with `MYFATOORAH_WEBHOOK_SECRET`; it does not authenticate an admin/tenant account.              |
| TanStack Start server functions       | Do not target as direct REST tests                                                  | A valid Supabase access JWT in `Authorization: Bearer <access token>` when invoked programmatically | `requireSupabaseAuth` validates a Supabase JWT, not Basic Authentication. Drive these operations through their UI workflow or Vitest tests. |

The Base64 value for an `email:password` pair is valid Basic Authentication
syntax, but it is not a valid credential for any endpoint in this application.
Using it against the cron route, webhook, or server functions will produce an
authorization failure rather than authenticate the user.

### Recommended frontend suites

| Suite          | Journeys                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Authentication | Staff login/logout, tenant rejection at staff auth, tenant login, staff rejection at portal auth, protected-route redirects |
| Admin setup    | Company settings, lists, user/roles, notification settings, landing CMS                                                     |
| Core tenancy   | Property -> unit -> tenant -> active contract dependency path                                                               |
| Money path     | Generate invoices -> manual payment -> allocation -> invoice state -> reversal -> audit entry                               |
| Operations     | Deposit, expense, electricity, inbox, report, maintenance empty-state and CRUD paths                                        |
| Tenant portal  | Lease, invoice visibility, payment history, receipts, profile, staff preview, disabled portal                               |
| Public landing | Localization, responsive navigation, CMS content, leasing inquiry client validation/submission                              |

### Recommended backend suites

| Priority    | Coverage                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| High        | Cron authentication/validation/idempotency; MyFatoorah signature/replay/settlement; invoice generation; payment allocation/reversal; gateway confirmation authorization |
| Medium      | User provisioning/self-delete protection; public leasing rate limit; report schedule generation; deposit and payment notification idempotency                           |
| Medium      | Map host allowlist; bulk import relation resolution; electricity charge validation                                                                                      |
| Destructive | `eraseAllData` only against a disposable isolated database and never in a shared test run                                                                               |

## 10. Test data and dependency order

Follow the existing [E2E admin journeys](E2E_ADMIN_TEST_JOURNEYS.md) in this
order. Reusing its data avoids false failures caused by missing prerequisites.

```text
Bootstrap admin
  -> company/settings/lists/users
  -> property -> unit
  -> tenant -> tenant portal user
  -> active contract
  -> invoices
  -> payment/allocation/reversal
  -> deposits, expenses, electricity, reports, audit, portal smoke
```

Suggested non-production data:

| Entity         | Suggested value                                                           |
| -------------- | ------------------------------------------------------------------------- |
| Property       | `Danat Test Complex` / `مجمع اختبار دانة`                                 |
| Units          | `A-101`, `A-102`; available; rent `250` KWD                               |
| Tenant         | `Test Tenant One`; `tenant1@example.com`; mobile `+96550000001`           |
| Contract       | Active lease; 12 months; monthly amount `250`; due day `1`; deposit `250` |
| Invoice        | Generate for the contract current period; rerun to verify idempotency     |
| Manual payment | Full or partial amount matching the generated invoice                     |
| Electricity    | One tariff, one meter, two ascending readings, one generated charge       |

## 11. Known environment-dependent behaviors

| Item                                    | Expected handling during tests                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Missing MyFatoorah/SMTP/WhatsApp secret | Mark payment or send action as environment-blocked only if the UI/server reports a clear configuration error |
| Missing `CRON_SECRET`                   | `POST /api/public/cron` returns `503`; this is correct behavior                                              |
| Landing contact UI                      | May be intentionally disabled; distinguish product configuration from a defect                               |
| Maintenance module                      | Exists as `/admin/maintenance` but is hidden from the sidebar                                                |
| Dana-bot/native apps/Lovable Cloud      | Explicitly out of current scope                                                                              |

## 12. Completion checklist

- [ ] App starts at `http://localhost:5173` using test-only environment variables.
- [ ] This file is available while reviewing the generated TestSprite plans; attach it as context if the TestSprite workflow supports attachments.
- [ ] Admin and tenant credentials are local and ignored by Git.
- [ ] Frontend plan covers every route group in Section 3.
- [ ] Backend plan covers both public endpoints in Section 4.
- [ ] Server-function behavior is exercised through UI tests or Vitest, not guessed REST URLs.
- [ ] Money-path tests verify idempotency and audit logs.
- [ ] Webhook/cron/destructive tests use an isolated database.
