# A tenant with two contracts — showing the second one

**Date:** 2026-08-03
**Migration:** `db/migrations/77_tenant_document_contract_id.sql`
**Branch:** cut from `fix/contract-name-locale-and-tenant-block-toggle`
**Touches:** the tenants list, the tenant detail page, `useTenants`,
`useContracts`, `tenant_documents`

---

## 1. The problem

A tenant can hold more than one contract — a second shop, a second unit in the
same building, a renewal running beside the original. The database has always
allowed it: `contracts.tenant_id` is a plain foreign key with no uniqueness
constraint. The UI has never shown it.

`selectActiveContractByTenant` (`src/lib/tenantLocations.ts`) sorts a tenant's
active contracts by `start_date` descending and keeps **the first one**. Every
screen downstream inherits that choice:

| Screen                        | What it shows today                       | What is hidden       |
| ----------------------------- | ----------------------------------------- | -------------------- |
| Tenants list — property       | one building                              | every other building |
| Tenants list — unit           | one unit                                  | every other unit     |
| Tenants list — start/end      | one contract's dates                      | every other contract |
| Tenant detail — Current Lease | `find(state === "active")` — the same one | every other contract |

The second contract is not marked as hidden anywhere. It is simply absent, and
the screen looks complete without it. A tenant renting two shops reads as a
tenant renting one.

The Contracts tab on the detail page does list every contract in a table — so
the data is reachable — but there is no way to see one contract's invoices, its
payments, or its documents. Everything below the lease card is tenant-wide.

---

## 2. Two different questions, two different answers

The list and the detail page are not asking the same thing, and the scope of
"the tenant's contracts" differs accordingly.

**The tenants list asks _where is this tenant now_.** Its columns are headed
"Connected property" and "Connecting unit". It widens to every **active**
contract. An expired contract is not a place the tenant is.

**The detail page asks _what is this tenant's history_.** It gets a tab for
**every** contract, whatever its state — draft, active, frozen, expired,
renewed. A contract that ended still has invoices that were raised and payments
that were made against it, and that record is the reason the page exists.

This split is deliberate. Using the active-only rule on the detail page would
hide expired contracts from the one screen built to show them; using the
all-states rule on the list would fill the "where is this tenant" columns with
units the tenant left years ago.

---

## 3. Data layer

### 3.1 `src/lib/tenantLocations.ts` — one sort rule, not two

Add the plural selector and reimplement the existing singular one on top of it:

```ts
export function selectActiveContractsByTenant<T extends ActiveContractCandidate>(
  contracts: T[],
): Map<string, T[]>; // all active contracts per tenant, newest start first

export function selectActiveContractByTenant<T extends ActiveContractCandidate>(
  contracts: T[],
): Map<string, T>; // plural → [0]
```

Deriving the singular from the plural keeps a single definition of "newest
active contract". Two independent sort implementations would drift, and the
singular one is what the list's sort accessors and CSV export still depend on.
`tenantLocations.test.ts` covers the singular selector today; those tests must
pass unchanged.

### 3.2 `src/hooks/useTenants.ts`

`attachActiveLocations` currently resolves units and properties for the primary
contract only. It resolves them for every active contract instead — the unit
and property queries already batch through `.in()`, so this is a wider id set,
not a new round trip.

`TenantWithActiveLocation` gains two fields:

```ts
interface TenantWithActiveLocation {
  /** Every active contract, newest start first. The primary is [0]. */
  activeContracts: Array<{
    contract: { id: string; code: string; start_date: string; end_date: string | null };
    unit: Tables<"units"> | null;
    property: Tables<"properties"> | null;
  }>;
  /** Distinct buildings across those contracts — one entry per building id. */
  connectedProperties: Array<Tables<"properties">>;
}
```

`connectedProperty`, `connectingUnit`, `activeContractStartDate` and
`activeContractEndDate` keep their present meaning exactly: the primary
contract. They are read by the sort accessors in `admin.tenants.index.tsx`, by
`exportTenants` via `unitCsvNames`, and by the mobile card list. Widening them
into arrays would break all four, and a sort comparator over an array has no
meaning — sorting the property column must stay a sort on one displayed value.

`connectedProperties` is the field that implements the requirement "if it is the
same building, it should show as one building only". It dedupes on
`property.id`, preserving the order the contracts came in.

### 3.3 `src/hooks/useContracts.ts` — a latent bug this feature would expose

`ContractListParams` has no tenant filter. The tenant detail page therefore
calls `useContracts({ pageSize: 50 })` — the newest 50 contracts in the **whole
system** — and filters by `tenant_id` in the browser.

Today only the first active contract is read, so nobody noticed. Once every
contract must become a tab, a tenant whose contracts fall outside that global
window loses tabs with no error and no empty state. The page would look
complete and be wrong, which is the same failure mode this whole spec is about.

Add `tenantId?: string` to `ContractListParams`, apply it server-side as
`.eq("tenant_id", tenantId)`, and include it in the React Query key. Raising
`pageSize` is not the fix — it moves the cliff without removing it.

### 3.4 Per-contract payments — the join that does not exist

`invoices.contract_id` is `NOT NULL`, so a contract's invoices are one filter.

Payments are not. `PaymentRow` has `tenant_id` and `unit_id` and no
`contract_id`. A payment reaches a contract only through
`payment_allocations → invoices.contract_id`, and **one payment can allocate
across invoices belonging to two different contracts**. Payments are therefore
not partitionable by contract.

Showing `payments.amount` under each contract tab would double-count: a 500 KWD
payment split 300/200 across two contracts would read 500 in both tabs, and the
two tabs would claim 1000 KWD was paid.

So each contract's Monthly Payments table shows the **allocated** amount beside
the payment total:

```
Payment P-0007 · total 500.000 KWD
  → Contract A tab: allocated 300.000
  → Contract B tab: allocated 200.000
```

Split across two files so the arithmetic is testable without a database:

- **`src/lib/contractPayments.ts`** — a pure reducer taking allocation rows and
  the set of invoice ids belonging to this contract, returning each payment's
  allocated total. No Supabase import.
- **`src/hooks/useContractPayments.ts`** — the I/O:

  ```
  invoices WHERE contract_id = X            → invoice ids
  payment_allocations WHERE invoice_id IN   → allocation rows
  payments WHERE id IN allocation.payment_id
  → reducer → rows sorted by payment_date desc
  ```

### 3.5 Migration 77 — `tenant_documents.contract_id`

`tenant_documents` has `tenant_id` and a `type` enum that already includes
`"contract"`, but no link to a specific contract. `contracts.documents` (Json)
exists, is written `null` at `admin.contracts.tsx:290`, and is never read — the
written-but-never-read shape this codebase keeps producing. It is not a usable
store.

```sql
alter table tenant_documents
  add column if not exists contract_id uuid references contracts(id) on delete set null;

create index if not exists tenant_documents_contract_id_idx
  on tenant_documents (contract_id);
```

`on delete set null`, never `cascade`: deleting a contract must not destroy a
civil ID or a commercial licence that happened to be tagged to it. The document
falls back to being tenant-wide.

Then hand-add `contract_id: string | null` to `TenantDocumentRow` in
`src/integrations/supabase/database.types.ts`. That file is hand-maintained
despite looking generated — `bun run gen:types` writes a reference file only and
must not overwrite it.

The column is nullable and every existing row keeps `NULL`, which is what makes
the read rule in §5 safe.

---

## 4. The tenants list

| Column                | Change                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| Connected property    | Every **distinct** building, one per line. The same building twice → once.                            |
| Connecting unit       | One entry per active contract. Units are never deduped — two contracts in one building are two units. |
| **Contracts** _(new)_ | One contract code per active contract, monospace, matching the code styling used elsewhere.           |
| Start date / End date | Unchanged — the primary contract's dates.                                                             |

The start/end columns stay singular because they are sortable and a sort over
two date ranges has no defined order. The per-contract dates are on the detail
page, one tab each.

**Card view** — the existing property and unit `Badge`s become one badge per
value, property deduped, keeping the current `truncate` widths.

**Mobile card list** — the `CardField` values render line-separated.

**CSV export** — `connected_property_*` and `connected_unit_*` join their values
with `"; "`; a new `connected_contract_codes` column carries the codes. The
comment at `admin.tenants.index.tsx:311` about `name_en` and the bulk-import
schema still applies and is not touched here.

---

## 5. The tenant detail page

The block below the Current Lease card becomes two levels of tabs.

```
┌ Current Lease │ C-2026-0004 │ C-2026-0011 ┐
└──────────────────────────────────────────┘
```

**Current Lease** keeps today's four tenant-wide tables — Invoices, Payments,
Contracts, Documents — unchanged and covering every contract combined. Removing
them would be a regression: the combined view is the only place to see the
tenant's whole financial position at once.

**One tab per contract.** `value = contract.id`, label = `contract.code`.
Contracts have no name column; the code is the identifier used everywhere else
in the app, and it is short enough not to overflow the tab strip in Arabic RTL.
Ordered by `start_date` **ascending**, so the oldest contract is the leftmost —
the "Contract 1" of the request. Every contract appears regardless of state.

Each contract tab opens with that contract's lease details — code, state,
building link, unit link, start, end, monthly rent — in the same `Info` grid the
Current Lease card uses, followed by four sub-tabs:

| Sub-tab          | Content                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Monthly Invoices | `invoices WHERE contract_id = X` — period, due date, state, total, balance                        |
| Monthly Payments | Payments allocated to this contract, with an **Allocated** column beside the payment total (§3.4) |
| Contract         | The contract record: type, deposit, due day, grace days, duration, entry date, notes              |
| Documents        | `tenant_documents WHERE contract_id = X OR contract_id IS NULL`                                   |

The Documents read rule is what makes migration 77 safe to ship without a
backfill. Every existing document has `contract_id IS NULL` and therefore
appears under every contract tab, exactly as it does today. Nothing disappears
on deploy. Uploads made from inside a contract tab tag that contract and
narrow to it; uploads from the tenant-wide Documents tab stay untagged.

### 5.1 Refactor

`admin.tenants.$id.index.tsx` is 478 lines and would roughly double. It is split
into `src/components/admin/tenant-detail/`:

| File                     | Responsibility                                        |
| ------------------------ | ----------------------------------------------------- |
| `TenantContractTabs.tsx` | the tab strip and which panel is shown                |
| `ContractTabPanel.tsx`   | one contract: lease details + its four sub-tabs       |
| `TenantWideTabs.tsx`     | today's four tenant-wide tables, moved verbatim       |
| `InvoiceRowsTable.tsx`   | the invoice list both of the above render identically |

`InvoiceRowsTable` exists because the tenant-wide and per-contract invoice
tables have the same six columns and the same cell rendering — they differ only
in which invoices they are handed. The payments tables are _not_ shared: the
per-contract one carries an Allocated column the tenant-wide one has no meaning
for, and giving one component a flag for that would be the wrong abstraction.

The local `Info` helper is promoted to a shared `src/components/admin/InfoField.tsx`,
since three of these files need it. The route file returns to being a page
composition: header, logo card, summary cards, profile, current lease, tabs.

This is scoped to the files this feature touches. No unrelated refactoring.

---

## 6. i18n

New keys, added to **both** `ar` and `en` in `src/i18n/dictionary.ts`:

`tenants.connectedContracts`, `tenants.currentLeaseTab`,
`contracts.monthlyInvoices`, `contracts.monthlyPayments`, `contracts.details`,
`payments.allocatedToContract`.

Not `payments.allocated` — that key already exists as the allocation success
toast ("Payment allocated and invoice balances updated."), and reusing it would
have put a sentence in a table header. The contract type reuses the existing
`common.type` rather than adding `contracts.type`.

`dictionary.test.ts` fails `bun run test` on a key present in only one locale,
and separately checks that every `t("literal")` in the codebase resolves. Both
checks run as part of the normal gate — there is no separate parity step.

---

## 7. Tests

| File                               | Covers                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/tenantLocations.test.ts`  | extended: the plural selector's ordering; the singular one still returns the newest; building dedupe keeps one entry for two contracts in one building                   |
| `src/lib/contractPayments.test.ts` | new: allocated totals; a payment split across two contracts contributes its own share to each and never its full amount; a payment with no allocation appears in neither |

The existing singular-selector tests must pass without modification — if they
need editing, the reimplementation in §3.1 changed behaviour it should not have.

Gate before presenting: `bun run lint`, `bun run typecheck`, `bun run test`.

---

## 8. Deployment

Migration 77 is applied to the live Supabase container
(`danatfuture-supabase-ozoxsa-db-1`) as a new migration only — replaying the
full set against a migrated database fails on the OUT-parameter row type change
in `identify_contract_expiry_reminders`. Verify the clean-build path with
`bun run test:db`.

The migration is additive, nullable, and indexed. The UI ships correctly against
a database where it has not yet been applied only if the code tolerates the
column's absence — it does not, so **the migration lands before the app
deploys**.

---

## 9. Out of scope

- Backfilling `tenant_documents.contract_id` for existing documents. They stay
  tenant-wide and show under every tab, which is the current behaviour.
- Reviving `contracts.documents` (Json). It stays dead; removing it is a
  separate cleanup.
- Any change to how contracts are created, renewed, or how their state is
  derived.
- Multi-contract support in the tenant portal. This is admin-side only.
