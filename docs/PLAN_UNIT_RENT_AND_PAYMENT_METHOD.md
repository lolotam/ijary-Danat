# Implementation plan — contract-driven unit rent, and payment-method integrity

Companion to `SPEC_UNIT_RENT_AND_PAYMENT_METHOD.md`. Ordered so that every step
is independently verifiable and nothing reaches production ahead of its schema.

Branch: `feat/unit-rent-and-payment-method` (off `main`).

---

## Step 1 — Migration 159: enum value, catalog item, re-issued RPC

**File:** `db/migrations/159_manual_payment_method.sql`
(confirm `159` is free with `ls db/migrations | sort -V | tail` before writing)

1. `alter type public.payment_methods add value if not exists 'audit_adjustment';`
   — must be the first statement; a new enum value cannot be cast into an
   enum-typed column inside the transaction that adds it.
2. Insert `audit_adjustment` into the `payment_methods` **option list** so it
   appears in the Add Payment dropdown. Guard with `on conflict do nothing`
   scoped to the list — a re-run must not resurrect an item an admin disabled.
3. Re-point `manual_payment_reasons.audit_adjustment` metadata from
   `{"payment_method": "cash"}` to `{"payment_method": "audit_adjustment"}`, and
   `complete_partial_payment` from `cash` to `cash` (unchanged — a complete or
   partial payment genuinely is cash unless the admin says otherwise; see debate
   question 1).
4. **`drop function` then `create function`** for `set_invoice_paid`, re-issued
   from the **migration 129** body, taking the method directly and keeping the
   reason-list lookup as the fallback path. `create or replace` cannot change a
   signature — it would leave the three-argument version in place as an overload,
   and a three-argument call would then match both, which PostgREST rejects as
   ambiguous. The drop also drops the grants, so they must be re-issued
   explicitly (migration 142 broke `anon` by forgetting exactly that).
5. Update the `comment on column public.invoices.manual_payment_reason` to say
   what it now holds.

**Verify:** `bun run test:sql` — 48 files / 432 tests, and the migration set must
apply to a clean database in order.

## Step 2 — `set_invoice_paid` signature and callers

**Files:** `src/fns/setInvoicePaid.ts`, `src/fns/setInvoicePaid.test.ts`

Thread the chosen method through the server function. Keep the existing
`p_manual_payment_reason` parameter so no caller breaks mid-deploy; add the
method as the authoritative input when present.

**Verify:** `bun run test` for the `setInvoicePaid` suite.

## Step 3 — `MarkInvoicePaidDialog` reads the payment-method catalog

**Files:** `src/components/admin/MarkInvoicePaidDialog.tsx`,
`MarkInvoicePaidDialog.test.tsx`

Switch the list source from `manual_payment_reasons` to the same
`payment_methods` option list `admin.payments.tsx:182` already uses, so the two
dropdowns are identical by construction rather than by convention. Callers:
`BulkMarkPaidBar`, `InvoiceRowActions`, `InvoiceMonthRowActions`, `InvoicesTable`,
`InvoiceRowsTable`, `electricity/ChargesTab`.

**Verify:** existing dialog tests plus a new case asserting the option source.

## Step 4 — Types, i18n, and the Add Payment form

| File | Change |
| --- | --- |
| `src/integrations/supabase/database.types.ts` | add `audit_adjustment` to the `PaymentMethod` union, **by hand** |
| `src/i18n/` (ar + en) | `paymentMethod.audit_adjustment` in **both** — `dictionary.test.ts` fails on a one-sided key |
| `src/routes/admin.payments.tsx:110,115` | hardcoded fallback array + Zod enum gain the value |

**Verify:** `bun run typecheck`, then `bun run test` (dictionary parity).

## Step 5 — Gateway methods render as "Payment link"

**Files:** `src/routes/admin.payments.tsx` (table cell + card field),
plus wherever the invoice method column renders.

A single display helper maps `knet | card | applepay | googlepay → payment_link`
for labelling only. Stored data is untouched; reconciliation still sees the real
instrument.

**Verify:** unit test on the helper covering each gateway method, each non-gateway
method passing through unchanged, and `null`.

## Step 6 — Unit rent field becomes read-only under an active contract

**Files:** `src/components/admin/UnitFormDialog.tsx`,
`src/routes/admin.units.index.tsx`, `src/routes/admin.units.$id.tsx`

1. New prop `activeContractRent: number | null`.
2. When non-null: field disabled, displays that value, and `default_rent` is
   omitted from the submit payload.
3. Parent resolves it as the active contract's
   `units.find(u => u.unit.id === unitId).monthlyAmount` — per-unit, never
   `contracts.monthly_amount`. Ties broken by most recent `start_date`.

**Verify:** new tests for the resolver — no active contract, single-unit contract,
multi-unit contract (must not return the total), two overlapping active contracts.

## Step 7 — Guards and gates

- `clean-code-guard` over every production file touched.
- `test-guard` over every test written or edited.
- `bun run typecheck`, `bun run test`, `bun run test:sql`, scoped `eslint`.

## Step 8 — Apply the migration to production, then merge

1. Merge delivers the file to Dokploy's checkout; concatenate **only** migration
   159 there, checksum it against the local file.
2. Apply over `ssh-danatfuture-mcp` to `danatfuture-supabase-ozoxsa-db-1` with
   `ON_ERROR_STOP=1`.
3. `notify pgrst, 'reload schema'` — without it the re-issued RPC 404s.
4. `pg_dump` first; schema changes are not reversible.
5. Migration applies **before** the merge, because the merge auto-deploys.

---

## Risk register

| Risk | Mitigation |
| --- | --- |
| New enum value invisible in the dropdown | Step 1.2 inserts the option-list item; production has 5 items, so the list is authoritative |
| Re-issued RPC 404s after deploy | `notify pgrst` in step 8.3 |
| Dictionary parity failure | Step 4 adds both locales in one commit |
| `gen:types` clobbering hand-maintained types | Never run it; edit `database.types.ts` by hand |
| `rent_potential` diverging from the displayed rent | Accepted and documented as a non-goal in the spec |
| Mid-deploy callers passing the old reason argument | `set_invoice_paid` keeps the reason parameter and its fallback |
