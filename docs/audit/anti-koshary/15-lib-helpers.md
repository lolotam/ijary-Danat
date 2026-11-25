# S15 — `src/lib`: schemas, forms, table/status/format helpers, the rest

**Lines read:** ~7,900 · **Files:** 60 · **Date:** 2026-09-22

`statusTone.ts` (448) · `contractForm.ts` (333) · `bulkImportSchemas.ts` (256) ·
`tenantForm.ts` (226) · `concessionColumns.ts` (219) · `nationalities.ts` (216) ·
`invoicePaymentBreakdown.ts` (209) · `invoiceRelations.ts` (206) · `templateVariables.ts` (202) ·
`unitForm.ts` (194) · `permissions.ts` (185) — plus ~49 files under 180 lines
(`portalTabs`, `workflowCatalog`, `csvHeaders`, `dateDisplay`, `cardRegistry`, `pagedQuery`,
`closeoutSchemas`, `csv`, `invoiceSettlement`, `idChunks`, `queryRetry`, `money`, …).

**Overall: this is the best-designed part of the codebase.** Sixty files, none over 450
lines, each named for one job, most carrying a docblock that explains the decision rather
than the code. One finding — a convention that was established and then half-applied.

---

## Findings

### 1 · Medium — the `lib/<entity>Form.ts` convention exists, and three entities skip it

**Where:** the convention is `src/lib/contractForm.ts`, `propertyForm.ts`, `tenantForm.ts`,
`unitForm.ts` — each exporting `<entity>FormSchema`, `<entity>FormDefaults` and a
`resolve<Entity>FormValues(editing)`, imported by **both** the route and the dialog
component:

| Entity | Shared `lib/…Form.ts` | Consumers |
| --- | --- | --- |
| Contract | ✓ `contractForm.ts` | `ContractFormDialog`, `ContractExtraChargesField`, `ContractMonthlyTotalCard` |
| Tenant | ✓ `tenantForm.ts` | `TenantFormDialog`, `routes/admin.tenants.index.tsx` |
| Unit | ✓ `unitForm.ts` | `UnitFormDialog`, `routes/admin.units.index.tsx` |
| Property | ✓ `propertyForm.ts` | — |
| **Payment** | **✗** | schema inlined at `routes/admin.payments.tsx:137` |
| **Expense** | **✗** | schema inlined at `routes/admin.expenses.tsx:95` |
| **Maintenance** | **✗** | schema inlined at `routes/admin.maintenance.index.tsx:79` |
| **Deposit** | **✗** | schema inlined in `routes/admin.deposits.tsx` |

**Which means** — and this is what upgrades **S04 #5** from a stylistic note to a real
finding — the pattern is not missing, it is *half-applied*. Four entities have a single
source of truth for their form shape that a component and a route both import; four do not,
and their schema lives inside a 587–924-line route component (S04 #2) where it cannot be
imported, cannot be tested on its own, and has no counterpart on the server. The
inconsistency is invisible from either side: nothing in `admin.expenses.tsx` suggests there
*should* be a `lib/expenseForm.ts`, and nothing in `lib/` records that four are missing.

The concrete cost is already visible in **S04 #3** — `classFromRecurrence`, a derivation rule
that belongs beside the expense schema, lives in the route file and silently overwrites a
value the importer can set. In the four entities that follow the convention, that rule would
have had an obvious home.

**Fix:** extract `lib/paymentForm.ts`, `lib/expenseForm.ts`, `lib/depositForm.ts` and
`lib/maintenanceForm.ts` following the existing four exactly — schema, defaults, and the
`resolve…FormValues` mapper. Do this **as part of** the S04 #2 component splits rather than
separately; the schema comes out naturally when the dialog moves into its own file.

---

## Not reported, and why

Six files were checked specifically because they are where a koshary usually forms, and each
is a counter-example worth naming:

- **`statusTone.ts` (448)** — the single status→badge-tone map for units, tenants, contracts,
  invoices, meters and reports, consumed by 10 component files. Its docblock says why it is
  centralised: *"Both tables answer the same question… the badge has to look identical on
  each or an operator reads them as two different states."* Exactly the reasoning this audit
  looks for, applied before the fact.
- **`queryRetry.ts` (108)** — retry policy by error class, with `RETRYABLE_HTTP_STATUS`,
  `PERMANENT_SQLSTATE_CLASSES` and a PGRST group-0 carve-out, each argued. It was written
  *because* the Roles screen fired thirteen requests at a table that does not exist (S06 #4).
- **`dateDisplay.ts` (133)** — seven exported functions covering every date rendering and
  parsing need, including RTL-aware display parsing. No inline `toLocaleDateString` drift
  found anywhere that matters.
- **`money.ts` (107)** — the display boundary, deliberately scoped, explicitly documented as
  *not* the place for arithmetic. **S01 #4**'s fils-rounding helper should go in a new file
  beside it, not inside it — this file's discipline is the reason.
- **`permissions.ts` (185)** — one `PERMISSIONS` catalogue, no second copy (S06).
- **`pagedQuery.ts` / `idChunks.ts` (123 / 112)** — the paging and chunking guards.
  Correctly written; **S05 #1–3** is about them not being *called*, not about them.
- **`nationalities.ts` (216), `commercialActivityOptions.ts` (104)** — reference data. Long
  because lists are long.

## Test coverage of this scope

The strongest in the repo: `money`, `csv`, `csvHeaders`, `contractCsv`, `tenantCsv`,
`pagedQuery`, `invoiceSettlement`, `exportAudit`, `documentDownloadName`, `xlsx`,
`adminTableSortValues` and others all have suites, and they test behaviour rather than
mocks. This is why S01 #4 and S04 #1 describe *placement* problems rather than correctness
ones — the rules in `src/lib` are right; the issue is who enforces them and from where.

The four `lib/*Form.ts` modules are **not** directly tested (they are exercised through the
dialogs), so finding 1's extraction is a good moment to add schema-level tests — the same
argument `submitContactInquiry.ts:8-10` already makes for exporting a schema so it can be
asserted.

**Consequence for Pass 2:** finding 1 is a move, not a rewrite, and typecheck catches every
mistake. Do it with the S04 #2 splits.

## Ledger entries added

See `LEDGER.md` — the `lib/<entity>Form.ts` convention and its four gaps; `statusTone`,
`queryRetry`, `dateDisplay`, `money`, `pagedQuery`/`idChunks` recorded as correct.
