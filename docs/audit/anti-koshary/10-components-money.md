# S10 — `src/components/admin`: contracts, invoices, tenants, tenant-detail, deposits

**Lines read:** ~8,060 · **Files:** 36 · **Date:** 2026-09-22

`contracts/` (14 files, 2903) · `invoices/` (11 files, 2414) · `tenant-detail/` (5 files, 1240) ·
`tenants/` (4 files, 1072) · `deposits/` (2 files, 428).
Largest: `ContractFormDialog` (643) · `ConcessionsDialog` (612) · `InvoicesTable` (569) ·
`TenantsTable` (529) · `MonthlyInvoicesOverview` (529) · `InvoiceRowsTable` (525).

**Overall:** well-organised. 36 files averaging 224 lines, the sortable-table machinery is
genuinely shared, no component touches `supabase` directly, and the invoice/contract business
rules live in `src/lib` and SQL where they belong. The recurring shape here is **"one table
plus its five dialogs in one component"** — the same shape as S04 #2 and S09 #1, one layer
down.

---

## Findings

### 1 · Medium — `InvoicesTable` is a table and five dialogs in one component

**Where:** `src/components/admin/invoices/InvoicesTable.tsx` (569 lines, **10 `useState`**)

```
selectedIds · detailInvoice · printInvoice · sendInvoice · sendChannels · sendPending
· paidPending · markPaidInvoice · knetPending · knetLink
```

Only `selectedIds` belongs to the table. The other nine are the open/pending state of five
independent features hanging off a row action: detail, print, send-to-tenant (with its own
channel selection and pending flag), mark-paid, and KNET-link generation (with its own
pending flag and result).

**Which means:** the file that renders the invoice list is also the file that owns the
send-to-tenant channel choice and the KNET link lifecycle. `admin.invoices.tsx` churns
37×/year and this is where those edits land. Adding a sixth row action adds two more pieces
of state to a component that already has ten, and nothing signals which of them a given
dialog reads.

**Fix:** the dialogs are already separate components (`MarkInvoicePaidDialog`,
`InvoiceRowActions`, `InvoicePrint` all exist in `components/admin/`). Move their *state*
with them — one `<InvoiceRowActions invoice={…}/>` per row owning its own pending/target
state — leaving `InvoicesTable` with `selectedIds` and the rows. Same pattern as S09 #1.

---

### 2 · Medium — `InvoiceRowsTable` repeats it, and discards an error while doing so

**Where:** `src/components/admin/tenant-detail/InvoiceRowsTable.tsx` (525 lines,
**9 `useState`**), with a discarding `catch {}` at `:491`

The tenant-detail twin of finding 1: the same table-plus-dialogs shape, 21 changes in 12
months, and one more instance of **S08 #1**'s pattern (`catch {}` with the error thrown
away).

**Which means:** two components, 1,094 lines between them, both rendering invoice rows with
row actions, both carrying the dialog state. They are not duplicates — the columns and the
context genuinely differ — but they will drift on anything that touches an invoice row
action, and a change to the send or mark-paid flow has to be made in both.

**Fix:** the same extraction as finding 1 makes both smaller and gives them a shared
`<InvoiceRowActions>` rather than two copies of the state around it. Do finding 1 first; this
one then mostly follows.

---

## Not reported, and why

- **`lib/adminTableSortValues.ts` — 13 `xSortValue` switch functions, 499 lines.** This looks
  like textbook duplication and, on the reference's test, **is not**: the 13 switches serve
  13 different row shapes owned by 13 different screens, and merging them would need a
  discriminator argument per caller — the reference's explicit sign that an extraction will
  make things worse. The shared *rules* (`asNumber` for money, `rel?.name ?? null` for a
  joined name, `period_year * 100 + period_month` for a period) **are** already factored:
  `asNumber` is one helper used 13 times, and the period rule appears twice, consistently.
  Leave it.
- **`SortableTable` / `SortableHead`** — every admin table in this scope imports them
  (`InvoicesTable`, `TenantsTable`, `ContractsTable`, `InvoiceRowsTable`). Correctly shared.
- **No direct `supabase` access** in any of the 36 files. All data arrives through hooks.
- **`ContractFormDialog` (643) and `ConcessionsDialog` (612)** — over the ceiling, but each
  is one form for one entity with the field groups already split into child components
  (`ContractUnitsField`, `Phase2FormFields`). Length without the symptoms.
- **Invoice pricing rules** — checked specifically, given the repo's "four functions price an
  invoice" history. None of them is in a component; they are in `src/fns` and SQL.
- **`ContractFormDialog.tsx:285`** calls `syncContractSchedule` (not `regenerate`) — this is
  the known and deliberate distinction, not a bug.

## Test coverage of this scope

Good relative to the routes: `contracts/`, `invoices/` and `tenants/` all carry test files,
including `ContractsTable`, `ShopsTable`-adjacent cells and the concession dialogs. Neither
finding is covered — both are structural. The extraction in finding 1 is verified by
typecheck plus opening the invoices screen.

**Consequence for Pass 2:** both findings are behaviour-preserving moves of state into
components that already exist. Low risk, but do them one dialog at a time and check the
screen — no test asserts that the KNET link dialog still opens.

## Ledger entries added

See `LEDGER.md` — the table-plus-dialogs shape; `SortableTable` and `adminTableSortValues`
recorded as correct (the latter explicitly as *do not merge*).
