# Partial-payment edit re-sync and invoice payment breakdown — implementation plan (v3)

Spec: `docs/superpowers/specs/2026-09-07-partial-payment-edit-and-invoice-breakdown-design.md` (v3). Read it first and follow it exactly; every step below refers to its decisions (D3′, D4, D5) and its verified facts (§2). Where the spec and this plan disagree, the spec wins.

Worktree: `E:\Dana-kuwait-partial`, branch `feat/partial-payments`. Do not touch `E:\Dana-kuwait`.

## Files

| # | File | Change |
| --- | --- | --- |
| 1 | `db/migrations/191_partial_payment_resync_on_edit.sql` | new, one transaction (`begin;`/`commit;` in the file): `lock table public.partial_payments in share row exclusive mode`; read-only preflight (raises on any invariant break); drop `partial_payments_settled_immutable` + `tg_partial_payments_settled_immutable()` and `partial_payments_settle_on_link` + `tg_partial_payments_settle_on_link()`; 3-arg overload `apply_partial_payment_settlement(uuid, boolean, boolean)` with the 1-arg version delegating `(false, false)`; `tg_partial_payments_resync()` row trigger `after update of amount, invoice_id, paid_date`; statement trigger `partial_payments_bulk_edit_guard` (`referencing new table as edited`, raises `partial_payment_bulk_edit_unsupported` when `(select count(*) from edited) > 1`); RPC `edit_partial_payment(uuid, numeric, date, uuid, text)`; table comment. Idempotent. |
| 2 | `db/migrations/192_invoice_payment_breakdown.sql` | new: `alter table payments add column if not exists payment_request_id uuid references payment_requests(id) on delete set null` + index; backfill from `resulting_payment_id` and from notes starting `MyFatoorah <code>`; RPC `get_partial_payment_edit_context(uuid)` (security invoker, stable); RPC `get_invoice_payment_breakdown(uuid)` (security definer, stable, invoice-anchored authorisation predicate copied verbatim from `invoices_select_allowed`); grants to `authenticated`, revoke from `public, anon`. |
| 3 | `src/db/partialPaymentSettlement.sqltest.ts` | replace the "cannot edit" suite with the resync suite (spec §4, every bullet) |
| 4 | `src/db/invoicePaymentBreakdown.sqltest.ts` (new) | the breakdown and edit-context RPC cases (spec §4) |
| 5 | `src/integrations/supabase/database.types.ts` | hand-add `payment_request_id` to `payments` Row/Insert/Update and the three RPCs under `Functions` (mirror `gen:types` by hand; never overwrite) |
| 6 | `src/fns/myfatoorahWebhook.ts` | `createConfirmedPaymentForInvoice` inserts `payment_request_id: input.paymentRequest.id` — nothing else changes |
| 7 | `src/i18n/dictionary.ts` | remove `partialPayments.lockedHint`; add: retry/loading hints for the dialog, `partialPayments.bulkUnsupported`, `partialPayments.retry` (40P01); document strings — invoice total, remaining, paid in full, paid in full using N methods (ar dual/plural), partially paid with remaining, unpaid, cancelled, written off, nothing due, partial-payment group label, reconciliation warning. Keep `partialPayments.settledImmutable`. Both locales, parity. |
| 8 | `src/lib/partialPaymentErrors.ts` (+ test) | map the new codes and `40P01` |
| 9 | `src/hooks/usePartialPaymentEditContext.ts` (new) | `useQuery` around the edit-context RPC; refetch on open; invalidated by the money-record mutations |
| 10 | `src/hooks/useEditPartialPayment.ts` (new) | mutation calling `edit_partial_payment`; writes the audit row like `useUpdateMoneyRecord`; invalidates the same keys |
| 11 | `src/lib/partialPaymentRemaining.ts` (+ test) | pure `remainingForEdit(context, selectedInvoiceId, settleableInvoices)` |
| 12 | `src/components/admin/PaymentSidePanels.tsx`, `src/components/admin/RecordPanelDialog.tsx` | D4 wiring (loading / failure+retry / loaded states; current invoice always offered; Save via the edit RPC for `partial_payments`, generic update for the other tables); remove the locked hint |
| 13 | `src/lib/paymentMethodLabels.ts` (new; `paymentReceiptHtml.ts` imports it) | one ar/en method table |
| 14 | `src/lib/invoicePaymentBreakdown.ts` (+ test) | payload types; `describeBreakdown(payload, locale)` → ordered group rows, distinct-method count, status line, `reconciled` handling |
| 15 | `src/hooks/useInvoicePaymentBreakdown.ts` (new) | `fetchInvoicePaymentBreakdown(invoiceId)` → RPC; throws on error or `null` |
| 16 | `src/lib/invoicePrintHtml.ts`, `src/lib/invoiceDocument.ts` (+ tests) | D5 rendering; `breakdown` required; `buildInvoicesDocument(invoices, company, locale, fallbackTitle, breakdowns: Map, receiptCode?)` |
| 17 | `src/lib/invoiceDocumentLoader.ts` (+ test) | `loadInvoiceDocument` / `loadInvoicesDocument` with an injected fetcher; throws on failure or missing entry |
| 18 | every caller — `InvoicePrint.tsx`, admin invoices page actions, tenant-detail print, `usePortalInvoiceDocument.ts`, portal download sites (grep `buildInvoiceDocument(` / `buildInvoicesDocument(`) | go through the loader; failure = toast, no document |
| 19 | `src/components/admin/InvoicePrint.tsx` | reconciliation warning banner when `reconciled` is false |
| 20 | a structure test | the breakdown RPC SQL contains the exact `invoices_select_allowed` predicate text |
| 21 | `docs/superpowers/specs/2026-08-24-…-design.md` | one line under D3 pointing at the 2026-09-07 spec |

## Order

1. Migrations 191 and 192, then the SQL tests (files 3–4). Headers: Arabic first; then the AFTER-trigger reasoning, the lock order, the recompute-before-apply requirement, the deadlock-detection fallback for direct writes, and the delete-path gap. Use `is distinct from`. The preflight must be a `do $$ … $$` block that raises with the offending ids.
2. Types (file 5), webhook field (file 6), dictionary (file 7), error mapping (file 8).
3. Edit context + edit mutation + remaining helper + dialog (files 9–12).
4. Method labels + breakdown lib + fetch hook (files 13–15), rendering (file 16), loader (file 17), callers (18–19), structure test (20).
5. Doc pointer (file 21).

## Rules that apply to every step

- Every function gets a doc comment before it, Arabic first, explaining *why* (CLAUDE.md).
- No file over 500–600 lines. `admin.invoices.tsx` and `admin.contracts.tsx` are already over; do not grow them — new logic goes in hooks/lib. If `PaymentSidePanels.tsx` would cross the ceiling, split the partial-payment dialog logic into its own file.
- `database.types.ts` is hand-maintained; edit by hand.
- `security definer` functions in `public`: EXECUTE revoked from `public, anon` (migration 96). Trigger functions likewise.
- Money stays `numeric(14,3)` in SQL; format with `formatKwd`; never sum currency in floating point on the client.
- Do not commit. Leave the working tree for review.

## Gates (Windows machine, no bun, no Docker)

```
npx tsc --noEmit
npx vitest run
npx eslint <touched files>
npx prettier --check <touched files>
```

Do **not** run `bun run test:sql` / `test:db` here (the reviewer runs the SQL suites on a scratch database on the host). Do **not** run repo-wide `eslint .`.

## Report contract (for the implementer)

1. What changed and why, per file.
2. Full list of touched files.
3. Gate outcomes with counts.
4. Which spec risks (§3) and tests (§4) are covered, and which are not.
5. Anything deviated from the spec, left open, or needing a decision.
