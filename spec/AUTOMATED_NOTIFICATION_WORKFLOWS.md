# Spec — Automated Notification Workflows, Notification Log & Providers

**Status:** Implemented in code (2026-07-20); production ops pending  
**Owner:** Engineering  
**Source request:** Product owner — time-based and action-based notification loops, admin reports, Twilio, mutual-exclusive providers.  
**Related code:** `src/fns/{cronJobs,contractExpiryJob,overdueRemindersJob,dispatchNotification,enqueueNotification,notify*}.ts`, `db/migrations/31_notification_workflows.sql`, `db/migrations/32_notification_workflow_seeds.sql`, `db/migrations/33_contract_expiry_retry_failed.sql`, `src/routes/admin.settings.notifications.tsx`, `src/lib/emailTemplates.ts`, `src/lib/providers/*`

---

## 1. Problem statements

The Estate Rental Management Platform needs reliable, auditable outbound communications:

1. **Time-based loops** (cron) for admin reports, contract-expiry milestones, invoice overdue state, and overdue payment reminders.
2. **Action-based loops** when deposits are confirmed, tenants pay, or users are created.
3. A permanent **Notification Log** (audit of every outbound message) with filters.
4. Branded **HTML email templates** and WhatsApp delivery via one email + one WhatsApp provider at a time.
5. **Twilio** as an alternate WhatsApp provider next to Meta WhatsApp Cloud API, with mutual exclusivity.

---

## 2. Confirmed decisions

| Decision                     | Choice                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transport bus                | `notifications` table + `dispatchNotificationRecord` (not ad-hoc SDK calls from UI)                                                                                                                          |
| Cron entry                   | `POST /api/public/cron` + `CRON_SECRET` Bearer (not `pg_cron` for send paths)                                                                                                                                |
| Admin recipients             | `companies.email` ∪ active admin profile emails (`getAdminNotificationEmails`)                                                                                                                               |
| Overdue reminders cadence    | One email + one WhatsApp per tenant per **calendar month** while arrears remain                                                                                                                              |
| Contract milestones          | 4 months, 3 months, 2 months, 1 month, **7 days** before `end_date`                                                                                                                                          |
| In-app “pool” for staff      | Notification Log with `audience=admin` (no separate staff inbox table in MVP)                                                                                                                                |
| Payment notify scope         | Gateway settlement **and** admin-created confirmed payments                                                                                                                                                  |
| Credentials on create        | Managerial: email to user + admin (no WA). Tenant: email (admin in recipients) + WA                                                                                                                          |
| Provider exclusivity         | Email: Resend XOR SMTP. WhatsApp: Cloud API XOR Twilio (DB trigger)                                                                                                                                          |
| HTML source of truth         | `src/lib/emailTemplates.ts` for branded email; DB templates for codes / short text / Meta names                                                                                                              |
| Reminder switch              | `tenants.reminders_enabled` gates **proactive** WhatsApp only (`due_reminder`, `overdue_reminder`, `contract_expiry`). Credentials and payment receipts **always** attempt send when channel/recipient allow |
| Invoice PDF on payment email | Out of first cut; HTML body + multi-month text is required; PDF attachment is a follow-up                                                                                                                    |

---

## 3. Architecture

```
Trigger (cron | webhook | admin action | user create)
        │
        ▼
  enqueueNotification()  →  notifications row
        │                     audience, recipient_address, channel, type, body/subject, payload
        ▼
  dispatchNotificationRecord(id)
        │
        ├── email  → Resend OR SMTP (attachments optional)
        └── whatsapp → Cloud API (approved template) OR Twilio (body text)
        │
        ▼
  state: sent | failed | skipped | cancelled
  + write_audit(notification.dispatch)
```

### Cron jobs

| `job`               | Cadence                         | Behavior                                                  |
| ------------------- | ------------------------------- | --------------------------------------------------------- |
| `overdue`           | daily                           | Flip due invoices → `overdue` via `evaluate_overdue`      |
| `overdue-reminders` | daily cron (idempotent monthly) | Email + WA overdue reminder once per tenant per `YYYY-MM` |
| `contract-expiry`   | daily                           | Milestones 4m/3m/2m/1m/7d; tenant email+WA; admin email   |
| `scheduled-reports` | daily (runs due schedules)      | Weekly/monthly HTML report email to schedule recipients   |

Copy-paste crontab: `deploy/README.md`.

### Key files

| Concern                | Path                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Cron router            | `src/fns/cronJobs.ts`, `src/routes/api/public/cron.ts`                                      |
| Enqueue + admin emails | `src/fns/enqueueNotification.ts`                                                            |
| Dispatch               | `src/fns/dispatchNotification.ts`                                                           |
| Contract expiry        | `src/fns/contractExpiryJob.ts`, SQL `identify_contract_expiry_reminders`                    |
| Overdue reminders      | `src/fns/overdueRemindersJob.ts`                                                            |
| Reports                | `src/fns/scheduledReportsJob.ts`, `runReportSchedule.ts`, SQL `build_scheduled_report_html` |
| Deposit notify         | `src/fns/notifyDepositConfirmed.ts` ← `useDeposits`                                         |
| Payment notify         | `src/fns/notifyPaymentSuccess.ts` ← webhook + `usePayments`                                 |
| Credentials            | `src/fns/notifyUserCredentials.ts` ← `createAppUser`; manual `sendTenantCredentials`        |
| HTML templates         | `src/lib/emailTemplates.ts`                                                                 |
| Providers              | `src/lib/providers/{resend,smtp,whatsapp,twilio}.ts`                                        |
| Schema                 | `db/migrations/07_phase5_*.sql`, `31`–`33` notification workflow migrations                 |
| Admin UI               | `src/routes/admin.settings.notifications.tsx`                                               |
| Product/eng spec       | `spec/AUTOMATED_NOTIFICATION_WORKFLOWS.md`                                                  |

---

## 4. Time-based workflows (requirements)

### 4.1 Weekly admin report

- **Recipient:** Admin emails from `report_schedules.recipients` (seed: `weekly-admin-report`, inactive until filled).
- **Format:** HTML email (`generated_reports.html_content`).
- **Content:** Successful payments (list + totals), delayed/overdue cases, bank deposits in period, budget-style KPIs when available.
- **Schedule:** `frequency = weekly`; advanced by `next_run_at` after run.

### 4.2 Monthly admin report

- Same pipeline with `frequency = monthly` (`monthly-admin-report`).
- **Content:** Payments vs delayed; total collected; total expenses; net (collected − expenses); outstanding arrears; deposits.

### 4.3 Daily contract expiration checker

- Dedup (migrations 33 and 34): only `sent` / `queued` count as handled; failed and skipped deliveries retry independently by recipient and channel.

- Cron `contract-expiry`.
- SQL `identify_contract_expiry_reminders` returns candidates for milestones **4m, 3m, 2m, 1m, 7d** with dedupe on `payload.milestone` (and legacy `months_until`).
- **Tenant:** email (branded HTML) + WhatsApp when number + reminders allow.
- **Admin:** email only (`audience=admin`).
- **Log:** one notification row per channel/audience.

### 4.4 Overdue state + monthly overdue reminder

- Cron `overdue`: state transition only.
- Cron `overdue-reminders`: for each tenant with open overdue balance; email always when address present; WhatsApp when number present and (for proactive types) reminders enabled; idempotent per `payload.month_key = YYYY-MM`.
- **UI:** flashing/pulse badges on overdue invoices and tenants with `hasOverdue`.

### 4.5 Notification Log

- UI: Admin → Settings → Notifications (log title).
- Permanent rows in `notifications`.
- **Filters:** type, channel, state, date range, tenant search, **audience** (admin/tenant), **to** (`recipient_address`), **from** (`sender_address`).
- Retry failed/skipped; cancel queued; CSV export.

---

## 5. Action-based workflows (requirements)

### 5.1 Deposit confirmed

- Trigger: deposit create with `status=confirmed`, or update pending → confirmed.
- Admin HTML email (amount, bank, date, code, note) + attachment if `attachment_path` set.
- Type: `deposit_confirmation`; audience: `admin`.
- Idempotent on `payload.deposit_id`.

### 5.2 Tenant payment success

- Triggers:
  - MyFatoorah settlement (`myfatoorahWebhook` → one payment per invoice month).
  - Admin manual confirmed payment create.
- **Admin:** email alert with tenant, amount, periods, payment codes (`payment_admin_alert`).
- **Tenant:** email receipt (`receipt`); WhatsApp text listing paid months.
- **Ledger:** gateway already creates separate payment rows per month (do not double-insert).
- **Portal:** existing receipts list (per payment); multi-month payment shows multiple receipts.
- **Log:** separate rows per channel/audience.
- Idempotent: any non-cancelled notification whose payload includes the same `payment_ids` set (any type).

### 5.3 User creation credentials

| Site                       | Email                        | WhatsApp                        |
| -------------------------- | ---------------------------- | ------------------------------- |
| Managerial (admin console) | User + admin copy            | No                              |
| Tenant portal              | User (+ admin in recipients) | Yes (portal link + credentials) |

- Type: `user_credentials`.
- Best-effort: create user must not fail if notify fails.
- Manual resend remains via `sendTenantCredentials`.

---

## 6. Templates

### 6.1 DB seeds (`notification_templates`)

| Code prefix              | Type                   |
| ------------------------ | ---------------------- |
| `due-reminder-*`         | `due_reminder`         |
| `overdue-reminder-*`     | `overdue_reminder`     |
| `receipt-*`              | `receipt`              |
| `contract-expiry-*`      | `contract_expiry`      |
| `deposit-confirmation-*` | `deposit_confirmation` |
| `user-credentials-*`     | `user_credentials`     |
| `payment-admin-alert-*`  | `payment_admin_alert`  |

### 6.2 TypeScript HTML (`emailTemplates.ts`)

`tenant_credentials`, `welcome_managerial`, `invoice_issued`, `payment_receipt`, `overdue_reminder`, `contract_expiry`, `deposit_confirmation`, `payment_admin_alert`.

WhatsApp Cloud API requires **pre-approved Meta template names** matching `template_code` (hyphens → underscores). Twilio sends free-form `body`.

---

## 7. Providers

| Provider           | Role                                     |
| ------------------ | ---------------------------------------- |
| SMTP               | Email (nodemailer; secrets via env refs) |
| Resend             | Email                                    |
| WhatsApp Cloud API | WhatsApp templates                       |
| Twilio             | WhatsApp body messages                   |

**Rules:**

- Enabling Resend disables SMTP and vice versa.
- Enabling Cloud API disables Twilio and vice versa.
- Secrets only as `*_env` references in `provider_configs.config` (no raw secrets in DB).
- Env vars: see `.env.example` (`SMTP_*`, `RESEND_*`, `WHATSAPP_*`, `TWILIO_*`, `PUBLIC_APP_URL`, `CRON_SECRET`).

---

## 8. Data model (migrations 31–32)

- Enum `notification_providers`: + `twilio`
- Enum `notification_types`: + `deposit_confirmation`, `user_credentials`, `payment_admin_alert`
- Enum `notification_audience`: `tenant | admin | both | system`
- Columns on `notifications`: `audience`, `recipient_address`, `sender_address`
- Trigger `tg_provider_mutual_exclusivity`
- RPC `identify_contract_expiry_reminders` returns `months_until`, `days_until`, `milestone`
- `build_scheduled_report_html` includes expenses, net, detail tables
- Seed schedules: `weekly-admin-report`, `monthly-admin-report` (inactive)

**Migration split (Postgres):**

1. **`31_notification_workflows.sql`** — `ALTER TYPE ... ADD VALUE`, columns, trigger, RPC/function replacements only (no inserts that use new enum values).
2. **`32_notification_workflow_seeds.sql`** — provider seed, report schedules, notification_templates using the new types.

`ALTER TYPE ... ADD VALUE` must be committed before inserts that use the new values. Recreating `identify_contract_expiry_reminders` requires `DROP FUNCTION ... (date)` first because the OUT/return row type changed.

---

## 9. Acceptance criteria

- [ ] Weekly/monthly report emails send when schedule active + recipients set + email provider enabled.
- [ ] Contract expiry fires at 4m, 3m, 2m, 1m, 7d; tenant email+WA; admin email; log rows.
- [ ] Deposit confirm → admin HTML email (+ attachment when present) + log.
- [ ] Payment confirm → admin email + tenant email + tenant WA (when possible) + log; multi-month listed.
- [ ] Overdue tenants get at most one reminder set per calendar month; overdue badges pulse.
- [ ] User create sends credentials per matrix above + log.
- [ ] Log filters: audience, channel, to, from, type, state, dates.
- [ ] Exactly one email provider and one WhatsApp provider can be enabled.
- [ ] Cron smoke-tested with real `CRON_SECRET` for all four jobs.
- [ ] Migrations 31–32 applied; types aligned; nodemailer in lockfile.

---

## 10. Known gaps / follow-ups

| Item                                      | Severity          | Notes                                                    |
| ----------------------------------------- | ----------------- | -------------------------------------------------------- |
| Invoice PDF attachment on payment email   | Low               | Follow-up                                                |
| Cloud API template components (variables) | Medium            | Meta approval + code                                     |
| `setInvoicePaid` does not notify          | By design for now | Manual toggle ≠ payment flow                             |
| Host cron + secrets                       | Ops               | `TODO.md` / Dokploy                                      |
| bun.lock may need refresh                 | Medium            | Run `bun add nodemailer` if lockfile lags `package.json` |

---

## 11. Ops runbook (minimal)

1. Apply `db/migrations/31_notification_workflows.sql`, then `32_notification_workflow_seeds.sql` (and all prior).
2. `bun add nodemailer` / `bun install`.
3. Set env; enable one email + one WhatsApp provider in UI.
4. Set `companies.email`; activate report schedules with recipients.
5. Install four cron lines from `deploy/README.md`.
6. Smoke: `overdue`, `overdue-reminders`, `contract-expiry`, `scheduled-reports`.

---

## 12. Out of scope

- Dana-bot / Phase 8.
- Native mobile apps.
- Force-push / history rewrite (Lovable-connected `main`).
- Replacing MyFatoorah per-month settlement logic.
