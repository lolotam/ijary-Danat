# Admin UX batch — August 2026

Ten changes to the admin surface: two verified bug fixes, one validation
tightening, and seven feature additions across Units, Tenants, Invoices and
Payments.

Written 2026-08-19. Branch `feat/admin-ux-batch-aug19`.

---

## Context established before writing this

Read live from production (`ssh-danatfuture-mcp` →
`danatfuture-supabase-ozoxsa-db-1`) rather than assumed:

```
unit_floors|basement|Basement|true
unit_floors|first|First floor|true
unit_floors|ground|Ground floor|true
unit_floors|roof|Roof|true
unit_types|commercial_unit_1st_floor| Commercial Unit 1st Floor|true
unit_types|commercial_unit_basment|Commercial Unit Basment|true
unit_types|Roof_Apartment|Roof Apartment|true
unit_types|shop_G_Floor| Shop G Floor|true
```

```
units=142  contracts=2  invoices=117  partial_payments=0  insurance_payments=2
tenants=1  (owner_name set on 1, alternate_contacts set on 0, authorized_manager set on 1)
```

Three facts this changes:

- The four unit types the owner created carry hand-typed values — a leading
  space in two labels, `basment` misspelt, `Roof_Apartment` mixed-case. Any code
  that names them must treat them as data, not as identifiers it controls.
- Those four rows exist **only in production**. A database built by
  `bun run test:db` has none of them, so anything depending on them must seed
  them or it is untestable.
- `partial_payments` is empty and `alternate_contacts` is unused. Both can
  change shape with no migration risk.

---

## T1 — Unit type dropdown shows 5 options against 4 catalogue rows

### Root cause (verified, not inferred)

`src/lib/unitForm.ts:47` sets `unitFormDefaults.type = "apartment"`, a value left
over from the pre-migration-103 enum. `UnitFormDialog.tsx:93-97` then runs:

```ts
if (typeValue && !unitTypeMapped.some((option) => option.value === typeValue)) {
  unitTypeMapped.push({ value: typeValue, label: typeValue });
}
```

That escape hatch exists so an existing unit carrying a retired type stays
editable without the form silently rewriting it. On the **add** form there is no
existing unit — the hatch fires against the hardcoded default and appends a
fifth option labelled with its raw value.

The display fault is the smaller half. `apartment` is also *pre-selected*, so an
admin who fills in the rest of the form and saves without touching Type writes an
off-catalogue value onto a real unit. Migration 103 additionally leaves
`units.type` with a database-level `default 'apartment'`, so any insert path that
omits the column writes it too.

### Fix

- Drop `type` from `unitFormDefaults` (empty string). The Radix Select renders
  its placeholder and `unitFormSchema`'s `min(1)` blocks a save with no type —
  which is the correct behaviour, not a regression.
- Keep the stale-value hatch. It is right for edit; it was only ever wrong
  because a create had a value it should not have had.
- Leave the database default in place. Removing it would break any insert path
  that relies on it (`bulk_import_phase6`); the form no longer reaches it.

### Acceptance

Add-unit form offers exactly the active `unit_types` rows and nothing else, with
no pre-selection. Editing a unit whose type is absent from the catalogue still
shows that type.

---

## T2 — Tenant form: civil-ID fields and a real commercial address

### What changes

| Current field | Becomes |
| --- | --- |
| `owner_name` — "اسم المالك" | retired from the UI |
| — | **`authorized_manager_civil_id`** — "رقم مدني للمفوض" (auth-Mang-CI) |
| — | **`owner_civil_id`** — "رقم مدني للمالك" (Owner CI), placed directly after the Arabic/English name fields |
| `alternate_contacts` — "Alternate contacts (JSON Array)" | **`commercial_address`** — "العنوان التجاري" / "Commercial Address", plain text |

### Why new columns rather than relabelling the old ones

`owner_name` holds a person's name on the one tenant row in production;
relabelling it "civil ID" would leave a name sitting in a civil-ID field forever.
`alternate_contacts` is worse — it is validated as `JSON.parse(value)` must be an
array and stored as `Json`. Calling it "Commercial Address" while it still
demands `["…"]` would be a trap for the operator on their first save.

Both legacy columns stay in the database, documented as retired and unread.
Dropping them is irreversible and buys nothing.

Also note `authorized_manager` already exists as its own column and renders
directly above. The new civil-ID field sits beside it, not in place of it.

### Every place that has to move together

- form schema + defaults + fields (`src/routes/admin.tenants.index.tsx`)
- detail page `InfoField` (`admin.tenants.$id.index.tsx:233`)
- CSV export headers and row builder (`src/lib/csvHeaders.ts`,
  `src/lib/tenantCsv.ts`)
- bulk-import schema and template (`src/lib/bulkImportSchemas.ts`,
  `src/lib/bulkImportTemplates.ts`)
- **`bulk_import_phase6`** — the tenant branch of this RPC still inserts
  `owner_name` and knows nothing of the new columns (migration 113). Changing the
  client-side template alone would give an import that silently drops every value
  the operator typed into the three new columns. Migration 149 re-issues the
  whole function.
- `database.types.ts` — hand-maintained, hand-edited

Missing any one of these leaves the CSV disagreeing with the form.

### Acceptance

Add-tenant form shows the two civil-ID fields and a plain-text Commercial
Address. No JSON validation error is reachable. Export and re-import round-trips
the new columns.

---

## T3 — Bulk mark-as-paid with one shared reason

### Surfaces

- `/admin/invoices?year=&month=` (monthly invoice table)
- Tenant detail → contract → Invoices tab (`InvoiceRowsTable`, shared by
  `ContractTabPanel` and `TenantWideTabs`)

### Design

Row checkboxes plus a header select-all, over **settleable rows only**:
`due`, `overdue`, `partially_paid`. Not "anything that isn't paid" — that
phrasing lets `cancelled` and `waived` through, and `set_invoice_paid` checks
only the balance before overwriting the state with `paid`. Ticking select-all on
a month containing a cancelled invoice would resurrect it and create a real
payment against it.

A selection bar appears with the count and a "Mark selected paid" action,
following `BulkDeleteBar`'s established shape (sequential calls, `ok`/`fail`
counts reported at the end).

`setInvoicePaidSchema` takes a single `invoiceId`. Rather than add a batch RPC,
the bar loops the existing server function — one call per invoice, one shared
reason collected once.

**Order matters, and the key is not the due date.** Migration 129
(`set_invoice_paid_chronological`) refuses to settle an invoice while an earlier
one on the same contract is still payable — and it compares
**`(period_year, period_month)`**, with the migration saying why in as many
words: *"Compared as (year, month) so January always precedes February
regardless of due_date quirks."*

So the bulk loop submits ordered by that same period tuple. Sorting by
`due_date` would look right and still fail: an irregular due date puts February
ahead of January, the RPC refuses February, and the admin sees a failure they
did nothing to cause. A partial failure reports which codes failed — never a
bare `3 failed`.

**Failure accounting must not inherit the existing swallow.** Both current
`runTogglePaid` callers catch their error and resolve `false`
(`InvoiceRowsTable.tsx:151`, `admin.invoices.tsx:361`), while `BulkDeleteBar`'s
loop counts a failure only when its callback *rejects*. Reusing that loop shape
with a resolving callback would report every failure as a success. The bulk bar's
`markOne` is therefore typed `Promise<boolean>` and the loop counts on the
returned flag, not on rejection.

`MarkInvoicePaidDialog` gains an optional `selectedCount`. When set, its
description reads "N invoices" instead of a single code; the reason control is
unchanged.

### Acceptance

Selecting three settleable invoices, choosing one reason once, marks all three
and creates three payments. A chronological refusal names the invoice codes it
refused, and the count reported reflects it. A cancelled invoice cannot be
selected.

---

## T4 — Row numbering on the tenant detail tables

A leading `#` column on:

- the monthly invoices table (`InvoiceRowsTable`)
- the payments table inside `ContractTabPanel`
- the payments table inside `TenantWideTabs` (same question, same page)

The number is the **render index** — it renumbers when a column is sorted, which
is what a positional counter should do. It is deliberately not derived from
anything persistent; there is no row-number column in the database and inventing
a stable one would imply an ordering the data does not have.

The header cell is not sortable.

---

## T5 — Floor drives unit type

### Field order

Floor moves **above** Type in the add/edit unit form.

### Binding

| Floor value | Unit type value | Label the owner sees |
| --- | --- | --- |
| `first` | `commercial_unit_1st_floor` | Commercial Unit 1st Floor |
| `basement` | `commercial_unit_basment` | Commercial Unit Basment |
| `roof` | `Roof_Apartment` | Roof Apartment |
| `ground` | `shop_G_Floor` | Shop G Floor |

Selecting a bound floor sets Type in form state and renders the Type control
**disabled**. Selecting an unbound floor (or none) leaves Type a normal editable
dropdown, keeping whatever was there.

The value is written into form state, never left to the DOM: a disabled control
does not submit. `resolvePropertyFieldState` in this same file exists because
that exact trap already bit this form once.

Two conditions that a naive "on floor change" handler gets wrong:

- **It must also run on open.** Opening an existing unit whose floor is `roof`
  but whose type is something else would otherwise render a *disabled* control
  still showing the old type, which then saves unchanged — the binding would
  look applied and do nothing. The sync runs on the form reset that `open`
  triggers, not only on the change event.
- **It must only lock when the target actually exists.** If the owner deletes
  `Roof_Apartment` from Settings → Lists, a locked select pointing at a missing
  option renders empty and cannot be corrected. So the binding applies only when
  its target is present in the active catalogue; otherwise Type stays editable
  and the existing stale-value hatch handles the display. The failure mode is a
  free field, never a stuck one.

### Where the map lives, and why not in the database

A pure module, `src/lib/unitFloorTypeBinding.ts`, holding one
`Record<string, string>` — the same shape as the existing
`src/lib/enumBackedOptionLists.ts`, which is this repo's established answer to
"code has to know a few catalogue values".

The alternative considered and rejected was a self-referential
`implies_item_id` column on `option_list_items`. It needs a column, a migration,
a new control in the Settings → Lists editor and its own tests — and it does not
actually protect against the thing that would break the binding, which is the
owner editing a *value* by hand. Four magic strings in a tested module, or four
magic strings behind a generic FK and an editor screen: the second is more
machinery for the same exposure. If a fifth floor ever needs a binding, that is
the moment to make it data-driven.

### The seed is not optional

Migration **148** seeds those four `unit_types` rows idempotently, via the
existing `public._seed_option_items` helper. Without it the four values exist
only in production, the binding points at nothing on any freshly built database,
and the locked Type control renders empty — a fault `bun run test:db` would
never catch because the test database has none of the rows.

A unit test asserts every target in the map is present in the seed. That test is
the thing that keeps the map honest as the catalogue changes.

---

## T6 — Contract monthly amount must exceed zero

`src/routes/admin.contracts.tsx:160` validates per-unit rent as
`numberField(0)` — `z.number().min(0)`, which accepts `0`. A contract with a
zero monthly amount generates zero-value invoices for its whole term.

Change to `.positive()` for the units array only. `deposit: numberField(0)`
stays as it is — a zero deposit is legitimate and T7 depends on it being
settable to zero.

**A form rule alone does not make the invariant true.** Three other writers
accept zero today:

- `contract_units.monthly_amount` is constrained `>= 0` (migration 110);
- `save_contract_with_units` performs no positivity check;
- the bulk-import contract schema accepts zero
  (`src/lib/bulkImportSchemas.ts:207`).

So the check constraint tightens to `> 0` in migration 150 and the bulk-import
schema follows. Verified against production before writing this: **zero rows in
`contract_units` and zero contracts currently hold a non-positive monthly
amount**, so the tightened constraint applies without a data fix.

**The message has to be visible.** `ContractUnitsField` renders the per-unit
amount inputs itself and displays no nested field error — a Zod message on
`units[i].monthly_amount` currently goes nowhere. The field renders the error
under the offending row's input, and the input's `min` follows.

---

## T7 — Zeroing a contract's insurance deletes the holding

### Current behaviour, and why it is the way it is

`useSyncContractInsurance` (`src/hooks/useContracts.ts`) early-returns
`"unchanged"` when the amount is `<= 0`. Its doc comment states the reason
plainly: `get_budget_summary` has already counted that row into a past period's
`insurance_collected`, and deleting it rewrites a closed month.

**The concern, stated once, and the decision.** The rationale is real and worth
naming precisely: `get_budget_summary` does not read a stored historical figure,
it **recomputes** `insurance_collected` from the rows that exist at query time
(migration 56). Deleting a holding therefore does not just stop counting it from
today — it retroactively lowers the insurance figure of the month it was
collected in, and any report already printed for that month will no longer
reproduce. An audit row records who did it; it cannot make the old number come
back.

The requested behaviour is nonetheless explicit — zeroing the field must delete
the record — and that is what this implements. The mitigation is traceability,
not prevention.

### What is *not* done, and why

An earlier draft guarded the delete by refusing when a `refunds` row referenced
the same contract. That guard is unimplementable as stated and is dropped:

- `refunds` carries no insurance-specific type, so an ordinary rent refund would
  block the delete for no reason;
- `reverse_refund` *preserves* the original row and writes a reversal beside it
  (`src/db/refundReversal.sqltest.ts`), so "reverse the refund first" would never
  clear the condition — the guard would be permanent.

A guard that cannot be satisfied is worse than none. The delete is unconditional.

### The delete fires on a transition, not on a value

`unique (contract_id)` means there is only ever one holding per contract, but it
does **not** make the contract form that row's only author: the Insurance panel
creates and deletes rows directly, without touching `contracts.deposit`. So a
holding entered by hand for a contract whose deposit field reads `0` would be
destroyed the next time anyone opened that contract and pressed Save — a
deletion nobody asked for, triggered by an unrelated edit.

The rule is therefore a **transition**, not a state: the delete runs only when
the contract's insurance goes from a positive value **to** zero. A contract
already sitting at zero does nothing on save, whatever rows exist beside it.
Reconciling the two authoring surfaces properly is real work and is named in
Out of scope; this keeps the feature from causing damage in the meantime.

### New behaviour

Changing a contract's insurance from a positive amount to `0` (or blank) deletes
that contract's `insurance_payments` row. No row, or no transition →
`"unchanged"`, as today.

The delete runs inside a `security definer` RPC, `delete_contract_insurance`,
which removes the row and writes its audit entry through `write_audit` in one
transaction. Two browser round-trips would let the audit fail *after* the row is
gone — leaving exactly the untraceable deletion this section promised not to
create — and would surface as an error on an operation that had already
succeeded. This follows `close_out_contract` and `erase_all_data`, which
CLAUDE.md names as the precedent for multi-table money not committing without
its audit row.

The RPC raises a typed error code, never a translation key. The caller maps the
code to `contracts.insuranceDeleteFailed`; raising the key itself would print a
raw `contracts.…` string in the toast if it ever reached the user.

The mutation gains a `"deleted"` outcome alongside `created` / `updated` /
`unchanged`. `admin.contracts.tsx:473` renders
`t(\`contracts.insurance.${outcome}\`)`, so `contracts.insurance.deleted` needs
adding to **both** locales or the toast prints a raw key.

Editing 3500 → 4000 keeps working exactly as now.

---

## T8 — Partial payments link to an invoice and carry a status

### Schema

`partial_payments.invoice_id` **already exists** (nullable,
`on delete set null`, migration 56) and is currently never written. Migration
**147** adds only:

```sql
alter table public.partial_payments
  add column if not exists status text not null default 'incomplete'
    check (status in ('incomplete', 'complete'));
```

### Form

After a contract is chosen, an Invoice dropdown lists that contract's
**settleable** invoices (`due`, `overdue`, `partially_paid` with balance > 0).
Selecting one writes `invoice_id`.

**Status is authored only when there is no invoice.** With an invoice selected,
the Status control is disabled and shows the invoice's own answer; the value is
computed in the database on write and maintained by the trigger thereafter. An
editable Status beside a linked invoice would let an admin save `complete`
against an invoice that is still due — and since linked complete rows are
locked, that row would be closed on arrival with no way back, which is precisely
the one-way state this design set out to remove.

Without an invoice, the Status select offers Complete / Incomplete and defaults
to Incomplete.

### Table

A new Invoice column showing the invoice code, linking to
`/admin/invoices?year=&month=` for that invoice's period — the same link
`InvoiceRowsTable` already uses. A Status column beside it.

Rows that are **`complete` *and* linked to an invoice** render muted
(`opacity-60`) with Edit and Delete disabled: the payment they describe was
closed by the system, and reopening it means reopening the invoice.

A `complete` row with **no** `invoice_id` stays fully editable. An admin who sets
the status by hand on an unlinked note has not been overruled by anything and
must be able to undo it — locking those on save would make the status a one-way
door the moment it was picked.

### The auto-flip belongs in the database

When the linked invoice becomes paid — by manual mark, by gateway webhook, or by
`paymentReconcileJob` — the partial payment flips to `complete`.

That is three call sites, which is precisely the shape `CLAUDE.md` warns about
for `runEventWorkflow`: *"five scattered checks is where one gets missed, and a
missed one is invisible."* So it is a trigger on `invoices` in migration 147, not
client code:

```
after update on public.invoices
when the row reaches a paid state
  → update partial_payments set status = 'complete' where invoice_id = new.id
```

One place, every path, and `bun run test:sql` can prove it. The trigger tolerates
`invoice_id is null` (an orphan left by `on delete set null`).

**The trigger is symmetric.** An invoice leaving the paid state — reversed
payment, `set_invoice_paid` un-marked, a voided gateway settlement — flips its
linked partial payments back to `incomplete`. An earlier draft made the flip
one-way on the reasoning that an admin could edit the row back; that is
circular, because the same draft disables Edit on exactly those rows. Symmetric
means there is no state the system can enter and not leave.

The function is `security definer` — the admin marking an invoice paid may hold
`invoices.update` without holding `partial_payments.update`, and RLS would
otherwise silently skip the flip. `execute` is revoked from `public` and `anon`:
`src/db/anonExecute.sqltest.ts` fails the suite for any anon-executable definer
outside three named RLS helpers.

**The `before` trigger carries both link rules.** Migration 56 gives
`invoice_id`, `contract_id` and `tenant_id` independent foreign keys with
nothing tying them together, so a malformed write can link one contract's
partial payment to another contract's invoice — and the definer trigger would
then happily mutate it. Migration 147's `tg_partial_payments_link_guard` rejects
that, and in the same pass **computes `status` from the linked invoice**,
discarding whatever the client sent.

The `after` trigger keeps a linked row in step as its invoice changes state; it
cannot see a row that arrives already claiming `complete` against an invoice
that never moves. Deriving on write is what closes that gap, and it is why the
UI can disable the control rather than validate it.

### Scoping the read

`useMoneyRecords` currently fetches every row with `.limit(500)` and no filter.
It gains optional `contractId` / `tenantId` filters, applied in the query rather
than in the component — T9's tab would otherwise silently truncate once the
table grows past 500.

---

## T9 — Partial payments tab on the tenant detail page

The tenant detail page renders `TenantContractTabs`, which shows a tab per
contract (`ContractTabPanel`) and falls back to `TenantWideTabs` **only when the
tenant has no contracts at all**. So for every real tenant, "a tab on the tenant
detail page" means `ContractTabPanel`.

The tab is added to both, scoped differently:

- `ContractTabPanel` → filtered by `contract_id` (what the user will actually
  see)
- `TenantWideTabs` → filtered by `tenant_id` (reachable only for a
  contract-less tenant, kept consistent)

It renders the same `RecordPanel` as `/admin/payments` → Partial, with the same
columns, the same create/edit/delete actions, the same permissions, plus the T4
numbering column. `RecordPanel` gains a `contractId` / `tenantId` prop that both
scopes the list and pre-fills the create form.

Two reachable states the contract-scoped view alone would get wrong:

- **Archived contracts.** `useContracts` defaults to `archiveMode: "current"`,
  so a tenant with an archived contract gets no tab for it — and every partial
  payment attached to that contract becomes unreachable from the tenant page.
  The tenant detail page passes `archiveMode: "all"`, which is the correct
  reading of a *history* page regardless of this tab.
- **A tenant with no contracts at all.** `RecordPanel`'s create form requires a
  contract to build a valid row. In the tenant-scoped fallback there is none, so
  the create action is hidden rather than offered and failing — a partial payment
  with no contract is not a record this table can hold.

---

## T10 — Tenant invoice table sorts by due date, oldest first

`useTableSort` already takes an `initial` sort state. `InvoiceRowsTable` passes
`{ key: "due_date", direction: "asc" }`.

This interacts with T4: the numbering column is a render index, so the oldest
invoice is `#1` on load and the numbers follow the user's sort thereafter.

---

## Cross-cutting requirements

### i18n parity is enforced by the test suite

`src/i18n/dictionary.test.ts` fails `bun run test` when a key exists in one
locale and not the other, and separately checks that every `t("literal")` in the
codebase resolves. Every task here adds copy. Keys go into **both** `ar` and `en`
as each task is written, not in a sweep at the end.

New keys, at minimum: the two tenant civil-ID labels and Commercial Address; the
bulk mark-paid bar, its count-based dialog description and its partial-failure
message; the partial-payment invoice and status columns and their two status
values; the partial-payments tab title; the numbering column header;
`contracts.insurance.deleted`; the zero-monthly-amount validation message.

### Files at the size ceiling

Four touched files are already past the 500–600 line ceiling, and `AGENTS.md` puts
splitting a file you are working in **in scope**. Each split is by
responsibility, and each one also buys testability the current shape does not
have:

| File | Lines | Extractions | Route left at |
| --- | --- | --- | --- |
| `admin.tenants.index.tsx` | 1380 | `lib/tenantForm.ts` (schema, defaults, reset, payload) + `components/admin/tenants/TenantFormDialog.tsx` + `components/admin/tenants/TenantsTable.tsx` | ~450 |
| `admin.contracts.tsx` | 1316 | `lib/contractForm.ts` + `components/admin/contracts/ContractFormDialog.tsx` + `components/admin/contracts/ContractsTable.tsx` | ~450 |
| `admin.invoices.tsx` | 1215 | `components/admin/invoices/InvoicesTable.tsx` + `components/admin/invoices/InvoiceDialogs.tsx` | ~500 |
| `useContracts.ts` | 756 | `hooks/useContractInsurance.ts` + `hooks/useContractRelations.ts` (units, concessions) | ~450 |
| `PaymentSidePanels.tsx` | 660 | `components/admin/RecordPanelTable.tsx` + `components/admin/RecordPanelDialog.tsx` | ~280 |

An earlier draft proposed one extraction per file and claimed the ceiling was
met. It was not: moving a 150-line schema out of a 1380-line route leaves 1230.
Each file above is split until it is actually under the ceiling.

**Every extraction is a pure move, committed on its own.** No behaviour change
travels with it. Ten features and five refactors in one diff is unreviewable
otherwise, and a regression has to stay bisectable to the commit that caused
it.

### Arabic doc comments

Every new or materially changed function gets a doc comment above it leading
with an Arabic description, per `AGENTS.md`.

### Migrations, and the order they must land in

| # | What |
| --- | --- |
| 147 | `partial_payments.status`, the symmetric invoice-paid trigger, the contract/invoice consistency trigger |
| 148 | seed the four `unit_types` rows the T5 binding targets |
| 149 | `tenants.authorized_manager_civil_id`, `owner_civil_id`, `commercial_address`, and the `bulk_import_phase6` re-issue |
| 150 | `contract_units.monthly_amount > 0`, and the `delete_contract_insurance` RPC |

Every `security definer` function added here revokes `execute` from `public` and
`anon`. `src/db/anonExecute.sqltest.ts` is set-based and fails the suite for any
anon-executable definer outside three named RLS helpers — it will catch an
omission, but only after the fact.

Dokploy auto-deploys on merge to `main`, and it deploys code but never schema.
All four migrations (147–150) are applied to `danatfuture-supabase-ozoxsa-db-1` over
`ssh-danatfuture-mcp` **before** the merge, checksummed against the local files,
followed by `notify pgrst, 'reload schema'`. `pg_dump` first.

`database.types.ts` is hand-maintained despite looking generated — the four new
columns are hand-added there. `bun run gen:types` writes a reference file only
and must not overwrite it.

---

## Out of scope

- Making the floor→type binding editable from Settings → Lists.
- Reconciling the two surfaces that author an insurance holding. The Insurance
  panel writes `insurance_payments` directly while the contract form writes
  `contracts.deposit` and mirrors it, and neither updates the other. T7 sidesteps
  the damage by firing only on a positive→zero transition; it does not fix the
  divergence.
- Retiring the `owner_name` / `alternate_contacts` columns from the database.
- Any change to how partial payments interact with the budget: they remain
  inert, excluded from `get_budget_summary`, and `refunds.sqltest.ts` asserts
  that they leave every invoice balance and budget figure untouched. Nothing here
  changes that, and the status column must not.
