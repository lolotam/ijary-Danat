# Implementation plan — Admin UX batch, August 2026

Companion to `2026-08-19-admin-ux-batch.md`. Six batches, ordered so each one
lands on a green suite.

**Order is strictly A → B → C → E → D → F, one at a time.**

Batch A blocks everything. Batch D owns *all* of T4's numbering work and the
`common.rowNumber` key, so F — which reuses both — must follow it. And C and E
are not disjoint after all: both edit `src/lib/bulkImportSchemas.ts` and, like
every batch here, `src/i18n/dictionary.ts`. Two earlier drafts called batches
parallel that share files; the dictionary alone serialises the whole sequence,
so nothing here runs concurrently.

Gate on every batch: `bun run lint && bun run typecheck && bun run test`, then
the matching guard skill (`clean-code-guard` for production code, `test-guard`
for tests). A batch is not done until both are clean.

---

## Batch A — Schema (blocks everything else)

### A1 · `db/migrations/147_partial_payment_status.sql`

- `alter table public.partial_payments add column if not exists status text not
  null default 'incomplete' check (status in ('incomplete','complete'))`
- Index on `(invoice_id)` — the trigger and the T9 tab both filter on it.
- **Symmetric** trigger `after update on public.invoices`: when the row enters a
  paid state, set its linked partial payments to `complete`; when it leaves one,
  set them back to `incomplete`. No state the system can enter and not leave.
  - `security definer`, `set search_path = public` — the admin holds
    `invoices.update` but may not hold `partial_payments.update`, and RLS would
    otherwise skip the flip silently.
  - **`revoke execute on function … from public, anon`.**
    `src/db/anonExecute.sqltest.ts` is set-based and fails the whole suite for
    any anon-executable definer outside three named RLS helpers.
  - Tolerates `invoice_id is null`; the `where` clause handles it.
- Consistency trigger `before insert or update on public.partial_payments`:
  when both `invoice_id` and `contract_id` are set, the invoice must belong to
  that contract. Migration 56 gives the three FKs no relationship to each other,
  so without this a client can link another contract's invoice and the definer
  trigger above will then mutate it.
- Must not touch `get_budget_summary`. `refunds.sqltest.ts` asserts partial
  payments stay inert; that assertion is the guard against this migration
  drifting into the money path.

### A2 · `db/migrations/148_seed_bound_unit_types.sql`

Seeds the four `unit_types` values the T5 binding targets, through the existing
`public._seed_option_items` helper so it is idempotent and so an owner who later
deletes one is not fought by the migration:

```
commercial_unit_1st_floor / Commercial Unit 1st Floor / وحدة تجارية دور أول
commercial_unit_basment   / Commercial Unit Basment   / وحدة تجارية قبو
Roof_Apartment            / Roof Apartment            / شقة سطح
shop_G_Floor              / Shop G Floor              / محل دور أرضي
```

Values are copied **exactly** from production, misspelling and casing included —
they are the owner's data and changing them would orphan the 142 existing units.
The migration comment says so, so nobody tidies them later.

### A3 · `db/migrations/149_tenant_civil_ids_and_address.sql`

- `tenants.authorized_manager_civil_id text`
- `tenants.owner_civil_id text`
- `tenants.commercial_address text`
- Comment marking `owner_name` and `alternate_contacts` retired and unread by
  the application, kept for the one production row that still carries a name.
- **Re-issue `bulk_import_phase6`** (highest prior definition: migration 113).
  Its tenant branch still inserts `owner_name` and knows nothing of the three new
  columns, so a CSV import would silently drop everything the operator typed into
  them. Copy the live body forward and change only the tenant insert.

### A4 · `db/migrations/150_contract_rent_positive_and_insurance_delete.sql`

- `contract_units.monthly_amount` check tightens from `>= 0` to `> 0`. Verified
  against production first: zero rows violate it, so no data fix is needed.
- `delete_contract_insurance(p_contract_id uuid)` — `security definer`, deleting
  the contract's `insurance_payments` row and writing its `write_audit` entry in
  one transaction, returning whether a row was removed. Two browser round-trips
  would let the audit fail after the row is gone. Raises a **typed error code**,
  never a translation key. `revoke execute … from public, anon`, then grant to
  `authenticated`; the function checks `has_permission(auth.uid(),
  'insurance.delete')` itself, because a definer bypasses the RLS policy that
  would otherwise enforce it.

### A5 · `database.types.ts` by hand

Add the four columns to the `tenants` and `partial_payments` table definitions,
the `PartialPaymentStatus` union, **and the `delete_contract_insurance` entry
under `Database.public.Functions`** — without the last one a typed
`supabase.rpc("delete_contract_insurance", …)` does not compile, and A4's RPC is
unreachable from the client.

Hand-maintained despite appearing generated — `bun run gen:types` writes a
reference file and must not be copied over the real one.

### A6 · Verify

`bun run test:db` (builds a clean database from scratch) then `bun run test:sql`.
A1's triggers, A2's seed and A4's constraint are only provable on a clean
database. `anonExecute.sqltest.ts` is the gate on every new definer.

---

## Batch B — Unit form: T1 + T5

Files: `src/lib/unitForm.ts`, `src/lib/unitFloorTypeBinding.ts` (new),
`src/components/admin/UnitFormDialog.tsx`.

1. **T1** — `unitFormDefaults.type` becomes `""`. Nothing else changes; the
   stale-value hatch in `UnitFormDialog` stays, because it is correct for edit.
   Verify the Radix Select shows its placeholder rather than a blank row.
2. **T5 map** — new `src/lib/unitFloorTypeBinding.ts`:
   - `UNIT_FLOOR_TYPE_BINDING: Readonly<Record<string, string>>` — the four
     pairs.
   - `boundUnitTypeFor(floorValue: string | null): string | null`.
   - Doc comment in Arabic, plus the *why*: why a module and not a catalogue
     column, and the fact that the targets are seeded by migration 148.
3. **T5 order** — move the Floor field above Type in the dialog's JSX.
4. **T5 binding** — the rule is *derived from current form state*, not applied
   in a change handler, so it holds on open and on change alike:
   - `resolveUnitTypeBinding({ floor, activeTypeValues })` returns
     `{ boundType, locked }`. `locked` is true only when the floor has a binding
     **and** that target is present in the active catalogue.
   - An effect watching the resolved `boundType` calls `form.setValue("type", …)`
     whenever it differs. This covers the edit path: opening a unit whose floor
     is `roof` but whose type is stale corrects the field instead of rendering a
     disabled control still showing the old value — which is what a bare
     `onChange` handler would do, making the binding look applied while saving
     nothing.
   - The value goes through `form.setValue`, never left to the DOM — a disabled
     control does not submit.
   - Target missing from the catalogue (owner deleted it) → `locked: false`, Type
     stays editable, the existing stale-value hatch handles display. The failure
     mode is a free field, never a stuck empty one.
5. **Tests** — `src/lib/unitFloorTypeBinding.test.ts`:
   - each floor maps to its documented type;
   - an unknown floor and `null` return `null`;
   - `locked` is false when the target is absent from `activeTypeValues`;
   - **every target value appears in migration 148's seed** — read the SQL file
     and assert against it, so a rename in one place fails the suite.

---

## Batch C — Tenant fields: T2

Files: `src/lib/tenantForm.ts` (new — extracted), `src/routes/admin.tenants.index.tsx`,
`src/routes/admin.tenants.$id.index.tsx`, `src/lib/csvHeaders.ts`,
`src/lib/tenantCsv.ts`, `src/lib/bulkImportSchemas.ts`,
`src/lib/bulkImportTemplates.ts`, `src/i18n/dictionary.ts`.

0. **Extract first, as its own commit, with no behaviour change.**
   `admin.tenants.index.tsx` is 1380 lines. Move the schema, defaults,
   edit-reset and submit payload into `src/lib/tenantForm.ts`; the form dialog
   into `src/components/admin/tenants/TenantFormDialog.tsx`; the list table into
   `src/components/admin/tenants/TenantsTable.tsx`. One extraction alone would
   leave the route at ~1230 lines — still over the ceiling, which is the whole
   point of doing this. Only then apply T2.
1. Schema: drop `owner_name` and `alternate_contacts`; add
   `authorized_manager_civil_id`, `owner_civil_id`, `commercial_address` — all
   plain `z.string()`. The JSON-array refinement goes with `alternate_contacts`.
2. Defaults and the `editing` reset path follow.
3. Field placement: `owner_civil_id` immediately after `name` / `name_en`;
   `authorized_manager_civil_id` where `owner_name` was, beside
   `authorized_manager`; `commercial_address` where the JSON textarea was, still
   full-width, still `multiline`.
4. Submit payload writes the three new columns and stops writing the two old
   ones.
5. Detail page `InfoField` at `:233` swaps to the two civil IDs plus the address.
6. CSV export headers + row builder, and the bulk-import schema + template, swap
   in the same three columns.
7. i18n keys in **both** locales:
   `tenants.authorizedManagerCivilId` = رقم مدني للمفوض / Auth. Manager Civil ID,
   `tenants.ownerCivilId` = رقم مدني للمالك / Owner Civil ID,
   `tenants.commercialAddress` = العنوان التجاري / Commercial Address.
8. Update `src/lib/tenantCsv.test.ts` for the new column set, and add
   `src/lib/tenantForm.test.ts` covering the submit payload's new columns and
   the absence of the two retired ones.
9. **SQL round-trip test** for the re-issued `bulk_import_phase6`: import a
   tenant row carrying the three new columns and assert they land. Without it
   A3's re-issue is unverified and a dropped column looks exactly like a
   successful import.

---

## Batch D — Invoice tables: T3 + T4 + T10

Files: `src/routes/admin.invoices.tsx`,
`src/components/admin/invoices/InvoicesTable.tsx` (new, extracted),
`src/components/admin/tenant-detail/InvoiceRowsTable.tsx`,
`src/components/admin/tenant-detail/ContractTabPanel.tsx`,
`src/components/admin/tenant-detail/TenantWideTabs.tsx`,
`src/components/admin/MarkInvoicePaidDialog.tsx`,
`src/components/admin/BulkMarkPaidBar.tsx` (new),
`src/lib/invoiceBulkSelection.ts` (new).

**This batch owns every T4 numbering change and the `common.rowNumber` key**,
including the two payment tables in `ContractTabPanel` and `TenantWideTabs`.
Batch F reuses both and must not redefine either.

1. **T10 first** — one line: `InvoiceRowsTable`'s `useTableSort` gets
   `{ key: "due_date", direction: "asc" }`. Land it before the numbering column
   so the interaction is visible.
2. **T4** — leading `#` column on `InvoiceRowsTable`, on `ContractTabPanel`'s
   payments table and on `TenantWideTabs`' payments table. Render index over the
   *sorted* rows, non-sortable header, `text-muted-foreground` and narrow.
3. **Selection rules as a pure module** — `src/lib/invoiceBulkSelection.ts`:
   - `isBulkSettleable(invoice)` → `state` is one of `due`, `overdue`,
     `partially_paid`. Explicitly **not** "anything not paid": that admits
     `cancelled` and `waived`, and `set_invoice_paid` checks only the balance
     before overwriting the state, so a select-all would resurrect a cancelled
     invoice and book a real payment against it.
   - `orderForBulkSettle(invoices)` → sorted by
     **`(period_year, period_month)`** ascending, *not* `due_date`. Migration
     129 compares that tuple precisely so that "January always precedes February
     regardless of due_date quirks"; sorting by due date would submit February
     first on an irregular schedule and the RPC would refuse it.
   - Both unit-tested, including the cancelled/waived exclusions and a
     due-date-versus-period case where the two orders disagree.
4. **T3 bar** — `BulkMarkPaidBar`, modelled on `BulkDeleteBar`:
   - takes the selected invoices (not just ids — it needs `due_date` and `code`),
     a `markOne(invoice, reason) => Promise<boolean>`, and a `clear()`;
   - opens `MarkInvoicePaidDialog` once, with `selectedCount` set;
   - **submits through `orderForBulkSettle`** — migration 129 refuses to settle
     an invoice while an earlier period on the same contract is still payable,
     so submitting out of period order makes invoices fail for a reason the
     admin cannot see;
   - **counts on the returned boolean, not on rejection.** `BulkDeleteBar` counts
     a failure when its callback rejects, but both existing `runTogglePaid`
     callers catch and resolve `false` (`InvoiceRowsTable.tsx:151`,
     `admin.invoices.tsx:361`). Copying the reject-based loop would report every
     failure as a success — the single most likely silent bug in this batch;
   - collects failed codes and reports them by name, never a bare count.
5. **T3 selection** — checkbox column on both tables, gated on
   `isBulkSettleable`. Header checkbox selects every selectable row on the page,
   indeterminate when partial. Selection clears on page/filter change.
6. **`MarkInvoicePaidDialog`** — optional `selectedCount?: number`. When set the
   description uses `invoices.markPaidBulkDescription` with the count; otherwise
   unchanged. Its existing test file covers the single-invoice path; add the
   bulk description case.
7. **Extract** — `admin.invoices.tsx` is at 1215 lines and gains selection
   state. Two moves, both pure and committed before the feature work: the table
   (header, rows, row actions, selection) into
   `src/components/admin/invoices/InvoicesTable.tsx`, and the send / KNET-link /
   print / detail dialogs into
   `src/components/admin/invoices/InvoiceDialogs.tsx`. The route keeps filters,
   KPIs and data fetching, and lands near 500 lines.
8. i18n, both locales: `invoices.markPaidBulk`, `invoices.markPaidBulkDescription`
   (with `{count}`), `invoices.markPaidBulkPartialFailure` (with `{codes}`),
   `common.rowNumber` (`#`).
9. Tests: a chronological cascade — two invoices on one contract, the older one
   refused, asserting the newer one is reported as failed rather than silently
   counted `ok`.

---

## Batch E — Contracts: T6 + T7

Files: `src/lib/contractForm.ts` (new — extracted),
`src/hooks/useContractInsurance.ts` (new — extracted),
`src/routes/admin.contracts.tsx`, `src/components/admin/ContractUnitsField.tsx`,
`src/hooks/useContracts.ts`, `src/i18n/dictionary.ts`.

1. **Extract first, as its own commit, with no behaviour change.**
   `admin.contracts.tsx` (1316) → `src/lib/contractForm.ts` (schema, defaults),
   `src/components/admin/contracts/ContractFormDialog.tsx`,
   `src/components/admin/contracts/ContractsTable.tsx`.
   `useContracts.ts` (756) → `src/hooks/useContractInsurance.ts` (the mirror) and
   `src/hooks/useContractRelations.ts` (units, concessions). Pulling only the
   ~90-line insurance hook would leave that file at ~660, still over. The
   extraction is also what makes T6 assertable without rendering a route.
2. **T6** — in `contractForm.ts`, the `units` array's `monthly_amount` becomes a
   positive variant of `numberField`. `deposit: numberField(0)` is left alone; a
   zero deposit is legitimate and T7 depends on it.
   - `ContractUnitsField` renders **no nested field error today**, so a Zod
     message on `units[i].monthly_amount` currently goes nowhere. Wire the
     per-row error under the offending input, and set `min="0.001"`.
   - The database is tightened in migration 150 and the bulk-import contract
     schema (`bulkImportSchemas.ts:207`) follows. A form rule alone leaves three
     other writers accepting zero.
3. **T7** — `useSyncContractInsurance` return type widens to include
   `"deleted"`. When `amount <= 0`:
   - no existing row → `"unchanged"` (today's behaviour, still correct);
   - **the delete fires on a transition, not on a value.** Only when the
     contract's insurance went from positive **to** zero — the mutation takes the
     previous amount and compares. The Insurance panel authors rows
     independently of `contracts.deposit`, so deleting whenever the field merely
     *reads* zero would destroy a hand-entered holding on an unrelated save;
   - a row exists and the transition happened → call the
     `delete_contract_insurance` RPC from migration 150, which deletes and audits
     in one transaction, and return `"deleted"`.
   - **No refund guard.** The earlier draft's "refuse if a refund exists" is
     dropped: `refunds` has no insurance-specific type so an ordinary rent refund
     would block it, and `reverse_refund` preserves the original row
     (`refundReversal.sqltest.ts`) so the condition could never be cleared. A
     guard that cannot be satisfied is worse than none.
   - The RPC's typed error code maps to `contracts.insuranceDeleteFailed` at the
     caller. Never raise a translation key from SQL.
   - Invalidate `["insurance_payments"]` and `["budget"]` as the other branches
     do.
   - The doc comment's "**Never deletes**" paragraph is rewritten, not left
     contradicting the code: it keeps the accounting reason on record — that
     `get_budget_summary` recomputes `insurance_collected` from live rows, so a
     delete retroactively changes a reported month — and states that the product
     decision overrode it.
4. i18n, both locales: `contracts.insurance.deleted`,
   `contracts.insuranceDeleteFailed`, `contracts.monthlyAmountPositive`.
5. Tests:
   - `contractForm.test.ts` — the schema rejects a zero and a negative monthly
     amount, and accepts a zero deposit. Asserted against the exported schema
     directly, because the `createServerFn` mock never runs validators.
   - `useContractInsurance.test.ts` — zero deletes via the RPC, zero with no row
     is `"unchanged"`, 3500→4000 still updates.
   - SQL: `delete_contract_insurance` writes its audit row, refuses without
     `insurance.delete`, and is not anon-executable.

---

## Batch F — Partial payments: T8 + T9  *(runs after Batch D)*

Files: `src/components/admin/PaymentSidePanels.tsx`,
`src/components/admin/RecordPanelTable.tsx` (new, extracted),
`src/hooks/useRefunds.ts`, `src/hooks/useInvoices.ts`,
`src/components/admin/tenant-detail/ContractTabPanel.tsx`,
`src/components/admin/tenant-detail/TenantWideTabs.tsx`,
`src/i18n/dictionary.ts`.

1. **Scoped reads** — `useMoneyRecords(table, enabled, scope?)` where scope is
   `{ contractId }` or `{ tenantId }`. Applied as a PostgREST filter, in the
   query key too. Unscoped calls keep today's behaviour.
2. **Unpaid invoices for a contract** — a small hook (or a parameter on
   `useInvoices`) returning invoices for one contract with balance > 0 and state
   not `paid`/`waived`, for the form's dropdown.
3. **`RecordPanel`** gains:
   - optional `invoiceField` support — the Invoice select appears only for
     partial payments, driven by the chosen contract, cleared when the contract
     changes;
   - optional `statusField` — Complete / Incomplete, default Incomplete,
     **disabled whenever an invoice is selected**. For a linked row the database
     computes the value on write (migration 147's link guard); an editable
     control there would let an admin close a row against a still-due invoice
     and then be unable to reopen it;
   - an `Invoice` column rendering the code as a link to
     `/admin/invoices?year=&month=` for that invoice's period, and a `Status`
     column;
   - rows that are `complete` **and** carry an `invoice_id` rendered
     `opacity-60` with Edit and Delete disabled. A `complete` row with no linked
     invoice stays editable: nothing overruled the admin there, and locking it on
     save would make the status a one-way door;
   - a `scope` prop threading through to `useMoneyRecords` and pre-filling the
     create form's contract/tenant; when the scope is a tenant with **no**
     contracts, the create action is hidden — `RecordPanel` needs a contract to
     build a valid row, and offering a button that cannot succeed is worse than
     omitting it;
   - the T4 numbering column, reusing Batch D's `common.rowNumber` key.
4. **Extract** — `PaymentSidePanels.tsx` is at 660 lines and gains all of the
   above. Two pure moves first: the table (header, rows, row actions) into
   `RecordPanelTable.tsx`, and the create/edit dialog into
   `RecordPanelDialog.tsx`. The panel keeps state, mutations and the three thin
   exported wrappers.
5. **T9 tab** — "المدفوعات الجزئية" / "Partial payments" tab in
   `ContractTabPanel` (scoped by `contract_id`) and in `TenantWideTabs` (scoped
   by `tenant_id`), both rendering `PartialPaymentsPanel` with the scope prop.
   - `admin.tenants.$id.index.tsx` passes `archiveMode: "all"` to `useContracts`.
     The default `"current"` gives an archived contract no tab, which would make
     every partial payment attached to it unreachable from the tenant page — and
     a tenant *history* page should show archived contracts regardless of this
     tab.
6. i18n, both locales: `partialPayments.invoice`, `partialPayments.status`,
   `partialPaymentStatus.complete`, `partialPaymentStatus.incomplete`,
   `partialPayments.pickInvoice`, `partialPayments.noUnpaidInvoices`,
   `partialPayments.lockedHint`.
7. Tests: the status flip belongs to the SQL suite (`bun run test:sql`) —
   - a partial payment linked to an invoice, the invoice marked paid, status
     asserted `complete`;
   - the same invoice reverted to unpaid, status asserted back to `incomplete`
     (the symmetric half; without this test the reversal path is unproven);
   - a row with `invoice_id is null` left untouched throughout;
   - the consistency trigger rejects a partial payment linking an invoice from a
     different contract;
   - `refunds.sqltest.ts`'s existing inertness assertions still pass — the status
     column must not pull partial payments into the budget.

   Component tests cover the locked row's disabled actions, the *unlocked*
   unlinked-complete row, and the invoice dropdown filtering to unpaid only.

---

## Landing sequence

1. Batches A–F merged into the branch, each with its gates and guards green.
2. `bun run lint && bun run typecheck && bun run test && bun run test:sql`
   across the whole branch.
3. `pg_dump` production, then apply 147 → 148 → 149 → 150 to
   `danatfuture-supabase-ozoxsa-db-1` over `ssh-danatfuture-mcp`, checksummed
   against the local files, then `notify pgrst, 'reload schema'`.
   **Before** the merge — Dokploy deploys on merge and deploys code only.
4. Open the PR referencing the spec; wait for the review bots; apply findings;
   re-run gates and guards.
5. Merge. The merge is a production deploy.

## Risks held open

- **T7 retroactively changes a reported month's `insurance_collected`.**
  `get_budget_summary` recomputes it from live rows, so deleting a holding
  lowers the figure for the month it was collected in and any report already
  printed for that month stops reproducing. Accepted by the product decision;
  mitigated by the atomic audit row, not prevented. The refund guard an earlier
  draft proposed was dropped as unsatisfiable, not as unnecessary.
- **T5's map breaks if the owner edits a catalogue *value*.** The binding falls
  back to a free Type field rather than an empty locked one, so the failure is
  degraded rather than broken. The seed test catches a rename made in code.
- **T3 partial failures on chronological order.** Mitigated by sorting the
  selection oldest-first and by naming the failed codes.
