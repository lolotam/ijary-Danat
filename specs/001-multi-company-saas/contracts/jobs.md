# Contract: Background Jobs

How work leaves the request and how it runs. Background: [research.md](../research.md) R6, R7, R8, R19. Table shapes: [data-model.md](../data-model.md) section 4.

## 1. Enqueue

```ts
function enqueueJob<K extends JobKind>(
  db: SupabaseClient<Database>,      // browser-session or companyClient
  kind: K,
  payload: JobPayload<K>,            // validated with the catalogue's Zod schema
  opts?: { dedupeKey?: string },
): Promise<{ jobId: string }>;
```

- Inserts one `job_requests` row. It never contacts Redis.
- SQL functions enqueue with `perform public.enqueue_job(_kind, _payload, _dedupe_key)` inside their own transaction; this is the only way money events are emitted (FR-018).
- A second insert with the same `(company_id, kind, dedupe_key)` returns the existing job id.
- Payloads carry ids, never secrets, passwords or document bodies.

## 2. Relay

Runs in the worker every second:

1. `select … from job_requests where status = 'pending' order by created_at limit 100 for update skip locked`.
2. `queue.add(kind, { jobRequestId, companyId }, { jobId: row.id, attempts, backoff })` on the kind's queue.
3. Mark `published`. A crash between 2 and 3 republishes the row; BullMQ ignores the duplicate `jobId`.

## 3. Handler contract

```ts
type JobHandler<K extends JobKind> = (ctx: {
  jobRequestId: string;
  companyId: string;
  db: SupabaseClient<Database>;   // companyClient(companyId) — never platformClient
  payload: JobPayload<K>;
  attempt: number;
}) => Promise<JobResult>;
```

Before calling the handler the worker:

- loads the `job_requests` row and stops if it is already `succeeded`;
- marks it `skipped` if the company is suspended (except `payment.settle`) or the kind's section is off;
- sets `status = 'running'`.

After the handler: `succeeded` with `result`, or on the final failed attempt `failed` with `last_error`. For kinds marked "notice" a `user_notices` row is written for `requested_by`.

Every handler is idempotent: running it twice for the same `jobRequestId` produces the same state and no second message, document or record.

## 4. Queues

| Queue | Concurrency | Attempts | Purpose |
|---|---|---|---|
| `notify` | 10 | 3, exponential from 30 s | Email and WhatsApp sends |
| `docs` | 2 | 3 | PDF generation |
| `bulk` | 2 | 3 | Chunked bulk work |
| `sync` | 2 | 3 | Provider syncs, exports, backups |
| `inbound` | 5 | 5 | Stored webhook events |
| `cron` | 1 | 1 | Schedule fan-out |

WhatsApp sends take a per-connection pacing lock (R7). A send that cannot determine whether the provider delivered is not retried and becomes `needs_review`, as today.

## 5. Catalogue

| Kind | Queue | Dedupe key | Notice | Replaces |
|---|---|---|---|---|
| `notification.dispatch` | notify | notification id | no | inline `dispatchNotificationRecord` in `enqueueNotification`, `sendNotification` |
| `notification.bulk` | bulk | request id | yes | loop in `sendBulkNotification` |
| `invoice.send` | docs → notify | invoice id + channel + day | no | `sendInvoiceToTenant` |
| `payment.receipt` | docs → notify | payment id | no | PDF and send in `notifyPaymentSuccess` |
| `company.info.send` | docs → notify | tenant id + day | no | `sendCompanyInfo` |
| `contract.pdf` | docs | contract id + version | no | `renderContractPdf` when attached to a message |
| `report.run` | docs | schedule id + date | no | `runReportSchedule`, `resendGeneratedReport` |
| `report.export` | docs | request id | yes | large report exports |
| `invoices.generate` | bulk | company + year | yes | `generateInvoices` |
| `invoices.regenerate` | bulk | contract id + request id | yes | `regenerateContractInvoices` |
| `import.run` | bulk | upload id | yes | `bulkImport` |
| `electricity.generate` | bulk | company + period | yes | `generateElectricityCharges` |
| `salaries.generate` | bulk | company + month | no | salaries cron |
| `company.export` | sync | request id | yes | `backup` |
| `company.restore` | sync | request id | yes (platform) | `restoreBackup` |
| `whatsapp.history.sync` | sync | connection id + day | no | `evolutionHistorySync` |
| `whatsapp.avatars.sync` | sync | connection id + day | no | `evolutionAvatars` |
| `gmail.sync` | sync | connection id + slot | no | `gmailSyncJob` |
| `payment.reconcile` | sync | company + slot | no | `paymentReconcileJob` |
| `payment.settle` | inbound | payment request id | no | settlement after webhook or return page |
| `webhook.process` | inbound | webhook event id | no | inline webhook handling |
| `overdue.evaluate`, `overdue.remind`, `contract.expiry`, `notification.drain`, `log.retention`, `usage.rebuild` | cron fan-out → sync | company + date | no | the `JOBS` map in `cronJobs.ts` |
| `subscription.remind` | cron (platform) | company + renewal date + offset | no | new |

Events emitted from SQL with `enqueue_job` (the money outbox): `payment.succeeded`, `payment.reversed`, `deposit.confirmed`, `refund.recorded`, `invoice.written_off`, `invoice.disputed`, `contract.closed_out`, `contract.restored`. Each maps to the existing event workflow sender, which now runs as a handler.

## 6. Stays synchronous

Record and allocate a payment, reverse a payment, mark an invoice paid or unpaid, close out a contract, create a payment link (FR-013). These run in the request; any message they cause is emitted through `enqueue_job` in the same transaction.

## 7. Schedules (company time, Asia/Kuwait)

| Schedule | Fan-out kind |
|---|---|
| 01:10 daily | `overdue.evaluate` |
| 01:15 daily | `overdue.remind` |
| 01:20 daily | `contract.expiry` |
| 01:30 daily | `report.run` per due schedule |
| 01:30 on day 1 | `salaries.generate` |
| 01:40 daily | `notification.drain` |
| 02:00 daily | `log.retention`, `usage.rebuild` |
| 08:00 daily | `subscription.remind` (platform) |
| every 10 minutes | `gmail.sync`, `payment.reconcile` |

The fan-out inserts one `job_requests` row per active company with dedupe key `<kind>__<companyId>__<date-or-slot>`.
