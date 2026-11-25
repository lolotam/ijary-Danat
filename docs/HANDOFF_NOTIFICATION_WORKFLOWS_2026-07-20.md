# Handoff Report — Automated Notification Workflows

**Date:** 2026-07-20  
**Project:** Danat Al Mustaqbal ERMP (دانة المستقبل العقارية)  
**Branch:** `main`  
**Audience:** Product / engineering review (e.g. GPT or human reviewer)  
**Authoritative product spec:** `spec/AUTOMATED_NOTIFICATION_WORKFLOWS.md`

---

## 1. Executive summary

This work implements **automated time-based and action-based notification workflows** on top of the existing notification bus (`notifications` table + dispatch pipeline).

### Delivered in code

| Area             | What was done                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Time-based       | Weekly/monthly admin report HTML enrichment; contract expiry 4m/3m/2m/1m/**7d** + admin email; **overdue-reminders** job; four cron jobs |
| Action-based     | Deposit confirmed → admin email + attachment; payment success → admin + tenant email/WA; user create → credentials email/WA              |
| Notification Log | Filters: audience, channel, to, from, type, state, dates                                                                                 |
| Templates        | Branded HTML in `emailTemplates.ts` + DB seeds for new types                                                                             |
| Providers        | Twilio WhatsApp; real SMTP (nodemailer); Resend attachments; mutual exclusivity (email XOR, WhatsApp XOR)                                |
| Schema           | Migrations **31**, **32**, **33**, **34**                                                                                                |
| Spec             | `spec/AUTOMATED_NOTIFICATION_WORKFLOWS.md`                                                                                               |

### Not done by code alone (needs human / ops)

- Production env secrets and provider enablement in UI
- Host/Dokploy **cron** entries for four jobs
- Meta WhatsApp **approved templates** (if using Cloud API)
- Activating report schedules with real recipient emails
- `bun.lock` refresh for `nodemailer` (`bun add nodemailer`)
- Optional: commit push / Dokploy redeploy

**Migrations 31, 32, and 34 were applied manually by the owner.** Migration **33** must be applied if it has not already been run.

---

## 2. Product requirements covered

### 2.1 Time-based loops

1. **Weekly admin report** — HTML email via `report_schedules` + `scheduled-reports` job; richer content (payments list, overdue cases, deposits, expenses, net). Seed: `weekly-admin-report` (inactive until recipients set).
2. **Monthly admin report** — Same pipeline; seed `monthly-admin-report`.
3. **Daily contract expiry** — Cron `contract-expiry`; milestones 4/3/2/1 months + **7 days**; tenant email + WhatsApp; admin email; Notification Log rows.
4. **Notification Log** — Permanent `notifications` history; UI under Admin → Settings → Notifications with audit-style filters.
5. **Overdue state** — Existing cron `overdue` flips invoice state.
6. **Overdue reminders** — New cron `overdue-reminders`: one email + WhatsApp set per tenant per calendar month (`payload.month_key`).

### 2.2 Action-based loops

1. **Deposit confirmed** — Admin HTML email (+ storage attachment when present); type `deposit_confirmation`.
2. **Tenant payment** — Admin alert (`payment_admin_alert`); tenant receipt email; tenant WhatsApp listing paid months; wired from MyFatoorah webhook and manual confirmed payment create. Per-month payment rows already created by gateway.
3. **User credentials on create** — Managerial: email user + admin, no WhatsApp. Tenant: email (admin in recipients) + WhatsApp. Type `user_credentials`. Manual resend still via `sendTenantCredentials`.
4. **Overdue UI alarm** — Pulsing badges on overdue invoices and tenants with `hasOverdue`.

### 2.3 Providers

- SMTP, Resend, WhatsApp Cloud API, **Twilio**
- Enabling Resend disables SMTP (and reverse); enabling Cloud API disables Twilio (and reverse) — DB trigger + UI toast

---

## 3. Architecture (as implemented)

```
Trigger (cron | webhook | deposit/payment/user action)
        │
        ▼
  enqueueNotification()  →  notifications row
        │   audience, recipient_address, channel, type, subject/body, payload
        ▼
  dispatchNotificationRecord(id)
        ├── email  → Resend OR SMTP (optional attachments)
        └── whatsapp → Cloud API (template name) OR Twilio (body text)
        ▼
  state: sent | failed | skipped | cancelled
  + write_audit
```

### Cron jobs (`POST /api/public/cron`, Bearer `CRON_SECRET`)

| Job                 | Purpose                                        |
| ------------------- | ---------------------------------------------- |
| `overdue`           | Flip due invoices → overdue                    |
| `overdue-reminders` | Monthly-style email/WA to tenants with arrears |
| `contract-expiry`   | Milestone reminders (4m–1m + 7d)               |
| `scheduled-reports` | Due weekly/monthly (etc.) admin HTML reports   |

Crontab samples: `deploy/README.md`.

### Key source files

| Path                                                 | Role                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `src/fns/cronJobs.ts`                                | Job registry                                               |
| `src/fns/enqueueNotification.ts`                     | Insert + optional dispatch; `getAdminNotificationEmails()` |
| `src/fns/dispatchNotification.ts`                    | Provider send, attachments, audience routing               |
| `src/fns/contractExpiryJob.ts`                       | Contract expiry orchestration                              |
| `src/fns/overdueRemindersJob.ts`                     | Overdue reminder job                                       |
| `src/fns/notifyDepositConfirmed.ts`                  | Deposit → admin email                                      |
| `src/fns/notifyPaymentSuccess.ts`                    | Payment → admin + tenant notify                            |
| `src/fns/notifyUserCredentials.ts`                   | User create credentials                                    |
| `src/fns/createAppUser.ts`                           | Calls credentials notify (best-effort)                     |
| `src/fns/myfatoorahWebhook.ts`                       | Calls payment notify after settle                          |
| `src/lib/emailTemplates.ts`                          | Branded HTML templates                                     |
| `src/lib/providers/{resend,smtp,whatsapp,twilio}.ts` | Adapters                                                   |
| `src/routes/admin.settings.notifications.tsx`        | Notification Log + providers UI                            |
| `spec/AUTOMATED_NOTIFICATION_WORKFLOWS.md`           | Full product/eng spec                                      |

### Migrations

| File                                      | Purpose                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `31_notification_workflows.sql`           | Enums (`twilio`, new types, `notification_audience`), columns, exclusivity trigger, expiry RPC (DROP first), richer report HTML |
| `32_notification_workflow_seeds.sql`      | Twilio provider row, weekly/monthly schedules, new templates (**must run after 31 commits**)                                    |
| `33_contract_expiry_retry_failed.sql`     | Dedup only `sent`/`queued` so failed/skipped can retry; `reminders_enabled` gates WhatsApp delivery only                        |
| `34_contract_expiry_delivery_retries.sql` | Retries per recipient/channel and prevents concurrent duplicate deliveries                                                      |

**Postgres pitfalls fixed in migrations:**

1. Cannot change function return type without `DROP FUNCTION identify_contract_expiry_reminders(date)` first.
2. `ALTER TYPE ... ADD VALUE` must **commit** before INSERTs use the new labels (hence 31 vs 32 split).

---

## 4. Behaviour details and design choices

| Decision                   | Choice                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Admin emails               | `companies.email` ∪ active admin profile emails                                                                                    |
| Overdue reminder cadence   | One set per tenant per `YYYY-MM`                                                                                                   |
| `reminders_enabled`        | Gates **proactive** WhatsApp only: `due_reminder`, `overdue_reminder`, `contract_expiry` — **not** credentials or payment receipts |
| Payment notify idempotency | Any non-cancelled `receipt` or `payment_admin_alert` with same `payment_ids` set                                                   |
| Payment PDF attachment     | Not in this cut (HTML body + multi-month text only)                                                                                |
| WhatsApp Cloud API         | Template name from `template_code` (hyphens → underscores); **no template variables** yet — Meta approval still required           |
| Twilio                     | Free-form body text                                                                                                                |
| `setInvoicePaid` toggle    | Does **not** fire payment notifications (by design)                                                                                |

### Post-audit fixes included

- Login URL construction in `notifyUserCredentials` (eslint)
- `hasOverdue` always computed even when tenant has no active contract
- `reminders_enabled` scope narrowed
- Payment re-notify idempotency across types
- Migration 31 DROP FUNCTION + text compare in exclusivity trigger
- Migration 33 failed-send retry for expiry

---

## 5. What was changed (file inventory)

### New files

- `db/migrations/31_notification_workflows.sql`
- `db/migrations/32_notification_workflow_seeds.sql`
- `db/migrations/33_contract_expiry_retry_failed.sql`
- `db/migrations/34_contract_expiry_delivery_retries.sql`
- `spec/AUTOMATED_NOTIFICATION_WORKFLOWS.md`
- `src/fns/enqueueNotification.ts`
- `src/fns/notifyDepositConfirmed.ts`
- `src/fns/notifyPaymentSuccess.ts`
- `src/fns/notifyUserCredentials.ts`
- `src/fns/overdueRemindersJob.ts`
- `src/lib/providers/twilio.ts`
- `docs/HANDOFF_NOTIFICATION_WORKFLOWS_2026-07-20.md` (this report)

### Modified (high level)

- Dispatch, cron, contract expiry, create user, MyFatoorah webhook, report schedule, resend report, send tenant credentials
- Hooks: deposits, payments, tenants, notifications
- Admin UI: notifications settings, invoices flash, tenants overdue badge
- Providers: resend (attachments), smtp (nodemailer), types, whatsapp
- emailTemplates, i18n, database.types, package.json (`nodemailer`), `.env.example`, `deploy/README.md`, `TODO.md`, `db/README.md`

### Dependencies

- `nodemailer` + `@types/nodemailer` added to `package.json`
- **`bun.lock` may not list nodemailer yet** — run `bun add nodemailer` (or `bun install` after package update) before production build

---

## 6. Manual checklist for the project owner

### A. Database (partially done)

- [x] Migration **31** applied
- [x] Migration **32** applied
- [ ] Migration **33** applied (recommended — run `db/migrations/33_contract_expiry_retry_failed.sql`)
- [x] Migration **34** applied manually

Verify enums after 31/32:

```sql
SELECT e.enumlabel
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'notification_providers'
ORDER BY e.enumsortorder;
-- expect: smtp, resend, whatsapp_cloud_api, twilio
```

### B. Application build / deploy

- [ ] `bun add nodemailer` (refresh lockfile)
- [ ] Commit pushed to `main` (Lovable/Dokploy sync)
- [ ] Dokploy redeploy of Danat-kuwait app

### C. Environment variables (Dokploy secrets)

| Variable                                                                                | Purpose                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------- |
| `CRON_SECRET`                                                                           | Cron endpoint auth (`openssl rand -hex 32`) |
| `PUBLIC_APP_URL`                                                                        | Portal/login links in credential emails     |
| `RESEND_API_KEY` + `RESEND_FROM` **or** `SMTP_HOST/PORT/USER/PASS/FROM`                 | One email provider                          |
| `WHATSAPP_*` **or** `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_WHATSAPP_FROM` | One WhatsApp provider                       |
| Existing Supabase / MyFatoorah keys                                                     | Unchanged but still required                |

Reference: `.env.example`

### D. Admin UI configuration

- [ ] **Settings → Notifications → Providers:** enable exactly one email + one WhatsApp
- [ ] Set **company email** (Settings / company profile) so admin reports and alerts have recipients
- [ ] **Reports:** edit weekly/monthly schedules → add recipient emails → set **active**
- [ ] Confirm tenants have email/WhatsApp and `reminders_enabled` as desired

### E. Cron (host or Dokploy scheduled tasks)

Point at `https://<host>/api/public/cron` (see `deploy/README.md`):

```cron
10 1 * * *  ... -d '{"job":"overdue"}'
15 1 * * *  ... -d '{"job":"overdue-reminders"}'
20 1 * * *  ... -d '{"job":"contract-expiry"}'
30 1 * * *  ... -d '{"job":"scheduled-reports"}'
```

### F. Smoke tests

```bash
curl -fsS -X POST "https://<host>/api/public/cron" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"job":"overdue"}'
# repeat for overdue-reminders, contract-expiry, scheduled-reports
```

Also manually: confirm a deposit, create a test user, complete a payment (or sandbox) and check Notification Log.

### G. WhatsApp Cloud API (if not using Twilio)

- [ ] Create and approve Meta templates matching codes (e.g. `overdue_reminder_ar`, `receipt_ar`, `contract_expiry_ar`, `user_credentials_ar` — hyphens in DB become underscores in API)

---

## 7. Known gaps / follow-ups (for reviewers)

| Item                                           | Severity         | Notes                                        |
| ---------------------------------------------- | ---------------- | -------------------------------------------- |
| Invoice/PDF attachment on payment emails       | Low              | HTML only today                              |
| Cloud API template parameters (amounts, names) | Medium           | Only template **name** sent today            |
| `setInvoicePaid` no notify                     | Low              | By design                                    |
| bun.lock / nodemailer                          | Medium           | Run bun install before build                 |
| Host cron not installed                        | High for go-live | Code alone does not schedule                 |
| Providers unconfigured                         | High for go-live | Sends will fail/skip until enabled + secrets |
| Report schedules inactive by default           | Medium           | Empty recipients until admin fills them      |

---

## 8. How to review this for another model (e.g. GPT)

Suggested review prompts:

1. Read `spec/AUTOMATED_NOTIFICATION_WORKFLOWS.md` as the product contract.
2. Diff against this handoff and the code paths in section 3.
3. Check money-adjacent paths: `myfatoorahWebhook` only **notifies** after settlement; it does not change allocation math.
4. Check security: no secrets in DB; only `*_env` refs; `SUPABASE_SERVICE_ROLE_KEY` stays server-side.
5. Check Lovable constraint: no force-push/amend of published history.
6. Validate migration order: 31 → commit → 32 → 33.

Acceptance criteria (from spec):

- [ ] Weekly/monthly reports send when schedule active + provider on
- [ ] Expiry at 4m, 3m, 2m, 1m, 7d; tenant + admin; log
- [ ] Deposit confirm → admin email (+ attachment) + log
- [ ] Payment → admin + tenant channels + log
- [ ] Overdue monthly reminder + flashing UI
- [ ] User create credentials per matrix + log
- [ ] Log filters + provider XOR
- [ ] Four jobs smoke-tested

---

## 9. Suggested next actions (priority order)

1. Run migration **33** on production Supabase if it has not already been applied.
2. `bun add nodemailer` and commit lockfile if missing.
3. Push commit to `main` and redeploy.
4. Configure env + enable providers + company email + report recipients.
5. Install four cron entries; smoke-test.
6. Submit Meta templates if using Cloud API.

---

## 10. End of handoff

Code and schema for automated notification workflows are implemented and documented. **Go-live depends on secrets, provider toggles, cron, report recipients, and optional migration 33** — not on further feature scaffolding for this scope.

For deep product detail, always prefer:

**`spec/AUTOMATED_NOTIFICATION_WORKFLOWS.md`**

For remaining project TODOs:

**`TODO.md` section 2**
