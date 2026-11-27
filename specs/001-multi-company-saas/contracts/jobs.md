# Contract: Background Jobs

How work leaves the request and how it runs. Background: [research.md](../research.md) R6, R7, R8, R19. Table shapes: [data-model.md](../data-model.md) section 4.

## 1. Enqueue

```ts
function enqueueJob<K extends JobKind>(
  db: SupabaseClient<Database>, // companyClient only; browser sessions cannot enqueue
  kind: K,
  payload: JobPayload<K>, // validated with the catalogue's Zod schema
  opts?: { dedupeKey?: string; requestedBy?: string }, // requestedBy: the signed-in staff member's user id
): Promise<{ jobId: string }>;
```

- Inserts one `job_requests` row. It never contacts Redis.
- `requested_by` is who receives the job's notice. A `companyClient` JWT carries no `sub`, so server code passes the staff member in `requestedBy` (SQL `_requested_by`); `enqueue_job` honours that argument only for `company_service` and otherwise takes the JWT `sub`. A composite foreign key to `profiles (company_id, id)` rejects a user from another company. System jobs leave it null.
- SQL functions enqueue with `perform public.enqueue_job(_kind, _payload, _dedupe_key)` inside their own transaction; this is the only way money events are emitted (FR-018).
- A second insert with the same `(company_id, kind, dedupe_key)` returns the existing job id.
- Payloads carry ids and the choices the request made (the two kinds below), never secrets, passwords or document bodies.

### Payloads that carry the request's choices

The worker runs after the request is gone, so what the staff member chose at request time travels in the payload:

| Kind                | Payload                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `company.info.send` | `{ tenantId, channels: ("email" \| "whatsapp")[], language: "ar" \| "en" }` — the channels the request chose and the language it sends in (the staff member's pick, or the renter's preferred language when the request chooses none). The worker sends on those channels only. |
| `payment.receipt`   | `{ paymentId, workflow: "payment-succeeded" \| "manual-payment-invoice" }` — the workflow the request ran under. The worker reads that workflow's pause switch and its recipient targets, so the manual settlement keeps the manual settlement's recipients.                    |

Every other kind carries ids only.

## 2. Relay

Runs in the worker every second:

1. `public.relay_claim_jobs(_limit)` claims up to 100 rows in one statement: `for update skip locked` picks either `pending` rows, or `published` rows whose `published_at` is more than five minutes old, and the same statement marks them `published`.
2. `queue.add(kind, { jobRequestId, companyId }, { jobId: row.id, attempts, backoff })` on the kind's queue, with the attempts and backoff of that queue (section 4).
3. A crash between 1 and 2 leaves the row `published`, and the five-minute sweep re-claims it. The duplicate `jobId` is a no-op in BullMQ, and `runJob` stops when the row is already `succeeded`, so the job still runs exactly once.
4. A row whose kind the catalogue does not know can never run: the relay marks it `failed` with `unknown job kind: <kind>` instead of leaving it published.
5. A row whose `queue.add` fails goes back to `pending`, the error is logged with the row id, and the round publishes its other rows.

## 3. Handler contract

```ts
type JobHandler<K extends JobKind> = (ctx: {
  jobRequestId: string;
  companyId: string;
  db: SupabaseClient<Database>; // companyClient(companyId) — never platformClient
  payload: JobPayload<K>;
  attempt: number;
}) => Promise<JobResult>;
```

Before calling the handler the worker:

- loads the `job_requests` row and stops if it is already `succeeded`;
- marks it `skipped` if the company is suspended or the kind's section is off, except `payment.settle`, which is exempt from both the suspension check and the section check;
- sets `status = 'running'`.

After the handler: `succeeded` with `result`, or on the final failed attempt `failed` with `last_error`. For kinds marked "notice" a `user_notices` row is written for `requested_by`.

The notice is written before the terminal status and is idempotent per `job_request_id`: a notice that cannot be written leaves the row retryable instead of ending the job without telling anyone, and the retry writes one notice and not two.

Every handler is idempotent: running it twice for the same `jobRequestId` produces the same state and no second message, document or record.

## 4. Queues

| Queue     | Concurrency | Attempts                 | Purpose                          |
| --------- | ----------- | ------------------------ | -------------------------------- |
| `notify`  | 10          | 3, exponential from 30 s | Email and WhatsApp sends         |
| `docs`    | 2           | 3                        | PDF generation                   |
| `bulk`    | 2           | 3                        | Chunked bulk work                |
| `sync`    | 2           | 3                        | Provider syncs, exports, backups |
| `inbound` | 5           | 5                        | Stored webhook events            |
| `cron`    | 1           | 1                        | Schedule fan-out                 |

WhatsApp sends take a per-connection pacing lock (R7). A send that cannot determine whether the provider delivered is not retried and becomes `needs_review`, as today.

## 5. Catalogue

| Kind                                                                                                            | Queue               | Dedupe key                      | Notice         | Replaces                                                                         |
| --------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| `notification.dispatch`                                                                                         | notify              | notification id                 | no             | inline `dispatchNotificationRecord` in `enqueueNotification`, `sendNotification` |
| `notification.bulk`                                                                                             | bulk                | request id                      | yes            | loop in `sendBulkNotification`                                                   |
| `invoice.send`                                                                                                  | docs → notify       | invoice id + channel + day      | no             | `sendInvoiceToTenant`                                                            |
| `payment.receipt`                                                                                               | docs → notify       | payment id                      | no             | PDF and send in `notifyPaymentSuccess`                                           |
| `company.info.send`                                                                                             | docs → notify       | tenant id + day                 | no             | `sendCompanyInfo`                                                                |
| `contract.pdf`                                                                                                  | docs                | contract id + version           | no             | `renderContractPdf` when attached to a message                                   |
| `report.run`                                                                                                    | docs                | schedule id + date              | no             | `runReportSchedule`, `resendGeneratedReport`                                     |
| `report.export`                                                                                                 | docs                | request id                      | yes            | large report exports                                                             |
| `invoices.generate`                                                                                             | bulk                | in-flight only                  | yes            | `generateInvoices`                                                               |
| `invoices.regenerate`                                                                                           | bulk                | contract id + request id        | yes            | `regenerateContractInvoices`                                                     |
| `import.run`                                                                                                    | bulk                | upload id                       | yes            | `bulkImport`                                                                     |
| `electricity.generate`                                                                                          | bulk                | in-flight only                  | yes            | `generateElectricityCharges`                                                     |
| `salaries.generate`                                                                                             | bulk                | company + month                 | no             | salaries cron                                                                    |
| `company.export`                                                                                                | sync                | request id                      | yes            | `backup`                                                                         |
| `company.restore`                                                                                               | sync                | request id                      | yes (platform) | `restoreBackup`                                                                  |
| `whatsapp.history.sync`                                                                                         | sync                | connection id + day             | no             | `evolutionHistorySync`                                                           |
| `whatsapp.avatars.sync`                                                                                         | sync                | connection id + day             | no             | `evolutionAvatars`                                                               |
| `gmail.sync`                                                                                                    | sync                | connection id + slot            | no             | `gmailSyncJob`                                                                   |
| `payment.reconcile`                                                                                             | sync                | company + slot                  | no             | `paymentReconcileJob`                                                            |
| `payment.settle`                                                                                                | inbound             | payment request id              | no             | settlement after webhook or return page                                          |
| `webhook.process`                                                                                               | inbound             | webhook event id                | no             | inline webhook handling                                                          |
| `overdue.evaluate`, `overdue.remind`, `contract.expiry`, `notification.drain`, `log.retention`, `usage.rebuild` | cron fan-out → sync | company + date                  | no             | the `JOBS` map in `cronJobs.ts`                                                  |
| `subscription.remind`                                                                                           | cron (platform)     | company + renewal date + offset | no             | new                                                                              |

Events emitted from SQL with `enqueue_job` (the money outbox): `payment.succeeded`, `payment.reversed`, `deposit.confirmed`, `refund.recorded`, `invoice.written_off`, `invoice.disputed`, `contract.closed_out`, `contract.restored`. Each maps to the existing event workflow sender, which now runs as a handler.

`invoices.generate` and `electricity.generate` are deduped in-flight only: each click's key carries a fresh request nonce (`<kind>:<year-or-period>:<requestId>`), and a request whose job is still `pending`/`published`/`running` for the same year/period answers later clicks with the running job's id (`alreadyRunning`) instead of queueing a second run. A terminal request (`succeeded`, `failed`, `skipped`) never blocks a re-run.

## 6. Stays synchronous

Record and allocate a payment, reverse a payment, mark an invoice paid or unpaid, close out a contract, create a payment link (FR-013). These run in the request; any message they cause is emitted through `enqueue_job` in the same transaction.

## 7. Schedules (company time, Asia/Kuwait)

| Schedule         | Fan-out kind                      |
| ---------------- | --------------------------------- |
| 01:10 daily      | `overdue.evaluate`                |
| 01:15 daily      | `overdue.remind`                  |
| 01:20 daily      | `contract.expiry`                 |
| 01:30 daily      | `report.run` per due schedule     |
| 01:30 on day 1   | `salaries.generate`               |
| 01:40 daily      | `notification.drain`              |
| 02:00 daily      | `log.retention`, `usage.rebuild`  |
| 08:00 daily      | `subscription.remind` (platform)  |
| every 10 minutes | `gmail.sync`, `payment.reconcile` |

The fan-out inserts one `job_requests` row per active company with dedupe key `<kind>__<companyId>__<date-or-slot>`.
