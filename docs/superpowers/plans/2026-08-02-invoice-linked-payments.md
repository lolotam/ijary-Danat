# Plan — invoice-linked manual payments

**Date:** 2026-08-02
**Design:** [`specs/2026-08-02-invoice-linked-payments-design.md`](../specs/2026-08-02-invoice-linked-payments-design.md)
**Status:** delivered — PR #62, merged to `main` as `ae05882`

Implementation was delegated to the Grok CLI from a written brief, then
reviewed, corrected and landed here. Steps 1–6 are as delegated; step 7 records
what the review pass changed.

---

## Step 1 — `useInvoices` gains a `contractId` filter

`src/hooks/useInvoices.ts` — add `contractId?: string` to `InvoiceListParams`,
include it in the react-query key, apply `.eq("contract_id", contractId)`.
Nothing else changes.

## Step 2 — pure settlement module

New `src/lib/invoiceSettlement.ts`. No React, no Supabase, no side effects.

- `settleableInvoices(invoices)` — keeps `balance > 0` and state not in
  `('cancelled','waived')`; sorts by `(period_year, period_month, code)`.
- `buildInvoiceSettlements(invoices, selectedIds)` — one entry per selected id
  that is actually settleable, oldest first, each amount the invoice's full
  balance rounded to 3 dp. Unknown ids are ignored, never emitted as `NaN`.
- `settlementTotal(settlements)` — sum rounded to 3 dp
  (`Math.round(x * 1000) / 1000`), matching KWD fils and `createPayment.ts`.

This is the only part with logic worth asserting, which is why it is a module
and not inline in the component.

## Step 3 — `useCreateManualPayment` gains `notify`

`src/hooks/usePayments.ts` — add `notify?: boolean` to
`CreateManualPaymentInput` and wrap the existing `notifyPaymentSuccessFn` call
in `if (input.notify !== false)`. Default keeps today's behaviour for every
existing caller.

## Step 4 — the dialog

`src/routes/admin.payments.tsx`, `FullPaymentsPanel` only.

- Schema becomes `{ contractId, accountType, method, paymentDate, reference,
note, invoiceIds }`. `tenantId`, `unitId` and `amount` become derived.
- `useContracts({ pageSize: 500 })` — no state filter.
- `useInvoices({ contractId, pageSize: 500 }, Boolean(contractId))` feeds the
  picker through `settleableInvoices`.
- Submit loops the settlements: create payment (`notify: false`) → allocate in
  full → collect the id. One aggregated notify afterwards.
- Do **not** open the allocation dialog after saving.
- Keep the per-row allocate, reverse and receipt flows untouched.

## Step 5 — i18n

`src/i18n/dictionary.ts`, **both** locales — `dictionary.ts` is
`Record<string, string>` per locale with no key-parity check, so a key added to
one locale ships to users as raw key text and typecheck will not catch it.

Added: `payments.unpaidInvoices`, `payments.noUnpaidInvoices`,
`payments.selectedInvoices`, `payments.settled`,
`payments.partialSettleFailed`. Removed `payments.created`, orphaned once the
success toast changed.

## Step 6 — partial payments columns

`src/components/admin/PaymentSidePanels.tsx` — add `showContractColumns` to
`PartialPaymentsPanel` and correct the prop's doc comment, which claimed
partial payments deliberately keep the narrow table.

## Step 7 — review corrections applied before merge

1. **Seed the oldest invoice once per contract, not per refetch.** With a bare
   `new QueryClient()` (`src/router.tsx`), `refetchOnWindowFocus` is on, so the
   delegated version silently collapsed a multi-month selection back to one
   month when the admin tabbed away and back. A `useRef` now gates it.
2. **Invoice page size 100 → 500.** `useInvoices` sorts newest-first, so 100
   was a window on the newest invoices while the picker settles the oldest.
3. **Notify on partial failure.** The delegated version sent no receipt at all
   when the batch failed partway, though money had moved for the months that
   settled.
4. **Extracted `settleInvoices`** from a ~46-line submit handler, returning
   `{ createdIds, error }` rather than throwing, and passing the contract as a
   parameter instead of a non-null assertion on a closure.
5. **Removed the orphaned `payments.created` key** from both locales.
6. **Test-helper defaults and a non-mutation test** — the `invoice()` factory
   applied `??` defaults that the spread below silently overrode; and
   `settleableInvoices` sorts, so a test now pins that it does not sort the
   caller's array.

## Validation

`bun run lint` (0 errors), `bun run typecheck`, `bun run test` — run on the
final branch off `main`: 494 tests passing.

`bun run test:sql` was not required: no migration, no SQL change.

## Not verified

The dialog has not been exercised at runtime. The pure module is covered by
tests and the wiring by review, but no automated or manual run has confirmed
end to end that a two-invoice settlement writes two `payments` rows, two
`payment_allocations`, two invoices at `state = 'paid'`, and exactly one
receipt notification.
