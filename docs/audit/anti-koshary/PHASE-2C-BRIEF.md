# Phase 2C — implementation brief (corrected)

**Status: brief only, nothing implemented.** Written 2026-09-24 against `main` at `8913eca`, as a
correction to the owner's pasted task list before it is dispatched (Codex GPT-6 Astra, medium).
Three separate PRs, in this order. Repo rules: 500–600 line ceiling, Arabic doc comment above every
function, `bun run typecheck` + `bun run test` (+ `bun run test:sql` for SQL) + `bun run build`,
guard skills before merge. A merge to `main` deploys; migrations are applied by hand first.

> **There is no test of `settleGatewayPayment`'s money path today.** `myfatoorahWebhook.test.ts`
> covers parsing and signatures only. PR A's first commit is the failing tests.

---

## PR A — Gateway settlement: record captured excess (money path)

### The actual bug (not the one in the pasted task)

`src/fns/gatewaySettlement.ts` books each month at that invoice's **current balance**
(`createConfirmedPaymentForInvoice`, line 150; `allocatePaymentToInvoice`, line 380). The gateway
charged `paymentRequest.amount`, fixed when the link was issued. The only check that the two agree,
`assertCurrentBalance`, runs **only** when every requested month is being created from scratch
(line 529). So:

- a requested month paid or part-paid elsewhere after the link was issued is skipped or booked
  smaller (lines 493–512), and
- the difference `paymentRequest.amount − Σ(amounts booked for this request)` is captured by
  MyFatoorah and **recorded nowhere**.

`createPayment.ts:340-388` already resets a stale request when the *displayed* amount changes, so the
window is the race between issuing a link and the tenant paying it: narrow, but real money.

The same silence exists on the all-paid path: `settleAlreadyPaidRequest` → `resolvePaymentToAttach`
logs a `conflict` (a real payment already covers the invoice **and** the gateway charged) with
`console.error` only (line 319). That whole charge is excess.

### Remedy: record it, don't spend it

Do **not** allocate the excess to other unpaid invoices. That would settle months the tenant didn't
choose, `apply_payment_allocation` refuses out-of-order allocation (migration 217), and undoing it
needs a person.

Instead, after the per-month payments:

1. Compute `excess = roundToFils(paymentRequest.amount − Σ amounts of this request's payments)`,
   counting payments created in this run **and** payments already present from an earlier partial
   run (resume path).
2. If `excess > 0`, insert one more `confirmed` payment, **unallocated**: reference
   `${referencePrefix}#EXCESS` (the unique reference makes a replayed webhook reuse it),
   `payment_request_id` set, note naming the request and the reason. Unallocated payments already
   have a display path: the tenant portal shows them as the tenant's unapplied money
   (`portalPaymentContracts.ts:56`), and admins get **Allocate** in `PaymentsTable.tsx`, so an
   operator can apply or refund it.
3. Write an audit row `payment.gateway_excess` (request code, captured, booked, excess) and a
   `console.error` with the same fields.
4. The all-paid **conflict** path records the whole `paymentRequest.amount` the same way instead of
   only logging.
5. Also **never book more than was captured**: if a month's balance *grew* after the link was issued,
   book `min(balance, captured − booked so far)` and leave the rest of that invoice open. Decide
   whether this replaces the `assertCurrentBalance` throw on the fresh path; the throw currently
   leaves captured money unbooked until someone intervenes. Recommendation: replace it, and cover
   both directions in tests.
6. Receipts: make the excess payment's receipt visible to the tenant like the others, subject to the
   same roof-contract suppression. Decide whether it joins `notifyPaymentSuccess` (the message would
   say "payment received" — true, but it isn't applied to an invoice).

### Split `gatewaySettlement.ts` (605 lines)

A behaviour-only commit **before** the fix: e.g. `gatewaySettlementLookup.ts` (request/invoice/
payment reads), `gatewaySettlementAdoption.ts` (blocking payments, placeholder adoption, conflict),
and the settlement core. Every file under 500 lines. Keep the three callers' import of
`settleGatewayPayment` unchanged.

### Tests (first commit, failing)

A fake `supabaseAdmin` holding invoices, payments, allocations, receipts and payment_requests, with
`apply_payment_allocation` reproducing its real checks (amount ≤ payment's unallocated remainder and
≤ invoice balance).

| Case | Expect |
| --- | --- |
| Normal: two months, both open | two payments, both allocated, no excess |
| One month paid elsewhere before the callback | one payment + one `#EXCESS` equal to that month |
| One month part-paid elsewhere (cash) | its payment = remaining balance; `#EXCESS` = the cash part |
| All months paid by a real payment (conflict) | `#EXCESS` = whole charge; nothing re-allocated |
| All months paid by admin placeholders | placeholders adopted; **no** excess |
| Balance grew after issue | booked ≤ captured; invoice left open for the difference |
| Replayed webhook after full success | no new rows |
| Resume after a crash mid-run | existing payments counted; excess computed once |

Invariant asserted in every case: `Σ payments for the request == paymentRequest.amount`.

`bun run test:sql` can't exercise this TS path (no PostgREST in the test image); it guards the SQL
side of `apply_payment_allocation` only.

---

## PR B — Payment-link expiry (needs a migration)

Extend the **existing** reuse in `createPayment.ts:333-388`; never loosen its amount, method and
selection checks.

- **Wrong clock in the pasted task:** `created_at` is not the link's age. The reset path replaces the
  URL and provider ids but keeps the row's `created_at` (line 373), so a 24 h rule on `created_at`
  would mint a fresh link on every call for a row older than a day.
- **Fix:** new column `payment_requests.link_issued_at timestamptz`, set on create and on every reset
  (backfill = `created_at`). Reuse only when `status = 'pending'`, amount, method and selection still
  match, **and** `link_issued_at > now() − interval '24 hours'`. Otherwise reset.
- Migration (next free number), applied on production **before** the code merges, then
  `notify pgrst`; hand-add the column to `database.types.ts`.
- ~~**Depends on PR A:** a superseded URL can still be paid; PR A makes that money visible instead of
  silent.~~ **Wrong — see "PR B is held" below.** PR A never sees a superseded link's charge.
- Tests: fresh link reused; 25 h old link reset; amount changed → reset; method changed → reset;
  concurrent creates.

### PR B is held (2026-09-24) — two prerequisites

PR #237 implements the above and is green, but it is **held as a draft and migration 221 is not
applied**. MyFatoorah's `/v3/payments` documents no link-expiry field (`ExpiryDate` exists only on v2
`SendPayment`, `SessionExpiry` only on `/v3/sessions`), so a superseded link stays payable at the
gateway. The 24 h rule turns the reset — until now triggered only by a method or amount change —
into a daily event, and each reset leaves one such link behind.

1. **Superseded links must still find their request.** The reset clears `provider_invoice_id` /
   `provider_payment_id`, so paying an old link makes `findPaymentRequest` throw "No payment request
   matches this webhook" before any settlement code runs: the charge is recorded nowhere, not even
   as PR A's excess. Fix: keep the ids the reset clears (e.g. `superseded_provider_invoice_ids
text[]` on `payment_requests`, appended by the reset) and match them in `findPaymentRequest`
   after the live columns.

2. **Settlement accounting is per request; charges are per link.** Point 1 alone exposes this. PR A
   takes `captured = paymentRequest.amount` and sums `bookedForRequest(request_id)`. Trace: the
   tenant pays the old link (700, booked, request `completed`), then pays the new one. The second
   callback finds the request `completed` and returns at the `status === "completed"` check in
   `settleGatewayPayment` — and even past that, every invoice is at balance 0, `resulting_payment_id`
   is set, so `conflict` is false and excess = 700 − 700 = 0. Either way the second 700 vanishes.
   Fix: settle per charge, not per request —
   - read the gateway's actual captured amount for THIS charge (`EventDetails` carries none today;
     it has to come from the webhook payload / `GetPaymentStatus` transaction value, verified
     against MyFatoorah's docs, not guessed);
   - key booked-so-far by the charge's `MF:<paymentId>` reference prefix, not by `payment_request_id`;
   - a charge arriving on a `completed` request is recorded as excess, never short-circuited.
     Tests: old link then new link both paid → both charges fully booked (months + excess); replay of
     either charge writes nothing.

Only after both land does PR B's migration go to production and #237 merge.

### PR B as built — supersede, don't reset (replaces the `link_issued_at` design above)

Both prerequisites are met by never re-issuing a link on its own row:

- A stale (≥ 24 h by `created_at`), amount-changed or method-changed pending request is marked
  **`superseded`** (migration 223 adds the status) and releases its `idempotency_key` (set to null;
  the key is `UNIQUE`, which allows many nulls). A **new row** carries the new link. `failed` /
  `expired` / `cancelled` rows release the key and keep their status. Migration 221
  (`link_issued_at`) is dropped — `created_at` is now the link's age, since a row has one link.
- Request and link are 1:1 again, so #235's per-request `captured` and `bookedForRequest` hold.
  A charge on an old link finds its row by `provider_invoice_id` (no status filter); if the new
  link already paid the invoices, the conflict path records the whole charge as `#EXCESS`.
  Either order — old then new, or new then old — books both charges in full.
- `runPaymentReconcileJob` polls `pending` **and** `superseded` rows (the webhook does not
  settle in production; the cron is what finds a paid old link). A gateway-failed superseded row
  stays superseded — the "mark failed" update is limited to `pending`.
- Losing the insert race (23505) re-reads the winner's row and returns its link when it fits.
- `getSuppressedPaymentIds` resolves unallocated payments (an `#EXCESS`) through
  `payment_request_id → requested_invoice_ids → contracts`, so a hidden contract's excess stays
  hidden.
- **Changed guarantee:** one **pending** request per invoice selection, not one row. Superseded
  links stay payable at the gateway and route to `#EXCESS`.
- **Open question:** `invoice_has_pending_request` (migration 55) blocks invoice regeneration only
  for `pending` rows. A superseded link is still payable; if its invoices are regenerated before it
  is paid, settlement throws "A requested invoice no longer exists" and the charge is not booked.
  Adding `superseded` to that guard would block regeneration for as long as any old link exists.
  Not changed here — owner decision.

---

## PR C — Debounce every server-side search (mechanical)

`useDebounce` (1000 ms) on the value that **drives a server query**, not on the visible input; reset
pagination when the committed value changes. Keep list, summary and export on the same committed
value.

Already done: `admin.contracts`, `admin.invoices`, `admin.settings.users`, `WhatsAppContacts`.
**Not done** (grep of search `setState` without `useDebounce`):

- `components/admin/whatsapp/WhatsAppInboxTab.tsx` (chats list, line ~65)
- `routes/admin.deposits.tsx`, `admin.expenses.tsx`, `admin.maintenance.index.tsx`,
  `admin.payments.tsx`, `admin.properties.index.tsx`, `admin.units.index.tsx`, `admin.reports.tsx`,
  `admin.settings.notifications.tsx`, `admin.settings.roles.tsx`, and the tenants list
- `components/admin/electricity/{Charges,Meters,Readings,Tariffs}Tab.tsx`,
  `employees/EmployeeTab.tsx`, `reports/{Generated,Scheduled}ReportsPanel.tsx`

**Leave alone** unless they query the server: `TenantPicker`, `TenantMultiSelect`,
`ComposeRecipients`, `WhatsAppForwardDialog`, and the public `ShopExplorer`. Debouncing a filter
over a list already in memory only adds a second of lag. Check each file: if the search value goes
into a query key or a `.ilike`/`.or`, debounce it; if it filters a local array, don't.
