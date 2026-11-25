# Batch C2 — T15: contract → invoice regeneration that preserves invoice identity

**Date:** 2026-07-29
**Task:** T15 (contract changes must reconcile that contract's invoices)
**Migration:** `db/migrations/55_invoice_regeneration.sql`
**Depends on:** Gate 1 (SQL harness). Batch D depends on this.

---

## What is actually missing

The master plan described T15 as "add historical backfill". Reading the code
first changes that: **creating a contract already backfills its history.**
`admin.contracts.tsx:272` calls `backfillContractInvoices` right after
`create.mutateAsync`, which loops every year from the contract start and calls
`generate_invoices_for_year(..., p_include_past => true)`, then flips anything
past its due date to `overdue`.

So the delta is narrower and sharper:

> **Editing a contract reconciles nothing.** `update.mutateAsync` at
> `admin.contracts.tsx:266` writes the row and stops. Change `monthly_amount`,
> `start_date`, `end_date` or `due_day` and every already-generated invoice keeps
> the old figures forever.

And the one function that _does_ re-derive invoices —
`reapply_contract_invoices` (`37_concession_free_months_skip_and_reapply.sql`) —
**deletes and recreates**, which is the thing that must not happen.

## Why delete-and-recreate is unacceptable here

`payment_requests.requested_invoice_ids` is `uuid[] not null`
(`06_phase4_tenant_portal_gateway.sql:30`) **with no foreign key**. Nothing in
the database prevents those ids from going stale, and nothing reports it when
they do.

The failure is silent and costs real money:

1. A tenant opens the portal and starts a KNET payment. `createPayment.ts:221`
   writes a `payment_requests` row holding that invoice's UUID, status
   `pending`, and hands the tenant a MyFatoorah URL.
2. An admin edits the contract. `reapply_contract_invoices` deletes the unpaid
   invoice — it passes every current guard, because `paid = 0`, state is `due`,
   and no allocation exists yet. A _new_ invoice is inserted for the same period
   with a **new UUID**.
3. The tenant pays. `myfatoorahWebhook.ts:213` resolves
   `.in("id", requested_invoice_ids)` — the id is gone, so
   `orderedRequestInvoices` yields nothing.

Money arrives and is allocated against nothing. The invoice still reads unpaid.

The current guard is the right _shape_ — it protects settled money — but it has
a hole exactly the width of a pending payment request, which is the highest-risk
window there is.

---

## The engine: UPSERT-diff, extending what exists

`reapply_contract_invoices` already implements ~80% of the pattern and owns the
concession semantics. It is extended, not replaced.

For each period the contract should cover:

| Situation                                         | Action                              | Why                                                                                                 |
| ------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| should exist, does exist                          | **`UPDATE` totals/dates in place**  | the UUID survives, so allocations, receipts, notifications and pending payment links all stay valid |
| should exist, doesn't                             | `INSERT` via the existing generator | picks up concessions and invoice_items for free                                                     |
| should not exist, is clean                        | `DELETE`                            | `paid = 0`, no allocation, **no pending payment request**                                           |
| should not exist, carries money or a pending link | **`cancelled`**                     | a financial record is never destroyed; it is surfaced for manual reconciliation                     |

### The guard gains a third clause

```sql
and not exists (
  select 1 from public.payment_requests pr
  where pr.status = 'pending'
    and i.id = any (pr.requested_invoice_ids)
)
```

`payment_requests.status` is `text` checked against
`('pending','completed','failed','expired','cancelled')`. Only `pending` blocks:
a `completed` request has an allocation (already covered), and
`failed`/`expired`/`cancelled` links are dead anyway.

### What an in-place UPDATE may and may not touch

Only the derived money columns and the due date:
`subtotal`, `discount`, `total`, `due_date`. Never `paid`, never `state`, never
`code`, never `id`.

**Recomputing `paid` is how migration 52 destroyed data**: it wrote
`invoices.paid` directly with no backing allocations, and the next
`set_invoice_paid` recomputed `paid` from surviving allocations and silently
zeroed it. `paid` belongs to the payment engine. This function never writes it.

An invoice that is `paid` or `partially_paid` is **not** updated at all, even for
a period that should still exist. Retroactively changing the amount owed on an
invoice a tenant has already paid against is a reconciliation decision, not an
automatic one. Those rows are returned in a `skipped` set so the UI can say so.

---

## Where the permission check goes — the migration 52 trap, one layer deeper

The plan said "do not put the RBAC check inside the trigger". True, but
insufficient, because **the check is already inside the function**:

```sql
-- reapply_contract_invoices, and generate_invoices_for_year, and
-- backfill_contract_invoices all start with:
if auth.role() = 'authenticated'
  and not public.has_permission(auth.uid(), 'invoices.create') then
  raise exception 'Permission denied' using errcode = '42501';
end if;
```

An accountant holds `contracts.update` but **not** `invoices.create`
(`03_phase1_permissions_audit.sql:296-311`). So calling any of these from a
trigger on `contracts` would raise `42501` inside the accountant's contract save
and abort it — migration 52's exact failure, reintroduced through functions that
already existed.

**Decision: no trigger.** Regeneration is invoked from the server-fn boundary,
after the contract update succeeds, exactly as creation already does it. The
contract save and the reconciliation are separate operations with separate
permissions, and an accountant who may edit a contract but not mint invoices
gets their edit saved plus a clear "invoices were not regenerated" message —
rather than a save that fails for a reason that looks unrelated.

This also keeps the failure recoverable: an admin can re-run regeneration later.

---

## Scope boundary: this does not fill forward, and here is why that matters

`generate_invoices_for_year` skips any period after the current month when
`p_include_past` is set:

```sql
if p_include_past and v_period_start > date_trunc('month', current_date)::date
  then continue; end if;
```

and `backfill_contract_invoices` loops years only to
`least(current_year, end_year)`. So invoices exist **only up to the current
month**.

While verifying this I found something outside T15's scope that should be
recorded:

> **Nothing generates next month's invoices.** The cron registry
> (`src/fns/cronJobs.ts:23`) holds `overdue`, `overdue-reminders`,
> `contract-expiry`, `scheduled-reports`, `notification-drain`, `gmail-sync` —
> no invoice generation. The `generateInvoices` server function exists but has
> **zero callers anywhere in `src/`**, so there is not even a manual button.
> Combined with the separate finding that **no cron runs on production at all**,
> invoices advance only when someone creates or edits a contract.

C2 deliberately does **not** change this. Matching the existing horizon keeps the
diff about invoice identity, which is T15's actual point; generating a full
contract's worth of future invoices would move total receivables and change what
tenants see in the portal, which is a product decision, not a refactor. It is
called out here so it is not mistaken for something this batch fixed.

Regeneration therefore reconciles periods from the contract start through the
current month. Shortening a contract still correctly cancels or deletes periods
beyond the new end date, because those are periods that _exist_.

---

## Portal display limit — verified, no change needed

`companies.max_visible_unpaid_invoices` (default 6) already exists and is
enforced by `evaluate_portal_payable_invoices`. No new setting.

---

## Tests

SQL, because none of this is expressible against a mock.

| #   | Assertion                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | changing `monthly_amount` updates unpaid invoice totals                                                                                                                                                  |
| 2   | **invoice UUIDs are stable across regeneration** — assert the id set is unchanged, not merely the same size                                                                                              |
| 3   | **a pending `payment_request`'s invoice id still resolves after regeneration, and its total updated** — the discriminating test; UUID-set equality alone can pass if the diff regenerates the same count |
| 4   | a paid invoice is untouched by a `monthly_amount` change and reported as skipped                                                                                                                         |
| 5   | shortening the contract cancels (not deletes) an out-of-range invoice that carries an allocation                                                                                                         |
| 6   | shortening the contract deletes a genuinely clean out-of-range invoice                                                                                                                                   |
| 7   | an invoice with a **pending payment request** is cancelled, never deleted, even with `paid = 0` and no allocation                                                                                        |
| 8   | `invoices.paid` still equals `sum(payment_allocations.amount)` for confirmed payments afterwards                                                                                                         |
| 9   | free-month / concession behaviour from migration 37 survives regeneration                                                                                                                                |
| 10  | regeneration is idempotent — running it twice changes nothing the second time                                                                                                                            |
| 11  | an accountant editing a contract is **not** blocked, and gets no invoice regeneration                                                                                                                    |

Test 3 is the one that proves the design.

---

## Verification

1. `bun run lint && typecheck && test` — green
2. `bun run test:sql` — green including the 11 above
3. `bun run test:db` — clean provision with migration 55
4. Manual smoke: edit a contract's `monthly_amount`, confirm unpaid totals move
   and paid ones do not
