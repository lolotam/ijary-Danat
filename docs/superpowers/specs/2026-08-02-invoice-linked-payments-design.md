# Invoice-linked manual payments — settle monthly invoices from the Add Payment form

**Date:** 2026-08-02
**Migration:** none — `apply_payment_allocation` is used as-is
**Branch:** `feat/invoice-linked-payments` (merged, PR #62)

This document describes what shipped, not the pre-review draft. Where the
review pass changed the design, the reason is recorded inline.

---

## 1. The problem

The admin Add Payment dialog asked for a **tenant** and a **typed amount**. On
save it inserted one `payments` row and then opened a _second_ dialog where the
admin typed an allocation amount per invoice by hand.

Two problems follow from that shape:

1. **A typed amount cannot reliably mark an invoice paid.** The allocation is
   applied by `apply_payment_allocation`
   (`db/migrations/05_phase3_invoices_payments.sql`, ~line 495), which:
   - raises `Allocation exceeds invoice balance` when `amount > invoice.balance`;
   - raises on invoices whose `state` is `cancelled` or `waived`;
   - writes `state = 'paid'` **only** when `paid >= total`, otherwise
     `partially_paid` or `overdue`.

   So a free-typed figure produces either an error or a silently
   `partially_paid` invoice. The one thing it cannot reliably produce is a paid
   one.

2. **Nothing tied the payment to a contract.** Tenant and unit were picked
   independently, and the unit list was derived by filtering contracts by
   tenant — which meant the form could record a payment against a
   tenant/unit pair no contract joins.

## 2. What the form does now

Field order in the create dialog:

| #   | Field                          | Behaviour                                        |
| --- | ------------------------------ | ------------------------------------------------ |
| 1   | **Contract**                   | Dropdown, first field, `code — tenant name`.     |
| 2   | **Tenant**                     | Read-only, derived from the contract.            |
| 3   | **Unit**                       | Read-only, derived from the contract. New field. |
| 4   | Account type                   | Unchanged.                                       |
| 5   | Payment method                 | Unchanged.                                       |
| 6   | **Amount**                     | Read-only, derived.                              |
| 7   | Payment date                   | Unchanged.                                       |
| 8   | **Unpaid invoices**            | Multi-select, oldest first, oldest pre-selected. |
| 9   | Reference / attachment / notes | Unchanged.                                       |

Saving creates **one `payments` row per selected invoice**, each allocated in
full to its own invoice.

## 3. The decisions, and why

### 3.1 The amount is derived, never typed

Given §1.1, "mark the selected invoices Paid" is satisfiable only when each
invoice receives exactly its full `balance`. The Amount field therefore shows
the **sum of the selected invoices' balances**, seeded from the contract's
`monthly_amount` before anything is selected. In the normal single-month case
the two coincide, which is why the request described it as "fetch the amount
from the contract".

It renders as a bordered muted block rather than a disabled `Input`, so nothing
about it looks typable.

### 3.2 One payment row per invoice

The requirement was that each month keeps a separate record in Payment and
Refund. One payment per invoice satisfies that directly and keeps every
existing surface — receipts, reversal, allocations — working per month with no
new concepts.

### 3.3 Unpaid means `balance > 0` **and** not cancelled/waived

The old allocation dialog filtered only on `balance > 0`. Because the RPC
raises on cancelled and waived rows, that filter builds a picker offering rows
the save then rejects. Both conditions live in `settleableInvoices`.

### 3.4 Ordering is `(period_year, period_month, code)`

Not `created_at`: invoices bulk-generated for a contract share an identical
`created_at`, so it cannot order them — a fact `useInvoices` already documents
for its own pagination tiebreaker. `code` is the same-period tiebreaker.

### 3.5 The batch notifies once

`notifyPaymentSuccess` already accepts an array of payment ids and aggregates
them into **one** admin alert and **one** tenant receipt. Left alone,
`useCreateManualPayment` fires per payment, so settling three months would send
a live tenant three separate receipts — and production cron and real messaging
are on.

`CreateManualPaymentInput` therefore gained `notify?: boolean`, defaulting to
`true` so every existing caller is unchanged. The batch passes `false` and
fires one aggregated call after the loop.

### 3.6 Partial failure is reported, and still notifies

**Changed during review.** The loop is N × (create payment → allocate) with no
enclosing transaction, so a failure halfway leaves the earlier months genuinely
paid. `settleInvoices` returns `{ createdIds, error }` rather than throwing, so
the caller can name how far the batch got.

The draft sent _no_ receipt when the batch failed partway — even though money
had moved for the months that did settle. The shipped code notifies whenever
`createdIds` is non-empty, then reports the failure. On failure the dialog
stays open and the form is not reset.

### 3.7 The contract list is no longer active-only

An ended contract still carries unpaid invoices; an active-only dropdown cannot
collect real outstanding debt. `useContracts` already excludes archived
contracts, which is the filter that matters here. This matches
`useContractDirectory` in `PaymentSidePanels`.

### 3.8 The oldest invoice is seeded once per contract

**Changed during review.** The draft re-seeded the selection whenever the
invoice query resolved, keyed partly on `dataUpdatedAt`. `src/router.tsx` builds
a bare `new QueryClient()`, so `staleTime` is 0 and `refetchOnWindowFocus` is
on: an admin who ticked three months, alt-tabbed to check a bank statement, and
came back would find only the oldest still selected — and would then settle one
month believing they settled three.

A `useRef` records which contract has already been seeded, so a refetch
returning identical rows leaves the selection alone.

### 3.9 Invoice page size is 500, not 100

**Changed during review.** `useInvoices` sorts newest-first, so the page size is
a window on the _newest_ invoices while this picker settles the _oldest_. At
100 a long-running contract would silently hide exactly the months that should
be paid first. 500 puts the cap beyond any real contract.

## 4. What was deliberately left alone

- The per-row **Allocate** button and its dialog. It still serves payments
  created outside this form (gateway, import). What did change: the create flow
  no longer opens it after saving, because the invoices are already allocated.
- Reversal, receipts, printing, the payments table, search and pagination.
- The portal payment path (`src/fns/createPayment.ts` — the MyFatoorah gateway
  path, unrelated despite the name), `src/fns/applyAllocation.ts`, and all SQL.

## 5. Known limits

- **The multi-payment loop is not atomic.** Making it so would need a new server
  function or a SQL routine that creates and allocates N payments in one
  transaction. Out of scope here; §3.6 is the mitigation, not a fix.
- **The dialog itself has no automated coverage.** The logic that can be tested
  without a DOM harness was extracted to `src/lib/invoiceSettlement.ts`; the
  wiring around it is verified by review and manual use.

## 6. Partial payments table

Separate, much smaller request. `RecordPanel` already rendered Contract /
Tenant / Unit / Complex behind `showContractColumns`, and `InsurancePanel`
already opted in. `PartialPaymentsPanel` now opts in too, which delivers all
four columns in the desktop table and the mobile card list.
