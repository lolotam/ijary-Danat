# Ten-task batch — design

Date: 2026-08-13
Status: approved for planning

Ten requested changes, grouped into five file-disjoint delivery lanes plus one
shared base commit. Task numbers below are the user's original numbering.

---

## 0. Decisions locked before design

These were answered by the product owner and are not open for re-litigation by
an implementer:

| Question | Decision |
| --- | --- |
| Discount application (task 8) | Mutate the chosen invoices **in place**; invoice codes never change |
| Existing duplicate discounts | Auto-keep the oldest, cancel the rest (already hand-cleaned in production; migration ships as an idempotent no-op) |
| Mark-as-paid ordering scope (task 4) | **Per contract**, identical to the portal and the KNET link gate |
| Mark-as-paid override | **Hard block**, no override role |
| Cards Control scope (task 2) | **Company-wide**, admin-controlled — not a per-user preference |
| Cards Control page coverage | The seven requested pages **plus Properties** |
| Commercial name (task 6) | Receipts **and** invoices; falls back to the tenant name when empty |
| Occupancy definition (task 3) | A unit is occupied when it has a contract in state `active` |
| Amount-after-discount column (task 7) | **Dropped** from scope |
| Discount dropdown contents (task 8) | Fully unpaid invoices with no discount already recorded |
| Tenant list logo layout (task 1) | One logo per contract line |
| PR split | Five lanes, merged one at a time |

---

## 1. Shop logos per contract (task 1)

### Current behaviour

`src/lib/brandLogos.ts` already resolves brand assets **per contract** and
returns `Map<contractId, BrandAssetUrls>`. The loss happens downstream:

- `src/hooks/useTenants.ts:235-251` picks `locations[0]` and exposes a single
  `shopLogoUrl` / `shopCardUrl` per tenant.
- `src/hooks/useLinkedBrand.ts:22-30` queries with `.limit(1).maybeSingle()`,
  so a tenant with two branded contracts resolves to one arbitrary brand.

Both consumers therefore show the first contract's logo and no other.

### Target behaviour

1. **Tenants list** — the table already stacks a tenant's active contracts
   vertically (`activeContracts: TenantActiveLocation[]`). Each contract line
   renders its own shop logo. A contract with no brand renders the existing
   placeholder, so rows stay aligned.
2. **Tenant portal dashboard** (`src/routes/portal.index.tsx`) — the logo
   follows the contract the tenant has selected. Changing the contract selector
   changes the logo.
3. **Tenant detail page** (`src/routes/admin.tenants.$id.index.tsx` and
   `TenantContractTabs.tsx`) — same rule: the active contract tab drives the
   logo shown.

### Design

- Add `logoUrl` to each entry of `TenantActiveLocation` in `useTenants`, sourced
  from the existing per-contract map. Keep the tenant-level `shopLogoUrl` as the
  primary contract's logo so existing exports and the mobile card list keep
  working; it becomes a derived convenience, not the source of truth.
- Replace `useBrandForTenant` with a hook that returns **all** brands for the
  tenant keyed by contract id (`useBrandsForTenantContracts`). Callers select by
  the currently-selected contract id. `useBrandForUnit` keeps its single-brand
  shape — the `one_active_contract_per_unit` unique index means a unit has at
  most one active contract.
- No schema change. `commercial_brands.contract_id` is already the link.

### Verification

A tenant with two active branded contracts shows two different logos in the
list, and switching the portal contract selector switches the dashboard logo.
A tenant with one contract is visually unchanged.

---

## 2. Cards Control (task 2)

### Design

New settings tab at `/admin/settings/cards` listing every KPI card grouped by
page, each with a checkbox. Unchecking hides that card from the page for every
user in the company.

**Storage** — new table (migration 126):

```
public.card_visibility (
  company_id uuid not null references public.companies(id) on delete cascade,
  card_id    text not null,
  is_visible boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (company_id, card_id)
)
```

Absence of a row means visible. Only hidden cards are stored, so the table stays
small and a newly added card defaults to visible without a data migration.

**Card registry** — a single `src/lib/cardRegistry.ts` exporting the canonical
list of `{ page, cardId, labelKey }`. The settings screen renders from it and
the pages gate against it, so a card can never appear in one and not the other.
The registry is the only place a new card is declared.

**Gate** — `useCardVisibility()` returns a `isCardVisible(cardId)` predicate.
Pages wrap each KPI card in the existing `SummaryCards` grid with that
predicate. Hidden cards are not rendered; the underlying summary query is **not**
skipped — this system serves ~70 units and the query is one RPC, so conditional
fetching would add branching for no measurable gain.

**Coverage** — Dashboard (9), Tenants (4), Units (5), Contracts (5),
Payments & refunds (5), Bank deposits (4), Expenses (4), Properties.

### Verification

Toggling a card off in settings removes it from its page after a refetch. This
must be checked in the running app, not only in a unit test on the settings
form: this repository's recurring defect is configuration that is written and
never read.

---

## 3. Property card occupied / vacant counts (task 3)

Property cards on `/admin/properties` currently show type, total units, area and
status. Add a full-width collapsible control under the total-units figure that
expands to two counts, each rendered as a circle:

- **Occupied** — units belonging to a contract in state `active`, via
  `contract_units`.
- **Vacant** — total units minus occupied.

Occupancy is derived from contracts rather than `units.status` deliberately:
this codebase has a documented pattern of status columns that are written and
never read, and a card that disagrees with the contracts table is worse than no
card. Counts come from the existing properties list query extended with a
per-property aggregate; no schema change.

---

## 4. Sequential mark-as-paid (task 4)

### Current state

`src/fns/createPayment.ts:221` already throws
`new Error("Invoices must be paid in chronological order.")` and already accepts
an optional contract scope. `src/lib/paymentErrors.ts:49` maps that error to the
KNET toast key. The portal and the KNET link generator both go through it.
Manual "Mark as paid" does not.

### Design

Route both admin mark-as-paid entry points through the same **server-side**
guard:

- `src/routes/admin.invoices.tsx` (monthly invoices page)
- `src/components/admin/tenant-detail/InvoiceRowsTable.tsx` (tenant detail)

The check lives in the **body** of the server function, never in a Zod
`.validator()` — the project's `createServerFn` test mock does not execute
validators, so a validator-based check would be untested and silently
skippable. It must also not be client-only: a client-side guard in
`MarkInvoicePaidDialog` is a UI courtesy, not an invariant.

Scope is per contract, matching `evaluate_portal_payable_invoices`: an invoice
is blocked when the **same contract** has an unpaid invoice with an earlier
period. There is no override.

Errors are thrown as `Error`, never as `new Response(...)` — a thrown Response
resolves as success on the client through `x-tss-raw`.

### Message

A **new** i18n key with the product owner's exact wording, in both locales:

```
invoices.markPaidOutOfOrder
  en: "You should pay the previous invoices firstly before marking this invoice as paid."
  ar: "يجب دفع الفواتير السابقة أولاً قبل تعليم هذه الفاتورة كمدفوعة."
```

The existing `invoices.knetLinkOutOfOrder` string is left untouched — it
describes link generation and its wording still fits that flow.

---

## 5. Column sorting rollout (task 5)

`src/components/admin/SortableTable.tsx` already provides `useTableSort` and
`SortableHead`, used by the tenants and monthly-invoices tables. Roll the same
pair out, with no changes to the primitive, to:

- Property detail — units table
- Unit detail — contracts, monthly invoices, manual payments tables
- Automation — notification pool, notification templates
- Reports — all report tables
- Payments & refunds — refund, partial payment, insurance payment tables
- Tenant detail — monthly invoices, monthly payments tables

Sorting is client-side over the currently loaded page, which is the documented
behaviour of the existing primitive. Every column header in each table becomes
sortable, with a `getValue` that sorts on the underlying value (date, number)
rather than the formatted string.

---

## 6. Commercial name on receipts and invoices (task 6)

Replace the tenant name — both Arabic and English — with
`tenants.commercial_name` on every generated document, falling back to the
tenant name when `commercial_name` is null or empty so no document ever prints a
blank party.

Touch points:

- `src/components/admin/ReceiptPrint.tsx`
- `src/components/admin/InvoicePrint.tsx`
- `src/lib/paymentReceiptHtml.ts`
- `src/lib/invoicePrintHtml.ts`

The resolution rule is one exported helper used by all four, so print, download
and email attachment cannot drift apart.

Note: the server-side PDF attachment path is Latin-only (`pdfkit` cannot shape
Arabic), so its labels remain English by existing design. Only the party name
value changes there.

---

## 7. Contract discount columns (task 7)

Replace the single `concessions` column in the contracts table with three:

| Column | Content |
| --- | --- |
| Free months | count of free months |
| Percentage discount | month count — percentage, e.g. `3 — 30%` |
| Fixed discount | month count — amount, e.g. `3 — 100 KWD` |

Each is sortable on its numeric month count. Empty cells render the existing
"no value" treatment rather than a zero. The "amount after discount" column
described in the original request is **out of scope** by the owner's decision.

`src/routes/admin.contracts.tsx` is ~1470 lines and is a documented split
target. `ConcessionsDialog` moves to its own file as part of this work, since
tasks 7 and 8 both edit it.

---

## 8. Discounts bound to invoices (task 8) — the structural change

### Root cause of the reported duplicate

The live `generate_invoices_for_year` (migration `119`, ~line 215) applies
percentage and fixed discounts **by date range**, iterating every matching
concession:

```sql
for v_concession in
  select cn.* from public.concessions cn
  where cn.contract_id = v_contract.id and cn.status = 'active'
    and cn.type <> 'free_months'
    and cn.start_date <= v_period_start and cn.end_date >= v_period_start
loop
  -- subtracts each one in turn
```

Two concessions whose ranges both cover March therefore both reduce March.
INV-0000250 carrying a 100 and a 200 discount is this loop, not a dialog bug.
Filtering the dropdown alone would leave the defect intact: regenerating the
invoice would re-derive both discounts.

### Design

**Migration 127** does three things.

1. **Link table**

   ```sql
   create table public.concession_invoices (
     concession_id uuid not null references public.concessions(id) on delete cascade,
     invoice_id    uuid not null references public.invoices(id)    on delete cascade,
     primary key (concession_id, invoice_id),
     unique (invoice_id)
   );
   ```

   The `unique (invoice_id)` constraint **is** the business rule: one discount
   per invoice, enforced declaratively so no code path can bypass it. The
   cascade from `concessions` means deleting a discount record frees its
   invoices for a new discount, exactly as requested.

2. **Percentage and fixed discounts leave the generation-time date-range path.**
   The loop above is narrowed so only `free_months` behaviour remains
   date-driven. `free_months` is untouched: it skips invoice creation entirely
   (`period_in_free_months`) and so can never collide with a discount on an
   existing invoice.

3. **Regeneration protects discounted invoices.** `reapply_contract_invoices`
   currently deletes unpaid invoices whose period has left the contract, and
   already refuses to touch paid ones (migration 95). A discounted invoice gets
   the same protection — otherwise applying a discount and then regenerating
   would silently erase it.

**Apply RPC** — a `security definer` function that, given a concession and a set
of invoice ids, writes `invoices.total` and the concession `invoice_items` line
for each. It writes **only** `total`: `invoices.balance` is
`generated always as (total - paid) stored`, so the balance follows
automatically and any code writing `balance` directly is wrong.

**Migration 128** — cancels duplicate discounts predating the constraint,
keeping the oldest per contract-period. Production has already been hand-cleaned,
so this is expected to be a no-op; it ships anyway so a restored backup cannot
reintroduce the state. A read-only production query confirms the count is zero
before the constraint is added.

### Dialog behaviour

- **Free months** keeps its current from/to date behaviour — already correct.
- **Percentage / fixed discount** replaces the from/to date fields with a
  multi-select of invoices, listed as invoice code plus month and year
  (`INV-0000250 — March 2026`).
- The list contains only invoices on this contract that are **fully unpaid** and
  have **no** `concession_invoices` row. An invoice already discounted by
  another record cannot appear until that record is deleted.
- The concession's `start_date` / `end_date` are derived from the selected
  invoices' periods so the existing table columns keep working.
- The dialog's own table gains two columns: the month count, and the invoice
  codes the discount covers.

The dropdown filter is a usability measure. The unique constraint is the
guarantee — an implementer must not treat the filter as sufficient.

### Verification

`bun run test:sql` against a clean database must cover: applying a discount to a
chosen invoice keeps its code and reduces its total; a second discount naming
the same invoice fails; deleting the first discount makes the invoice selectable
again; and regenerating a contract does not remove a discounted invoice.

---

## 9. Portal invoice discount badge (task 9)

In the portal "My invoices" list, an invoice carrying a discount renders a small
badge inside its existing record — no new column, so undiscounted invoices are
visually unchanged.

Label: `Discount: (10 KWD)` — amount only, no percentage, in both locales.
Source is `invoices.discount`, which is already populated.

---

## 10. Tenant detail additions (task 10)

**Discount column** on the tenant detail monthly-invoices table, showing one
badge per invoice:

- fixed discount — month count circle plus the amount in KWD
- percentage discount — the percentage plus the resulting discounted amount

Values derive from the invoice's own `discount` and its linked concession, so
applying a discount in the contract dialog is reflected here, along with the
updated total and balance, without a second source of truth.

**Free months field** in the contract layout, placed directly under the Unit
field, showing the count of free months on that contract. Renders the existing
empty treatment when there are none.

---

## 11. Delivery

### Lane ownership

Lanes are cut so that **every file belongs to exactly one lane**. The user's
feature grouping put `InvoiceRowsTable.tsx` in three lanes and
`admin.contracts.tsx` in two; worktree isolation prevents agents overwriting
each other but does not prevent merge conflicts, and hand-resolving generated
code across five PRs is the slowest failure mode available.

| Lane | Tasks | Owns |
| --- | --- | --- |
| Base | — | `cardRegistry.ts`, `useCardVisibility`, migration 126 (written by the orchestrator, merged first) |
| 1 | 1 | `brandLogos`, `useLinkedBrand`, `useTenants`, `admin.tenants.index`, `portal.index`, `admin.tenants.$id.index`, `TenantContractTabs` |
| 2 | 7, 8, 9, 10 | migrations 127–128, `admin.contracts` + extracted `ConcessionsDialog`, `useContracts` concession hooks, `portal.invoices`, `ContractTabPanel`, `InvoiceRowsTable` |
| 3 | 2, 3 | `admin.settings.cards`, `admin.settings`, `SummaryCards`, `admin.index`, `admin.units.index`, `admin.deposits`, `admin.expenses`, `admin.properties.index` |
| 4 | 4, 6 | payment guard, `MarkInvoicePaidDialog`, `admin.invoices`, `ReceiptPrint`, `InvoicePrint`, `paymentReceiptHtml`, `invoicePrintHtml` |
| 5 | 5 | `admin.properties.$id`, `admin.units.$id`, `admin.reports`, `ScheduledAndGeneratedReports`, notification tables, `admin.payments`, `PaymentSidePanels` |

Where a lane owns a page that also carries KPI cards, that lane applies its own
card gate using the base commit's hook. Lane 3 does not reach into pages other
lanes own.

**Merge order: base → 5 → 1 → 3 → 4 → 2.** Lane 2 lands last: it is the largest
and it needs `InvoiceRowsTable` after lane 4 has finished with it. The
orchestrator rebases lane 2.

### Migration discipline

Numbers are assigned in this spec so two agents cannot both claim the next one:
**126** card visibility, **127** concession link table and generation change,
**128** duplicate cleanup.

Merging to `main` auto-deploys. Each migration is therefore applied to
`danatfuture-supabase-ozoxsa-db-1` and followed by `notify pgrst, 'reload schema'`
**before** its PR merges, or the new bundle runs against the old schema.
`pg_dump` first — schema changes are not reversible.

### Constraints every implementer must respect

- `src/integrations/supabase/database.types.ts` is **hand-maintained** despite
  looking generated. New tables get hand-written entries; never overwrite it
  with `gen:types` output.
- i18n parity is **test-enforced**. Every new label needs both `ar` and `en`, or
  `bun run test` fails.
- New public tables arrive with `ALL` granted to `anon` and `authenticated`.
  `revoke` first, then grant narrowly; `revoke ... from public` does **not**
  reach `anon`.
- Throw `Error`, never `new Response(...)`, from server functions.
- Do not run `bun run format` before staging — it rewrites all markdown and
  buries the real diff.
- Files stay under 500–600 lines.
- Every function gets a doc comment above it, leading with Arabic.

### Gates

`bun run lint`, `bun run typecheck`, `bun run test` on every lane;
`bun run test:sql` additionally on lane 2. Then `clean-code-guard` on production
code and `test-guard` on tests, before any PR is opened.
