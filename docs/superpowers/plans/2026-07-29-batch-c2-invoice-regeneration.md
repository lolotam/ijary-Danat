# Batch C2 — Implementation plan

**Spec:** `docs/superpowers/specs/2026-07-29-batch-c2-invoice-regeneration-design.md`
**Branch:** `feature/batch-c2-invoice-regeneration` (cut from `main` after Batch C merged)
**Status:** Implemented 2026-07-29

Two commits: the engine, then the wiring.

---

## Commit 1 — Migration 55: the UPSERT-diff engine

**Files**

| File                                          | Change                                                 |
| --------------------------------------------- | ------------------------------------------------------ |
| `db/migrations/55_invoice_regeneration.sql`   | new                                                    |
| `src/integrations/supabase/database.types.ts` | hand-add `regenerate_contract_invoices` to the RPC map |
| `src/db/invoiceRegeneration.sqltest.ts`       | new — tests 1–10                                       |

**Steps**

- [x] 1.1 Add `public.invoice_has_pending_request(_invoice uuid) returns boolean` — `stable`, checks `payment_requests.status = 'pending' and _invoice = any(requested_invoice_ids)`. One place, so the delete guard and the cancel branch cannot disagree.
- [x] 1.2 Write `public.regenerate_contract_invoices(p_contract_id uuid)` returning `(id, code, period_year, period_month, total, state, action text)` where `action ∈ (updated, inserted, cancelled, deleted, skipped)`. The `action` column is what lets the UI report honestly instead of claiming a count.
- [x] 1.3 Keep the permission guard (`invoices.create`) in this function, matching its siblings — but it is called only from a server fn, never a trigger. See the spec.
- [x] 1.4 **UPDATE branch**: for periods that should exist and do, and whose invoice is `due`/`overdue` with `paid = 0`, recompute `subtotal`/`discount`/`total`/`due_date` in place using the same concession arithmetic as `generate_invoices_for_year`. Rewrite `invoice_items` for that invoice to match. Never touch `id`, `code`, `paid` or `state`.
- [x] 1.5 **SKIP branch**: invoices with `paid > 0` or state `paid`/`partially_paid` are returned as `skipped` and not modified.
- [x] 1.6 **INSERT branch**: delegate to `generate_invoices_for_year(p_contract_id, year, true)` so concessions and items come along for free.
- [x] 1.7 **REMOVE branch**: for periods outside the contract's range — `delete` only when `paid = 0` **and** no allocation exists **and** `not invoice_has_pending_request(id)`; otherwise set `state = 'cancelled'`.
- [x] 1.8 Hand-add the RPC entry to `database.types.ts`. Never run `gen:types` over it.
- [x] 1.9 Write the SQL tests. Test 3 mints a real `payment_requests` row and asserts the id still resolves _and_ the total moved.
- [x] 1.10 `bun run test:db` then `bun run test:sql` — green.

**Trap 1:** `invoices.balance` may be a generated column — check before writing
`total`, because an `UPDATE` that also targets a generated column errors.

**Trap 2:** the unique constraint is
`invoices_contract_id_period_year_period_month_key`. The UPDATE branch must
match on `(contract_id, period_year, period_month)`, not on the invoice code,
which is sequence-generated and unrelated to the period.

**Trap 3:** rewriting `invoice_items` must delete the old rows for that invoice
first, or line numbers collide and concession lines accumulate on every run —
which test 10 (idempotency) is there to catch.

---

## Commit 2 — Wire it into the contract edit path

**Files**

| File                                         | Change                              |
| -------------------------------------------- | ----------------------------------- |
| `src/fns/regenerateContractInvoices.ts`      | new server fn                       |
| `src/routes/admin.contracts.tsx`             | call it after a successful `update` |
| `src/i18n/dictionary.ts`                     | result strings, `ar` **and** `en`   |
| `src/fns/regenerateContractInvoices.test.ts` | mock-level tests                    |

**Steps**

- [x] 2.1 Write the server fn mirroring `src/fns/reapplyContractInvoices.ts` — same middleware, same validator shape.
- [x] 2.2 In `admin.contracts.tsx`, after `update.mutateAsync` succeeds, call it inside its own `try/catch` exactly as the create path wraps `backfillInvoices`. **A regeneration failure must never surface as a save failure** — the contract is already saved at that point.
- [x] 2.3 Report by action, not by a single count: "N updated, M added, K cancelled, J skipped". A bare count would hide the cancellations, which are the rows a human needs to look at.
- [x] 2.4 Both locales for every new key.
- [x] 2.5 `bun run format`, then `lint && typecheck && test && test:sql` — all green.

**Trap:** an accountant holds `contracts.update` but not `invoices.create`, so
this call will 403 for them by design. The catch block must say "contract saved,
invoices not regenerated" rather than showing a generic error — otherwise it
reads as though the save failed.

---

## Landing

- [ ] 3.1 Push, open a PR describing the pending-payment-request hole in the current delete guard.
- [ ] 3.2 Merge to `main`. Never force-push, rebase, amend or squash.
- [ ] 3.3 Apply migration 55 to production and re-probe `to_regprocedure`.
- [ ] 3.4 Cut Batch D's branch fresh from the updated `main`.
