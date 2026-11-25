# Notification & Cron Workflow Audit — 2026-07-22

Live diagnosis against production (`danat-future.com`, Supabase container
`danatkuwait-supabase-deoznv-db-1`). Every claim below is backed by a command run
against the production host or DB, or by a file in this repo.

## Headline

**The cron jobs are running. Nothing is crashing.** All four jobs fire nightly and
return HTTP 200. The feature set from `9ddcad3` (workflows, Twilio, notification log)
is deployed and its schema is fully applied.

The reason "nothing happens" is **three configuration gaps and three code gaps** —
not broken cron wiring.

> **Status as of 2026-07-22** — all three code gaps are resolved. Gap B fixed and
> deployed (`d382778`); Gap A closed as deliberate non-action; Gap C implemented
> as the `notification-drain` job, deployed (`70bf840`) and **live on cron**
> (`40 1 * * *`, root crontab, 5 entries total).
>
> **Configs 1 and 2 are still unset** and need values only you have.
> Config 3 needed no action.

## What is verified working

| Area                       | Evidence                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cron installed             | Root crontab: 4 entries, 01:10–01:30 UTC daily, via `/usr/local/sbin/danat-cron`                                                                 |
| Cron auth                  | `CRON_SECRET` set; all runs return 200, no 401s in `/var/log/danat-cron.log`                                                                     |
| Migrations 31–37           | Applied. Enum `notification_providers` has `twilio`; `notification_types` has `deposit_confirmation`, `user_credentials`, `payment_admin_alert`  |
| Templates                  | All 14 present (ar/en for contract-expiry, deposit-confirmation, due-reminder, overdue-reminder, payment-admin-alert, receipt, user-credentials) |
| Expiry RPC                 | `identify_contract_expiry_reminders` exists                                                                                                      |
| Email delivery             | SMTP enabled and working — 3 notifications in state `sent`                                                                                       |
| Deposit workflow           | `deposit_confirmation` sent 2026-07-22 (spec action-item #1 works)                                                                               |
| Overdue reminders          | Ran 2026-07-21, produced 2 notifications; next-day run returned 0 → once-per-month idempotency confirmed                                         |
| Overdue flashing UI        | `animate-pulse` on overdue badges in `admin.invoices.tsx:87,248,337,487` and `admin.tenants.index.tsx`                                           |
| Notification Log + filters | `admin.settings.notifications.tsx` — audience (admin/tenant) and channel filters present                                                         |
| Deployed code              | Image built 2026-07-22 02:45 +03, includes latest commit `59ddb1d`                                                                               |

## Root cause 1 — WhatsApp is completely disabled (config)

```
provider | is_enabled
smtp                 | t
resend               | f
whatsapp_cloud_api   | f
twilio               | f
```

Every WhatsApp leg lands in state `skipped` with
`"WhatsApp skipped: no active WhatsApp provider in provider_configs."` — already observed on the
2026-07-21 overdue reminder.

This single setting disables **all** WhatsApp items in the spec: contract-expiry
WhatsApp, payment receipt WhatsApp, credentials WhatsApp, overdue WhatsApp.

**Provider integration work has since landed** — see
`docs/NOTIFICATION_PROVIDER_SETUP.md` for the manual configuration guide and the
approved-template mapping table. Note that enabling a WhatsApp provider is no
longer sufficient on its own: migration 38 requires an approved provider template
name (Meta) or Content SID (Twilio) to be recorded per notification template, and
dispatch refuses to send without one.

**Needs from you:** which provider (Meta Cloud API or Twilio) plus its credentials.
Note `whatsappProvider()` in `dispatchNotification.ts:70` prefers `whatsapp_cloud_api`
over `twilio` when both are on.

Mutual exclusivity is **already implemented and live in production** — the
`tg_provider_mutual_exclusivity` trigger on `provider_configs` covers both pairs
exactly as specified: enabling `smtp`/`resend` disables the other, and enabling
`whatsapp_cloud_api`/`twilio` disables the other. Twilio is fully seeded as a fourth
provider. No work needed here.

Cloud API additionally requires `template_code` on the notification, and Twilio
requires a non-empty body (`dispatchNotification.ts:186-189`) — otherwise it skips.

## Root cause 2 — Weekly/monthly admin reports are inactive (config)

```
code                 | frequency | recipients | is_active | last_run_at | next_run_at
weekly-admin-report  | weekly    | []         | f         | (never)     | 2026-07-21 18:18 UTC
monthly-admin-report | monthly   | []         | f         | (never)     | 2026-08-01 00:00 UTC
```

Two independent blockers: `is_active = false` **and** `recipients = []`. This is why
`scheduled-reports` returns `count: 0` every night.

⚠️ `weekly-admin-report.next_run_at` is already in the past. The moment it is
activated it fires on the **next cron tick (~01:30 UTC)** and emails real recipients.
Set `recipients` first, then activate.

**Needs from you:** the admin email addresses to receive these reports.

## Root cause 3 — contract-expiry is correct, not broken

Only 3 active contracts; the nearest ends **2026-12-31 = 162 days out**. Milestones
are 4/3/2/1 months and 7 days, so the 4-month window opens ≈ **2026-09-02**. A
`count: 0` today is the right answer. No action needed.

Do **not** test this by calling the cron job with a future `asOf` — jobs dispatch
inline and would send real messages. Verify via the read-only RPC instead.

## Code gap A — `setInvoicePaid` sends no notifications — ✅ RESOLVED as intended

**Decision (2026-07-22): "mark as paid" is an admin reconciliation action, not a
tenant-facing payment event. It stays silent. No code change.**

The tenant did not just pay — an admin is correcting the ledger. Notifying would
email and WhatsApp a receipt every time the box was ticked, including while fixing
a mistake. The three genuine payment paths (manual admin payment, gateway webhook,
gateway resume) do notify, and that is the correct split.

The reasoning is now recorded as a docblock on `setInvoicePaid` so this does not
get "fixed" into sending later. If a reconciliation ever should notify, it should
be an explicit opt-in on that handler, never an unconditional call.

Original finding, for the record:

`src/fns/setInvoicePaid.ts` calls the `set_invoice_paid` RPC, which records a
confirmed payment, but **never calls `notifyPaymentSuccess`**. The admin
"mark as paid" toggle therefore produces no tenant receipt, no admin alert, and no
Notification Log row — a direct miss against spec action-item #2.

The other three payment paths _are_ wired correctly:

- manual admin payment → `usePayments.ts:160`
- gateway webhook → `respondToMyFatoorahWebhook` → `settleGatewayPayment` → `notifyPaymentSuccess` (`myfatoorahWebhook.ts:531`)
- gateway resume/confirm → `confirmGatewayPayment` → `settleGatewayPayment` (same call)

## Code gap B — `notifyPaymentSuccess` idempotency window — ✅ FIXED, deployed

**Resolved in commit `d382778`, deployed to production 2026-07-22.**

The bug: `notifyPaymentSuccess` deduped by fetching the **last 50 `receipt` /
`payment_admin_alert` rows globally** — not filtered by tenant or payment id:

```ts
.in("type", ["receipt", "payment_admin_alert"])
.neq("state", "cancelled")
.order("created_at", { ascending: false })
.limit(50)
```

That is a recency window, not an idempotency check. It was correct only while the
table stayed under 50 receipt/alert rows; past that, earlier notifications fall out
of the window and **duplicate receipts get sent**.

The fix scopes the lookup to the tenant and matches the payload directly:

```ts
.eq("tenant_id", tenantId)
.contains("payload", { payment_ids: uniqueIds })
```

`.contains()` compiles to jsonb `@>`, which is an order-independent **superset**
match, so the trailing JS set-equality check in that function stays load-bearing —
do not remove it thinking the query already proves equality.

⚠️ **Still untested.** There is no `notifyPaymentSuccess.test.ts`; the only
reference to this function in the suite is a mock in `confirmGatewayPayment.test.ts`.
The green suite is a no-regression signal, not evidence the fix works. An
idempotency test would lock it in.

## Code gap C — scheduled notifications are never dispatched — ✅ FIXED

**Decision (2026-07-22): keep the scheduling feature, add a drain job.**
Implemented as `src/fns/notificationDrainJob.ts`, registered as the cron job
`notification-drain`.

**Installed and verified on 2026-07-22.** Root crontab entry
`40 1 * * * /usr/local/sbin/danat-cron notification-drain`, running after the
other four so it sweeps what they leave behind.

First run was executed manually before wiring the cron, and behaved exactly as
designed — it **cancelled the two orphaned rows and sent nothing**:

```json
{
  "count": 0,
  "dispatched": [],
  "retried": [],
  "cancelled": ["75e04a09-…", "62d8983a-…"],
  "notYetDue": 0,
  "heldForReview": 0
}
```

The `sent` count was 3 before and after, confirming nothing went out. A second
run was a complete no-op (`scanned: 0`), confirming idempotency. Both runs wrote
`job.notification_drain` rows to `audit_logs`.

Two hazards shaped the design, both worth preserving:

1. **A drain job must not blast a backlog.** Rows more than 72h past due are
   `cancelled`, not sent. This is what makes the two orphaned 2026-07-18 rows
   (below) safe: they cancel on the first run instead of firing 4-day-old manual
   messages at real tenants. There is a test for exactly that row shape.
2. **`channel: "both"` failures must not be auto-retried.** On a `both` row the
   email leg can succeed and the WhatsApp leg then throw; the catch in
   `dispatchNotificationRecord` discards `messageIds`, so the row reads `failed`
   with `provider_message_id` null even though the email was delivered. Retrying
   would send it twice, and nothing on the row distinguishes that case.
   Single-channel failures are safe — had their one leg delivered, the row would
   be `sent`. `both` rows stay on the manual retry button.

Follow-up worth doing separately: make `dispatchNotificationRecord` record
per-channel outcomes, so a `both` row can be retried safely. Until then the
`both` exclusion above is load-bearing.

Original finding, for the record:

**Scheduling a manual notification for a future time silently drops it.**
`src/fns/sendNotification.ts:137`:

```ts
if (scheduledAt && scheduledAt.getTime() > Date.now()) return insertResult.data;
return dispatchNotificationRecord(insertResult.data.id);
```

The row is inserted in state `queued` and the function returns. Nothing ever picks it
up — `cronJobs.ts` has jobs for overdue / overdue-reminders / contract-expiry /
scheduled-reports, but **no queue-drain job**. The admin Notifications screen exposes
a "Scheduled" field (`admin.settings.notifications.tsx:471`), so this is reachable
from the UI today.

`enqueueNotification.ts:76-80` has the same deferral branch, but no current caller
passes `scheduledAt` or `dispatch: false` — so for the automated workflows this is
latent, not live.

Separately, `failed` rows increment `retry_count` and nothing retries them.

Note on evidence: the two rows stuck `queued` since 2026-07-18 are **not** proof of
this leak — they predate the feature (`9ddcad3`, 2026-07-20) and carry a preset
`provider` that no current insert path writes. Treat them as orphaned pre-feature
test rows and clean them up separately. The bug above is established from the code
path, not from those rows.

## Recommended order of work

**You supply (config/business — I should not set these in prod unattended):**

1. WhatsApp provider choice + credentials → unblocks every WhatsApp item in the spec.
2. Admin recipient emails for the weekly/monthly reports, then activate the two
   schedules (set recipients **before** activating — weekly fires immediately).

**Done:**

3. ✅ Gap B — `notifyPaymentSuccess` idempotency now scopes by `tenant_id` and jsonb
   containment on `payload->payment_ids` instead of scanning the most recent 50 rows.
   **Committed in `d382778` and deployed to production on 2026-07-22.** Still has no
   dedicated test — see the Gap B section above.

   Separately, the provider-integration work in that same commit added migration 38
   (approved Meta / Twilio template mappings). See
   `docs/NOTIFICATION_PROVIDER_SETUP.md`. That changes what Config 1 below requires:
   enabling a WhatsApp provider is no longer sufficient on its own.

   The 6 `prettier/prettier` lint errors in `router.tsx`, `admin.contracts.tsx`,
   `dateDisplay.ts` are pre-existing — verified by re-running lint with this change
   stashed.

4. ✅ Gap A — decided: **admin reconciliation, stays silent.** No code change; the
   reasoning is recorded as a docblock on `setInvoicePaid` so it is not "fixed"
   into sending later.

5. ✅ Gap C — decided: **`notification-drain` cron job.** Implemented and tested.

6. ✅ 5th crontab entry installed and verified on 2026-07-22. The two orphaned
   rows queued since 2026-07-18 are now `cancelled`, so `notifications` holds no
   `queued` or `failed` rows — the next unattended run starts from a clean slate.

## Not yet verified

- Whether the weekly/monthly report **HTML content** matches the spec (successful vs
  delayed payments, budgeting, deposits) — the schedules have never run, so no
  `generated_reports` output exists to inspect.
- End-to-end credential-notification behaviour (`createAppUser` → `notifyUserCredentials`)
  — wired in code, but no `user_credentials` notification exists in prod yet.
