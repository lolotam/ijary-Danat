# Payment-link settlement — design

Date: 2026-08-07
Task: #7 — a successful KNET payment made through a manual payment link never
updated the invoice, and no notifications fired.

## 1. Evidence

Reconstructed from the production database (`danatfuture-supabase-ozoxsa-db-1`)
and the app container log on 2026-08-06.

| Time (UTC) | Event |
| ---------- | ----- |
| 15:38:44 | `PREQ-0000001` created for `INV-0000006`, 450.000 KWD |
| ~15:40 | Tenant pays via KNET — gateway reports the charge successful |
| 15:45:01 | Admin marks `INV-0000006` paid by hand → `PAY-0000006`, method `cash`, reference `AUTO-INV:INV-0000006` |
| 16:25:31 | The **only** settle attempt in the whole log fires, and throws |

```
[confirmGatewayPayment] settle failed 100621810000012471 7050025
  Payment request PREQ-0000001 has nothing left to settle and no payment to attach.
```

Supporting facts:

- All three `payment_requests` rows (`PREQ-0000001/2/3`) are still
  `status = 'pending'` after a successful charge.
- `select count(*) from public.webhook_events` → **0**. The MyFatoorah webhook
  has never fired, not once.
- The container has been up since 11:38, so the log covers the entire window.
  There is exactly one settle attempt, 40 minutes after the charge.

## 2. Root cause

**Primary — settlement has no liveness guarantee.**
`settleGatewayPayment` is reachable only from `confirmGatewayPayment`
(`src/fns/confirmGatewayPayment.ts`), a server function behind
`requireSupabaseAuth`, called only by the `/portal/payments/callback` page. If
the payer is not signed in, that page renders its `signin` state and settles
nothing; if the payer closes the tab, nothing runs at all. The intended backstop
— the webhook at `/api/public/myfatoorah-webhook` — returns 503 because
`MYFATOORAH_WEBHOOK_SECRET` is empty, which is correct fail-closed behaviour but
means there is no second path. There is no reconciliation job.

The settlement logic itself is *safe* (idempotent, re-verifies with the gateway,
never double-books). It has no *liveness* guarantee: nothing ensures it ever
runs. Both halves are needed for a money path to be correct.

**Secondary — settlement cannot reconcile after a manual workaround.**
Once an admin marks the invoice paid, every requested invoice sits at balance 0
and no payment carries the gateway reference. `settleGatewayPayment` reaches its
`work.length === 0` branch, finds no payment to adopt, and throws
(`src/fns/myfatoorahWebhook.ts`). Net effect: real KNET money stays recorded as
method `cash`, and the payment request stays `pending` forever.

**Notifications** are not separately broken. `notifyPaymentSuccess(paymentIds)`
already runs at the end of `settleGatewayPayment` and already fans out to
admin / company / tenant through the `payment-success` workflow gate. They never
fired because settlement never completed.

## 3. Design

Four components. A and B fix the bug outright; C depends on configuration only
the operator can supply; D is verification.

### A. Adopt manual placeholder payments instead of throwing

`set_invoice_paid` is the only writer of the reference `AUTO-INV:<invoice code>`
(migration 23). A staff-recorded cash, cheque, or transfer payment goes through
`createPayment` with an operator-entered reference and never carries that
prefix. The prefix therefore means precisely *"this row is a placeholder created
by the mark-paid checkbox, not evidence that money was received here"* — the
same invariant that lets the un-mark path safely delete these rows.

In the `work.length === 0` branch of `settleGatewayPayment`, before throwing:

1. Load the confirmed payments allocated to the requested invoices.
2. If **every** one of them has reference exactly `AUTO-INV:<its invoice code>`:
   adopt them. For each — update `method` to the settled gateway method, rewrite
   `reference` to `invoicePaymentReference(referencePrefix, invoice.code)`, and
   write an audit row (`payment.gateway_reconciled`) carrying the before/after
   method and reference. Then `finalizePaymentRequest` against the first, and
   run `notifyPaymentSuccess` for the adopted payment ids.
3. If **any** allocated payment has a different reference: do not touch
   anything. A genuine second payment exists and that is a human decision, not
   an automatic one. Complete the payment request against the existing payment
   and `console.error` a line naming the request code and the conflicting
   payment code.
4. If there are no allocated payments at all: keep today's throw.

Adoption changes the method and reference of an existing confirmed payment. It
does not change its amount, its allocation, or the invoice state, so no money
moves — this is a relabelling of a payment that already exists, recorded in the
audit log.

### B. Cron reconciliation job — the liveness guarantee

New `src/fns/paymentReconcileJob.ts` exporting `runPaymentReconcileJob(asOf)`:

- Select `payment_requests` where `status = 'pending'`,
  `provider_invoice_id is not null`, and `created_at > now() - interval '7 days'`.
  The window is bounded so an abandoned link does not cost a gateway call on
  every tick forever.
- Per row, call `fetchGatewayPaymentStatus(config, provider_invoice_id)`
  (already exported from `confirmGatewayPayment.ts`) and branch on the same
  `paymentOutcome` classification the callback uses. `paymentOutcome` is
  currently module-private in `confirmGatewayPayment.ts` and must be exported —
  reuse it rather than re-implementing the status vocabulary, or the job and the
  callback will disagree about what "paid" means:
  - `paid` → `settleGatewayPayment(...)` with `eventType: "cron.reconcile"` and
    `providerEventId: "reconcile:<PREQ code>"`.
  - `failed` → set `status = 'failed'` so it stops being polled.
  - `pending` → leave alone.
- A gateway lookup or settle failure for one request is caught, logged, and
  counted; it must not abort the remaining requests.
- Returns `{ count, settled, failed, errors }` for the cron response body.

Wiring:

- Add `"payment-reconcile": runPaymentReconcileJob` to the `JOBS` map in
  `src/fns/cronJobs.ts`. That map is deliberately the single source for both
  cron and the admin "Run now" UI, so registering once covers both.
- Migration registers the job in `cron_jobs` with `kind = 'scheduled'`, giving
  it a pause switch in Settings → Cron. Follows the `on conflict (key) do
  update` shape of migration 93, and like it must not touch `is_active` on
  replay.
- Add the crontab line to `deploy/README.md` alongside the existing seven,
  staggered off the others.

Idempotency: `settleGatewayPayment` returns early when
`paymentRequest.status === 'completed'`, so a repeated tick cannot double-settle.

### C. Webhook enablement

The webhook implementation is complete and correct. **The 503-when-unconfigured
check stays exactly as it is** — an unauthenticated settle endpoint is a money
path any caller could drive.

Code change is limited to one `console.warn` when the endpoint is reached while
`MYFATOORAH_WEBHOOK_SECRET` is unset, so a misconfigured webhook is visible in
the logs instead of silently 503-ing.

Turning it on requires two operator actions, outside this change:

1. Set `MYFATOORAH_WEBHOOK_SECRET` in Dokploy and redeploy.
2. Register `https://danat-future.com/api/public/myfatoorah-webhook` in the
   MyFatoorah dashboard.

Until both are done the webhook contributes nothing, which is why component B —
not C — is what actually fixes the reported bug.

### D. Notification verification

No new code. Verify in production that the `payment-success` row in `cron_jobs`
is active and its `recipient_targets` include `admin`, `company`, and `tenant`,
and that a reconciled settlement produces `notifications` rows for each. If the
gate is off or a target is missing, report it — do not flip switches on a live
system as a side effect of a code change.

## 4. Files

| File | Change |
| ---- | ------ |
| `src/fns/myfatoorahWebhook.ts` | Adoption branch in `settleGatewayPayment`; warn on unconfigured webhook |
| `src/fns/confirmGatewayPayment.ts` | Export `paymentOutcome` so the job shares one definition of "paid" |
| `src/fns/paymentReconcileJob.ts` | New — the reconciliation job |
| `src/fns/paymentReconcileJob.test.ts` | New — unit tests |
| `src/fns/myfatoorahWebhook.test.ts` | Adoption-rule tests |
| `src/fns/cronJobs.ts` | Register `payment-reconcile` in `JOBS` |
| `src/fns/cronJobs.test.ts` | Assert the new job name is routable |
| `db/migrations/107_payment_reconcile_job.sql` | New — seed the `cron_jobs` row |
| `deploy/README.md` | Crontab line for the new job |

No change to `database.types.ts`: the migration adds a row, not a column.

## 5. Testing

**Unit**

- Adoption rule: all placeholders → adopt, method and reference rewritten, audit
  row written, request completed.
- Adoption rule: one non-`AUTO-INV:` payment present → nothing mutated, request
  completed against the existing payment, error logged.
- Adoption rule: no allocated payments → still throws.
- Reconcile job: `paid` settles; `failed` marks the request failed; `pending` is
  left untouched; a request older than the window is not selected.
- Reconcile job: one failing request does not abort the rest.

**Regression**

- A first-time gateway settle with a live balance is byte-for-byte unchanged.
- A `completed` payment request is a no-op.
- The existing `assertCurrentBalance` overlap behaviour still holds — the
  adoption branch runs before it and must not change when it fires.

**SQL** — `bun run test:sql` builds a clean database and applies migration 107.

**Production verification after merge**

- Run `payment-reconcile` once and confirm `PREQ-0000001/2/3` reach a terminal
  status, that `INV-0000006`'s payment reads method `knet` with an `MF:`
  reference, and that `notifications` rows exist for admin, company and tenant.

## 6. Out of scope

- Task 6 (manual payment reason and the Method of Payment column) is the next
  spec and depends on this one landing first, because it must write
  `payment_method` from the gateway path as well as the manual path.
- A genuine double payment (tenant pays by card *and* the office receives cash)
  is detected and logged here, not resolved. Refunds are an existing separate
  flow.
- `MYFATOORAH_WEBHOOK_SECRET` and the MyFatoorah dashboard registration are
  operator actions, not code.
