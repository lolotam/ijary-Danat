# Partial-payment edit re-sync and invoice payment breakdown — design (v3)

**Date:** 2026-09-07 (v3 after two Codex debate rounds)
**Branch / worktree:** `feat/partial-payments` at `E:\Dana-kuwait-partial`
**Supersedes:** decision D3 of `2026-08-24-payments-ordering-partials-resend-sender-design.md` (§2.2)

## 0. The request, and what an investigation found

The request had three parts:

1. "I added a partial payment of 1720 and cannot change it to 1750. Debug and fix."
2. "A partial payment linked to an invoice must deduct from it; the remaining amount must show in the admin invoices table, the tenant-detail invoices tab and the tenant portal; the tenant pays only the remainder by link and the invoice becomes fully paid; further partials keep deducting."
3. "The invoice PDF must show the invoice total, that it was paid by more than one method, and a breakdown: Partial payment 1,000 / By link 2,000 / Total 3,000."

A read-only survey of the code (2026-09-07) established:

| Requirement | State | Evidence |
| --- | --- | --- |
| Partial deducts from the invoice, state → `partially_paid` | **exists** | `db/migrations/160_partial_payment_settlement.sql:172-282` — a linked partial inserts a real `payments` row + `payment_allocations` row and runs `recompute_invoice_from_confirmed` |
| Remaining shows in admin invoices / tenant detail / portal | **exists** | `src/components/admin/invoices/InvoicesTable.tsx:426-430,486-487`; `src/components/admin/tenant-detail/InvoiceRowsTable.tsx:309-310,368`; `src/routes/portal.invoices.tsx:308-325` |
| Portal charges only the balance; webhook marks paid | **exists** | `src/fns/createPayment.ts:294-300,449-450`; `src/fns/myfatoorahWebhook.ts:433-486,667-673` |
| Further partials keep deducting | **exists** | each insert allocates against the then-current balance (`160:224-226`) |
| **Editing a settled partial's amount** | **refused by design** | `tg_partial_payments_settled_immutable`, `160:423-442`; recorded as user decision D3. The dialog never disables the field (`src/components/admin/RecordPanelDialog.tsx:201-215`), so the refusal surfaces only as a toast after Save. **This is the bug in part 1.** |
| Invoice PDF: remaining balance, multi-method, breakdown | **missing** | `src/lib/invoicePrintHtml.ts:89-112` prints Contract amount / Extras / Discount / Paid / a row labelled "Amount due" whose value is the **gross total**. |

Parts 1 and 3 are the work. Part 2 is already true; its existing tests (`src/db/partialPaymentSettlement.sqltest.ts`, `src/db/portalPayableByContract.sqltest.ts`, `src/fns/myfatoorahWebhook.test.ts`) stay green and are the evidence.

## 1. Decisions

### D3′ — editing a settled partial payment re-syncs the settlement (reverses D3)

**Two entry points, one rule.** The client edits through a new RPC, `edit_partial_payment(p_id uuid, p_amount numeric, p_paid_date date, p_invoice_id uuid, p_note text)`, which takes the locks *before* the ledger row is touched. A direct `UPDATE` of `partial_payments` (anything else that writes the table) is still re-synced by a trigger, so no writer can leave the ledger and the allocation disagreeing — the trigger is the invariant, the RPC is the ordering discipline.

**The RPC** (`security definer`, `set search_path = public`, EXECUTE to `authenticated` only; checks `has_permission(auth.uid(), 'partial_payments.update')` first, mirroring `partial_payments_update_permitted`):

1. read the row; resolve the current invoice's contract (via `invoices.contract_id`) and the target invoice's contract;
2. `pg_advisory_xact_lock(hashtextextended(contract::text, 0))` on each distinct contract **in sorted order** — the same key `apply_partial_payment_settlement` and `apply_deposit_settlement` use, so all settlement writers on a contract serialise on one lock, and the lock is held *before* any row lock this transaction takes;
3. `UPDATE partial_payments SET amount, paid_date, invoice_id, note WHERE id = p_id` — the trigger below does the money work under the locks already held (advisory xact locks are re-entrant);
4. return the updated row as jsonb (the client writes its audit row from it, as `useUpdateMoneyRecord` does today).

**The trigger** `tg_partial_payments_resync`, `AFTER UPDATE OF amount, invoice_id, paid_date ON partial_payments FOR EACH ROW`, `security definer`, EXECUTE revoked from `public, anon`, replacing `partial_payments_settled_immutable` (160) and `partial_payments_settle_on_link` (161). Body:

- no-op guard: return unless `new.amount is distinct from old.amount or new.invoice_id is distinct from old.invoice_id or new.paid_date is distinct from old.paid_date` (an `UPDATE OF` trigger fires when the column is *targeted*, and a no-op must not reissue a receipt);
- if the row owns a payment: **refuse when the old invoice is `cancelled`/`waived`** (`partial_payment_invoice_terminal_state`) — `recompute_invoice_from_confirmed` returns early for terminal invoices, so reverting there would strand a stale `paid`;
- take the sorted contract locks (idempotent when the RPC already holds them; this is what makes the direct-UPDATE path correct too, with the caveat below);
- `revert_partial_payment_settlement(old.id)` (unchanged: deletes receipt, allocation, payment), then `recompute_invoice_from_confirmed(old.invoice_id)` — the balance the re-apply checks must no longer include the reverted money; `balance` is a stored generated column of `paid`, and the recompute's `UPDATE` makes the new value visible to the rest of the transaction;
- if `new.invoice_id is not null`: `apply_partial_payment_settlement(new.id, p_correction => (old owned a payment), p_skip_order_check => (new.invoice_id = old.invoice_id))` — see the two flags below; any raise rolls back the whole `UPDATE`, ledger row included.

**Flags added to `apply_partial_payment_settlement`** (new 3-argument overload; the 1-argument version stays and calls it with `false, false`, so 160's insert trigger and 161's backfill are untouched):

- `p_correction`: the payment's note becomes `Settled from partial payment on invoice X (corrected)`, so a replacement is visible in the payments list.
- `p_skip_order_check`: **same-invoice corrections skip the chronological admission check**. The row was admitted when it was first linked; an earlier month reopening later (a reversal, say) must not make the accountant unable to fix a typo on a later month. New links and transfers keep the check.

**Concurrency, stated honestly.** Through the RPC, two edits on the same contract serialise on the advisory lock before either row lock, so they cannot deadlock. A *direct* `UPDATE` holds its row lock first; if it then waits for the advisory lock held by an RPC edit whose recompute makes migration 147's `sync_status` fan-out write that same row's `status`, Postgres detects the cycle and aborts one side (`40P01 deadlock_detected`) — a retryable error, not a hang, and never a corrupt state. The client maps `40P01` to a "please retry" toast. The UI has no direct-update path after this change. The delete path (160's BEFORE/AFTER DELETE triggers) takes no advisory lock today; unchanged and noted in the migration header as an existing gap.

**Bulk edits.** A single statement updating amount/invoice/paid_date on more than one `partial_payments` row is refused by a statement-level `AFTER UPDATE … REFERENCING NEW TABLE` trigger (`partial_payment_bulk_edit_unsupported`): 147's fan-out inside a multi-row statement can hit "tuple already modified", and no UI issues such statements.

**Unlinking** (`invoice_id → null`) reverts and leaves the row inert with its `status` untouched. **Linking** an unlinked row settles it (161's case, folded in).

**Row identity.** Revert-and-reapply creates a new `payments` row, a new payment code and a new receipt number, deliberately: the old receipt certified a wrong amount. Copies already downloaded cannot be recalled; the "(corrected)" note and the audit row are the trace.

**Migration 191.** Wrapped in one transaction (`begin; … commit;` in the file, so `psql -f` applies it atomically), which first `lock table public.partial_payments in share row exclusive mode` (pauses writers for the seconds the swap takes), then runs a **read-only preflight** that raises if any settled row violates the invariant the resync assumes — for every `payments` row with `source_partial_payment_id`: status `confirmed`, `payments.amount = partial_payments.amount`, exactly one allocation, `allocation.amount = payments.amount`, `allocation.invoice_id = partial_payments.invoice_id`, and the ledger row exists. Then: drop the two old triggers and their functions, create the overload, the RPC, the row trigger, the statement trigger, and the table comment. Idempotent on re-run. A preflight failure stops the migration before any change; the operator repairs by hand.

**Rollout.** Upload the exact reviewed migration files to the host, checksum against the PR head, `pg_dump`, apply with `ON_ERROR_STOP=1`, `notify pgrst, 'reload schema'`, then merge. Verification on production is read-only (`select` the trigger names, call the RPCs on a known invoice); no live-money edit.

### D4 — the dialog knows the row is settled and caps against the right balance

- **Data.** RPC `get_partial_payment_edit_context(p_id uuid)` (`security invoker`, `stable`, EXECUTE to `authenticated`; RLS on `partial_payments`, `payments`, `payment_allocations`, `invoices` applies) returns `{ settled, credited_amount, invoice: { id, code, period_year, period_month, balance, state } | null }` in one statement; `credited_amount` is the confirmed allocation this row's payment holds on `invoice` (0 when unsettled). The FK-embed alternative is rejected: PostgREST infers to-one cardinality from unique constraints, not from the partial unique index on `source_partial_payment_id`, so the embed would be an array.
- **Dialog policy.** The context query is keyed on the row id, refetched every time the dialog opens and invalidated after every mutation. While loading: amount, invoice and date inputs and Save are disabled with a "loading balance" hint. On failure: an inline error with a Retry button; Save stays disabled. Loaded: the current invoice is always among the options even if no longer settleable; `remaining` for it is `balance + credited_amount`, for any other invoice its plain balance; the arithmetic lives in `src/lib/partialPaymentRemaining.ts` (pure, tested). The database stays authoritative for concurrent changes.
- **Save** calls `edit_partial_payment` (D3′), not the generic update. Error codes map: `partial_payment_exceeds_balance`, `partial_payment_invoice_out_of_order`, `partial_payment_invoice_terminal_state`, `partial_payment_bulk_edit_unsupported`, `40P01` → retry toast. `partialPayments.lockedHint` is removed; `partialPayments.settledImmutable` and its mapping **stay** through this release (a client that outlives the migration window, or a rollback, still raises it).

### D5 — the invoice document gains a payments section and a remaining row

**Provenance is persisted.** New column `payments.payment_request_id uuid null references payment_requests(id) on delete set null`, written by the webhook's `createConfirmedPaymentForInvoice` (the one D6 exception: one field in one insert). Backfill in migration 192: for every `payment_requests` row, set it on `resulting_payment_id` **and** on every confirmed payment whose `note` starts with `MyFatoorah <request code>` (the webhook's own note format) — a request that settled several months links only its last payment through `resulting_payment_id`, which is why the column is needed. Rows that match neither stay `manual`; "unknown provenance" is not a category the document shows.

**One snapshot RPC.** `get_invoice_payment_breakdown(p_invoice_id uuid)` — `security definer` so it can read `payment_requests` on the tenant's behalf, with the invoice as the **authorisation anchor**: it first requires `exists (select 1 from invoices where id = p and (is_staff(auth.uid()) or (is_visible_to_tenant and exists (profiles p where p.id = auth.uid() and p.tenant_id = invoices.tenant_id))))` — the exact predicate of `invoices_select_allowed` (`05:159-165`) — and returns `null` otherwise. It returns, in one `select`:

```
{ invoice: { code, subtotal, discount, total, paid, balance, state },
  paid_from_allocations: numeric,   -- sum of effective allocations
  reconciled: boolean,              -- paid_from_allocations = paid
  groups: [ { source: 'partial'|'gateway'|'manual', method, amount, first_paid_on, payments: n } ] }
```

Effective allocations are those of payments with `status = 'confirmed'`. `reverse_payment` (`05:597-651`) sets the original to `reversed` and writes the mirror allocation on a `reversed` row, so both drop out — identical to `recompute_invoice_from_confirmed`. `source` = `partial` when `source_partial_payment_id is not null`, else `gateway` when `payment_request_id is not null`, else `manual`. Amounts are `sum(pa.amount)::numeric(14,3)`; ordering by `first_paid_on, source, method` (locale-independent).

**Reconciliation policy.** When `reconciled` is false (the stored `paid` disagrees with the allocations — possible today via `set_invoice_paid`'s raw sum, TODO.md:86-100), the document prints the stored totals with a single "Paid" row and **no breakdown section**, the admin sheet shows a warning banner naming the discrepancy, and the mismatch is logged. Refusing to print a paid invoice over an accounting drift the operator cannot fix from that screen would block real work; the breakdown is withheld because it would be the wrong picture.

**Rendering.** `buildInvoicePrintHtml(invoice, company, locale, breakdown)` — `breakdown` is a required parameter of type `InvoicePaymentBreakdown`; money rows (subtotal-derived contract amount, discount, total, paid, remaining) are rendered from the snapshot, extras from the invoice's own immutable items. Table:

| Row | Value |
| --- | --- |
| Contract amount / Extra charges / Discount | from snapshot `subtotal` − extras, extras, `discount` |
| **Invoice total** (relabelled; "Amount due" showing the gross total was wrong) | `total` |
| Paid — one sub-row per group | "Partial payment (cash) — 1,000.000", "Payment link (KNET) — 2,000.000" |
| Paid, total | `paid` |
| **Remaining** — always present | `balance` |

Status line: `paid` → "Paid in full", plus ", using N payment methods" only when the distinct `method` count N ≥ 2 (groups are provenance, not methods); `partially_paid` → "Partially paid — X remaining"; `cancelled` → "Cancelled"; `waived` → "Written off"; `total = 0` → "Nothing due"; otherwise "Unpaid". Arabic dual/plural for N. Labels come from `src/lib/paymentMethodLabels.ts` (moved out of `paymentReceiptHtml.ts`, imported by both documents); every label goes through `esc()`.

**Loading and callers.** One helper `loadInvoiceDocument(invoiceId, deps)` in `src/lib/invoiceDocumentLoader.ts` fetches the breakdown and builds the document; it throws on a failed fetch or a missing map entry, and every entry point (admin `InvoicePrint`, admin invoices page actions, tenant-detail print, portal download via `useFetchPortalInvoiceDocument`, `buildInvoicesDocument` with a `Map<invoiceId, breakdown>`) goes through it, so a failure is a toast and no document. The helper is unit-tested with an injected fetcher; the required TypeScript parameter is what makes a forgotten caller a compile error.

### D6 — non-goals

- No change to how much the portal charges or how the webhook allocates; the webhook insert gains exactly one field (`payment_request_id`).
- No editing of gateway or manual `payments` rows; no change to reversal.
- No change to deposits (153) or `set_invoice_paid` (129/159); TODO.md's open items on 129's arithmetic stay open, and D5's reconciliation policy is how the document copes with them.
- The delete path's missing advisory lock (160) is recorded, not fixed.
- No PDF engine change.

## 2. Verified facts the design rests on (read 2026-09-07)

- `tg_partial_payments_sync_status` (147:66-87) writes only `partial_payments.status`; fires `after update of state on invoices … when (new.state is distinct from old.state)`; its `update … where invoice_id = new.id` can touch any partial on that invoice.
- `recompute_invoice_from_confirmed` (153:141-181) locks the invoice `for update`, sums allocations of `status = 'confirmed'` payments, writes `paid`/`state`; returns early for `cancelled`/`waived`.
- `apply_partial_payment_settlement` (160:172-282) locks the invoice's contract with `pg_advisory_xact_lock(hashtextextended(contract::text, 0))`, checks terminal state, `amount > balance`, chronological order; inserts payment with `on conflict (source_partial_payment_id) do nothing`, allocation, refreshes the receipt, recomputes.
- `revert_partial_payment_settlement` (160:305-334) deletes receipt, allocation, payment by `source_partial_payment_id`; no recompute.
- `reverse_payment` (05:597-651) inserts the reversal with `status = 'reversed'` and mirror allocations, then sets the original's `status = 'reversed'`.
- `tg_partial_payments_link_guard` (151:21-62) refuses a link whose invoice belongs to another contract/tenant (contract check only when the row's `contract_id` is non-null).
- RLS: `invoices_select_allowed` (05:159-165); `payments_select_allowed` (06:124-132) — tenant sees own `confirmed`/`reversed` payments; `payment_allocations_select_allowed` (05:208-216) follows the payment's tenant; `payment_requests_select_allowed` (06:86). No later migration overrides these.
- Webhook: one confirmed payment per invoice month, `method` from the gateway event (default `card`), `reference` = gateway reference, `note` = `MyFatoorah <request code> — m/y`; `linkPaymentRequest` sets `payment_requests.resulting_payment_id` (scalar).

## 3. Risks the reviewer should attack

1. AFTER UPDATE + `sync_status` nested update of the same row (single-row statement) — proven by the fully-paid-reduction SQL test.
2. Lock discipline is only guaranteed through the RPC; the direct-UPDATE path relies on deadlock detection. Accepted and documented.
3. `p_skip_order_check` on same-invoice corrections: an *increase* on a later month while an earlier month is open adds money out of order. Accepted: the row was admitted; the increase is bounded by that invoice's balance.
4. The security-definer breakdown RPC duplicates the invoice RLS predicate; a future change to `invoices_select_allowed` must be mirrored. A structure test greps both for the same predicate text.
5. Backfill heuristics for `payment_request_id` (note prefix) could mislabel a manual payment whose note was typed to look like the webhook's; accepted, it only affects the label on a PDF.

## 4. Test plan

SQL (`src/db/partialPaymentSettlement.sqltest.ts` + new `src/db/invoicePaymentBreakdown.sqltest.ts`; `bun run test:sql` on a scratch Postgres on the host — never the live database):

- amount up via RPC (200 → 300): one owned payment of 300, allocation 300, invoice `paid` 300, receipt for the new payment only, note ends with "(corrected)".
- amount down on a fully paid invoice with one partial: `partially_paid`, row `status` `incomplete`, no error.
- `SET amount = amount` (direct UPDATE): payment id unchanged.
- amount above `balance + own credit`: `partial_payment_exceeds_balance`; ledger, payment, allocation, `paid` unchanged.
- same-invoice reduction while an earlier month is open: **succeeds** (skip flag).
- transfer to a later month that reopens the earlier one: `partial_payment_invoice_out_of_order`.
- transfer to an earlier unpaid month: succeeds; both invoices recomputed.
- unlink: reverted, invoice recomputed, `status` unchanged; unlink from a cancelled invoice: `partial_payment_invoice_terminal_state`.
- link an unlinked row: settles.
- `paid_date` change: `payments.payment_date` and receipt snapshot updated.
- `note`-only change: payment id unchanged.
- two partials on one invoice, edit one: the other's payment id, allocation and receipt untouched.
- bulk statement updating two rows' amounts: `partial_payment_bulk_edit_unsupported`.
- RPC permission: a role without `partial_payments.update` gets 42501.
- migration re-run is a no-op; preflight raises on a fixture with a mismatched allocation.
- breakdown RPC: staff sees groups; the owning tenant sees the same groups; another tenant gets `null`; a reversed payment contributes nothing and does not count as a method; split allocations across two payments of the same method form one group; `reconciled` false when `paid` is set by hand to a different value.
- edit-context RPC: settled row → `credited_amount` = allocation; unsettled → 0; other tenant → `null`.

Unit (Vitest):
- `partialPaymentRemaining.test.ts`: own invoice → `balance + credit`; other invoice → balance; unsettled → balance; no context → `null`.
- `invoicePaymentBreakdown.test.ts`: ordering, labels per locale, distinct-method count vs group count, Arabic dual/plural, escaping, `reconciled: false` → legacy rows only.
- `invoicePrintHtml.test.ts` / `invoiceDocument.test.ts`: unpaid / partial / paid with one and two methods / cancelled / waived / zero total; multi-invoice fragment byte-identical to the single-invoice document for the same snapshot.
- `invoiceDocumentLoader.test.ts`: fetch failure → throws, no document; missing map entry → throws.
- `partialPaymentErrors.test.ts`: the new codes and `40P01`.
- A structure test that the breakdown RPC's SQL contains the same predicate as `invoices_select_allowed`.

Gates: `npx tsc --noEmit`, `npx vitest run`, eslint + prettier on touched files; SQL suites on the scratch host database. Guard skills: clean-code-guard, test-guard, docs-guard.

## 5. Debate log

**Round 1 (Codex gpt-6-astra, medium).** REDESIGN, without repository access. Adopted into v2: sorted contract locks, no-op guard, preflight, keep legacy error mapping, RPC edit context, single-statement snapshot, server-side aggregation, distinct-method count, provenance not from `reference`, ordering tests from the real rule, independent migration staging, no live-money smoke test.

**Round 2 (same model, with the trigger/recompute/RLS/webhook source inline).** REDESIGN on two points, both accepted in v3: (a) a trigger cannot take the contract lock before the outer statement's row lock, and 147's fan-out can then cross-wait — hence the edit RPC that locks first, deadlock detection as the stated fallback for direct writes, and the bulk-edit refusal; (b) `resulting_payment_id` is scalar while one request settles several months — hence the persisted `payment_request_id` and its backfill. Also adopted: `(corrected)` via an explicit flag; same-invoice corrections skip the chronological check; terminal *source* invoices refuse edits; a full loading/failure/refetch policy for the dialog; the invoice as the authorisation anchor of a definer RPC; all money rows from the snapshot; reconciliation policy; status-line labels for cancelled/waived/zero; the transfer-success fixture replaced by "transfer to an earlier unpaid month"; a tested loader instead of a grep-only structure test; a transactional migration with a table lock. Not adopted: a two-session concurrency test (single-session harness; the lock argument is written down and reviewed instead); an in-place payment update to keep receipt numbers (a corrected amount must reissue).
