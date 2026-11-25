# Data Model: IJARY Multi-Company SaaS Conversion

**Feature**: [spec.md](./spec.md) | **Research**: [research.md](./research.md) | **Date**: 2026-11-26

Conventions: all keys are `uuid`; money is `numeric(14,3)`; timestamps are `timestamptz`. "Company-scoped" means: `company_id uuid not null default public.current_company_id() references companies(id)`, RLS enabled and forced, and every policy compares `company_id` with `(select public.current_company_id())`.

## 1. Rule for the 76 existing tables

| Group | Tables | Change |
|---|---|---|
| Global catalogue | `permissions` | Stays global, read-only to companies. |
| The company itself | `companies` | Gains columns (section 2). A member reads only its own row. |
| Already has `company_id` (about 20) | `profiles`, `properties`, `tenants`, `invoices`, `payments`, `deposits`, `expenses`, `employees`, `refunds`, `partial_payments`, `insurance_payments`, `contract_closeouts`, `maintenance_requests`, `leasing_inquiries`, `landing_page_settings`, `landing_page_sections`, `landing_carousel_slides`, `card_visibility`, `gmail_connections`, `gmail_messages` | Column becomes `not null` with the default; `on delete set null` is removed; policies rewritten. |
| Lacks `company_id` (about 55) | Every other table, including `buildings`, `units`, `contracts`, `contract_units`, `invoice_items`, `payment_allocations`, `receipts`, `payment_requests`, `webhook_events`, `notifications`, `notification_templates`, `audit_logs`, `user_roles`, `role_permissions`, `custom_roles` and its two link tables, `user_tenants`, `option_lists`, `option_list_items`, `invoice_years`, `cron_jobs`, `report_schedules`, `generated_reports`, `backups`, `electricity_*`, `meter_readings`, `whatsapp_*`, `tenant_messages`, `tenant_documents`, `contact_inquiries`, `landing_media`, `email_signatures`, `email_webhook_events`, `failed_login_attempts`, `salaries`, `employee_documents`, `concessions`, `concession_invoices`, `commercial_brands`, `commercial_brand_contracts`, `contract_*`, `building_categories`, `expense_categories` | Column added with backfill, then `not null`; policies rewritten. |

**Integrity rules applied to every company-scoped table**

- A unique index on `(company_id, id)`, and child foreign keys declared as `(company_id, <parent>_id) references parent(company_id, id)`, so a row cannot point at another company's row (FR-005).
- Business-level uniques become per company (FR-006): `profiles (company_id, username)`, `(company_id, lower(email))`, `(company_id, phone_last8)`; every `code` column; `notification_templates (company_id, code)`; `cron_jobs (company_id, key)`; `option_lists (company_id, key)`; `invoice_years (company_id, year)`; `role_permissions (company_id, role, permission_code)`; `landing_page_settings (company_id, locale)`.
- Every index used by a list query is rebuilt with `company_id` as its first column.

**Singletons that become one row per company**

| Today | Becomes |
|---|---|
| `evolution_connections` (`id = 1`) | Replaced by `whatsapp_connections` (section 5). |
| `provider_configs` (`provider` unique) | `unique (company_id, provider)`; secret values move to `company_secrets`. |
| `gmail_connections` (`company_id` unique) | Unchanged shape, now enforced by RLS. |
| "Oldest row of `companies`" (17 SQL sites, 15 code sites) | Replaced by `current_company_id()` in SQL and the request's company in code. A structure test fails any remaining `from companies … limit 1`. |

## 2. Company and platform

### `companies` (extended)

| Field | Type | Rule |
|---|---|---|
| `slug` | text | Unique; `^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$`; not in `reserved_slugs`; immutable after insert (trigger). |
| `status` | text | `active` or `suspended`. Default `active`. |
| `suspended_at`, `suspended_reason`, `suspended_by` | | Set together when status becomes `suspended`; cleared on reactivation. |
| `currency` | text | Default `KWD`; check `= 'KWD'` in this feature. |
| `timezone` | text | Default `Asia/Kuwait`; check `= 'Asia/Kuwait'` in this feature. |
| `phone_country_code` | text | Default `965`. |
| existing columns | | Names, branding, bank details, portal flags: unchanged. |

State: `active → suspended → active`. No delete.

### `company_domains`

`id`, `company_id`, `host` (unique, lower-case), `kind` (`subdomain` or `custom`), `is_primary`, `verification_status` (`verified`, `pending`, `failed`), `provider_ref`. The subdomain row is created with the company and is always `verified`. Custom rows arrive only in the last phase.

### `reserved_slugs`

`slug` primary key. Seeded with `admin`, `www`, `api`, `app`, `supabase`, `mail`, `static`, `cdn`, `status`, `support`, `evolution`.

### `company_modules`

`company_id`, `module_key`, `enabled`, `updated_by`, `updated_at`; primary key `(company_id, module_key)`. `module_key` is one of: `invoices`, `tenants`, `properties`, `units`, `contracts`, `payments`, `deposits`, `expenses`, `electricity`, `maintenance`, `employees`, `inbox`, `reports`, `audit`, `online_payments`, `whatsapp`, `landing_page`. Seeded on company creation: all `true` except `landing_page` and `maintenance`. A missing row is treated as `false`.

### `company_subscriptions`

`id`, `company_id`, `plan_name`, `price numeric(14,3)`, `period_start date`, `renewal_date date`, `status` (`trial`, `active`, `overdue`, `cancelled`), `note`, `recorded_by`, `created_at`. Append-only: a renewal is a new row. The current subscription is the row with the latest `period_start`. `overdue` is derived when `renewal_date < today` and no later row exists; it never changes `companies.status`.

### `company_limits`

`company_id` primary key, `max_units int`, `max_staff_users int`, `max_whatsapp_per_month int`, `max_storage_bytes bigint`. `null` means unlimited. Values `>= 0`.

### `company_usage_monthly`

`company_id`, `month date` (first day, company time), `whatsapp_sent int`; primary key `(company_id, month)`.

### `company_storage_usage`

`company_id` primary key, `bytes bigint`, `updated_at`. Maintained by the storage trigger; rebuilt nightly from `storage.objects` as a correction.

### `company_counters`

`company_id`, `kind` (`invoice`, `payment`, `receipt`, `contract`, `refund`, `property`, `building`, `unit`, `tenant`, `payment_request`, `expense`, `deposit`, `electricity_charge`), `last_value bigint`; primary key `(company_id, kind)`.

### `platform_admins`

`user_id` primary key references `auth.users`, `full_name`, `is_active`, `created_at`. No `profiles` row exists for these users.

### `platform_audit_log`

`id`, `actor_id`, `company_id` (nullable), `action`, `entity`, `entity_id`, `before jsonb`, `after jsonb`, `ip`, `request_id`, `created_at`. Insert-only; no update or delete grants. Secret fields are stripped before write.

### `impersonation_sessions`

`id`, `platform_admin_id`, `company_id`, `target_user_id`, `reason` (not empty), `started_at`, `expires_at` (`started_at + 60 min`), `ended_at`. Open means `ended_at is null and expires_at > now()`.

## 3. Secrets and payment gateways

### `company_secrets`

`id`, `company_id`, `owner_kind` (`gateway`, `whatsapp`, `email`, `gmail`), `owner_id`, `name`, `ciphertext bytea`, `iv bytea`, `auth_tag bytea`, `key_version int`, `last4 text`, `version int`, `updated_at`; unique `(owner_kind, owner_id, name, version)`. No grant to `authenticated`.

### `gateway_connections`

| Field | Rule |
|---|---|
| `company_id`, `provider` | `provider` in `myfatoorah`, `tap`, `upayments`; unique `(company_id, provider)`. |
| `mode` | `test` or `live`. |
| `public_config jsonb` | Non-secret settings, such as enabled methods. |
| `is_active` | Partial unique index `(company_id) where is_active` (FR-056). |
| `last_test_at`, `last_test_ok`, `last_test_message` | Activation requires `last_test_ok` after the latest credential change (FR-055). |
| `credentials_version` | Incremented on each credential save. |

`live` mode additionally requires the provider's launch checklist flag set by the super admin (SC-012).

### `payment_requests` (extended)

Adds `gateway_connection_id` and `credentials_version`. Settlement always uses these, never the currently active connection.

### `webhook_events` (extended)

Adds `company_id`, `connection_id`, `provider`, `signature_valid`. Unique `(provider, connection_id, provider_event_id)` for replay protection.

## 4. Background work

### `job_requests` (outbox)

| Field | Rule |
|---|---|
| `id` | Also the BullMQ `jobId`. |
| `company_id` | Company-scoped. |
| `kind` | A key of the job catalogue ([contracts/jobs.md](./contracts/jobs.md)). |
| `payload jsonb` | Validated against the catalogue schema on insert in code, and by a size check in SQL. No secrets. |
| `dedupe_key` | Unique `(company_id, kind, dedupe_key)` where not null. |
| `requested_by` | User id, or null for system. |
| `status` | `pending → published → running → succeeded` or `failed`; `skipped` when the company is suspended or the section is off. |
| `attempts`, `last_error`, `result jsonb`, `created_at`, `published_at`, `finished_at` | |

Index `(status, created_at) where status = 'pending'` for the relay.

### `user_notices`

`id`, `company_id`, `user_id`, `job_request_id`, `kind`, `title_key`, `body jsonb`, `level` (`success`, `error`), `read_at`, `created_at`. A user reads and marks only their own.

### `notifications` (extended)

Adds `company_id` and `skip_reason` (including `limit_reached`, `module_disabled`, `company_suspended`).

## 5. WhatsApp and email

### `whatsapp_connections`

| Field | Rule |
|---|---|
| `company_id`, `method` | `method` in `evolution_qr`, `cloud_api`, `cloud_coexistence`; unique `(company_id, method)`. |
| `is_active` | Partial unique index `(company_id) where is_active` (FR-063). |
| `status` | `disconnected`, `pairing`, `connected`, `error`. |
| `connected_number` | Normalised E.164; partial unique index where not null (one number, one company). |
| `instance_name` | For QR: derived from the company id. |
| `phone_number_id`, `waba_id` | For the official API; `phone_number_id` unique, used for webhook routing. |
| `last_qr`, `last_seen_at`, `last_error` | |

Secrets (instance webhook secret, current and previous; business token) are in `company_secrets`.

`whatsapp_chats`, `whatsapp_contacts`, `whatsapp_messages`, `whatsapp_contact_contracts` gain `company_id` and `connection_id`.

### Email sender

`provider_configs` rows for `smtp` and `resend` per company, credentials in `company_secrets`. No enabled row means the platform default sender applies; the display name and reply-to come from `companies`.

## 6. Roles and context functions

| Object | Contract |
|---|---|
| Role `company_service` | No `BYPASSRLS`; granted to `authenticator`; same table grants as `authenticated` plus `company_secrets` select. |
| `current_company_id()` | Stable, `security definer`, search path pinned. Resolution in [research.md](./research.md) R1. Returns `null` when unknown or suspended. |
| `is_platform_admin()` | True only with a `platform_admins` row, `is_active`, and `aal2`. |
| `has_permission(user, code)` | False when the code's section is off for the company, for every role including `admin`; otherwise as today. |
| `is_staff`, `has_role` | Additionally require the caller's profile to be in `current_company_id()`. |
| `module_enabled(key)` | Reads `company_modules` for the current company. |
| `next_*_code()` | Same names and return types; read `company_counters`. |
| `write_audit` | Adds `company_id`, and `impersonator` from the JWT claim when present. |

## 7. Storage

Path contract for all buckets: `companies/<company_id>/<area>/…`. Policies are in [research.md](./research.md) R12. `company_storage_usage` tracks bytes per company.

## 8. Validation mapped to requirements

| Rule | Where enforced | Requirement |
|---|---|---|
| Row visible only to its company | RLS on every table | FR-001, FR-002, FR-003 |
| No cross-company links | Composite foreign keys | FR-005 |
| Per-company uniques and numbering | Unique indexes, `company_counters` | FR-006, FR-007 |
| One active gateway, one active WhatsApp method | Partial unique indexes | FR-056, FR-063 |
| Activation needs a passing test | Check trigger on `gateway_connections` | FR-055 |
| Limits on every route | Insert triggers, storage policy, usage counter | FR-047 to FR-049 |
| Section off means refused | `has_permission`, `module_enabled` in policies | FR-038 |
| Suspended means no access | `current_company_id()` returns `null` | FR-045 |
| Support session ends at 60 minutes | `current_company_id()` checks the session | FR-071 |
| No company deletion | No delete grant on `companies` | FR-036 |
