# S16 — `src/hooks`: A–M

**Lines read:** ~7,000 · **Files:** ~45 · **Date:** 2026-09-22

`useLandingSettings` (653) · `useContracts` (597) · `useInvoices` (514) ·
`useExpenses` (357) · `useGmailMessages` (345) · `useContractCloseouts` (328) ·
`useDeposits` (279) · `useBuildings` (249) · `useMeterReadings` (238) ·
`useEmployees` (219) · `useContractRelations` (214) · `useMaintenance` (205) ·
`useCustomRoles` (193) · `useLinkedBrand` (193) · `useElectricityMeters` (189) ·
`useElectricityCharges` (186) · `useCronJobs` (179) · `useEvolutionConnection` (167) ·
`useContractInsurance` (139) · `useElectricityTariffs` (129) · `useDeviceProfile` (113) ·
`useEmailSignatures` (110) — plus ~23 smaller.

**Overall:** consistent, readable CRUD hooks with one shape each — `fetchX(params)` →
`useX` / `useXExport` / `useCreateX` / `useUpdateX` / `useDeleteX`. The consistency is what
makes the one finding possible to state precisely: the same line is wrong in eight of them,
in four different ways.

---

## Findings

### 1 · High — every CSV export silently truncates, at four different limits

**Where:**

| Export | Requested `pageSize` | Actually returns | Site |
| --- | --- | --- | --- |
| Deposits | 5000 | **1000** (PostgREST cap) | `useDeposits.ts:114` |
| Expenses | 5000 | **1000** | `useExpenses.ts:144` |
| Buildings | 500 | **500** | `useBuildings.ts:62` |
| Maintenance | 500 | **500** | `useMaintenance.ts:101` |
| Properties | 500 | **500** | `useProperties.ts:215` |
| Units | 500 | **500** | `useUnits.ts:162` |
| Tenants | 500 | **500** | `routes/admin.tenants.index.tsx:137` |
| Contracts | 500 | **500** | `routes/admin.contracts.tsx:145` |
| **Reports** | — | **complete** | `useReportPreview.ts:93` — `fetchAllPages` ✓ |
| **Invoices** | — | **complete** | `useInvoices.ts:261` — `fetchAllInvoicePages` ✓ |

There is no shared constant. `500` and `5000` are magic numbers repeated across six files,
and `5000` is a number the author chose that the server will not honour —
`PGRST_MAX_ROWS = 1000` (`lib/idChunks.ts:29`) clips it, silently, exactly as that file's
own comment warns.

**Which means:** an operator clicks "Export CSV" on Tenants, Contracts, Units, Properties,
Buildings or Maintenance and receives **at most 500 rows** with no warning, no banner and no
error — while the list screen beside it *does* show a `listTruncated` banner, because that
banner is driven by the list query's separate cap. Deposits and Expenses get 1,000. The two
exports that are complete are the two that were fixed after incidents: report exports in
PR #192 (2026-09-07, documented at `docs/B1-bound-growing-queries-report.md:111`, which
records that they *"exported the first 1,000 silently"*) and invoices via `fetchAll`.

Nothing is lost today at ~70 units. Expenses and maintenance accumulate monthly, contracts
and deposits per lease — and the failure, when it arrives, is a finance export that is
quietly missing rows, which is the worst possible shape for this particular product.

**Fix:** route all eight through `fetchAllPages` from `lib/pagedQuery.ts` — the helper that
already exists, is already tested, and already fixed this for reports. If a hard ceiling is
wanted for safety, make it one exported constant and render the `listTruncated` banner on
the export button too, so a truncated CSV is never silent. **This is the single highest
value-per-line fix in the audit.**

---

### 2 · Medium — the paging guards exist, are correct, and are called by 2 of 10 list hooks

**Where:** `lib/pagedQuery.ts` (`fetchAllPages`, 123 lines, tested) ·
`lib/idChunks.ts` (`PGRST_MAX_ROWS`, `assertNotRowCapped`, `fetchInChunks`, 112 lines) ·
`useInvoices.ts:128` (`fetchAllInvoicePages`)

Consumers: `useReportPreview` and `useInvoices` use the page loops; `portal.invoices.tsx`
uses `fetchInChunks`; `assertNotRowCapped` has **3** call sites out of ~20 unranged reads (S05 #2).

**Which means:** finding 1, S05 #1 (the dashboard) and S05 #3 (`attachTenantLocations`) are
all the same finding seen from three directions — a correct, tested, documented guard that
the codebase reaches for only after something has already gone wrong. The gap is not
knowledge; it is that nothing makes an unguarded read visible.

**Fix:** wire `assertNotRowCapped` into `fetchX` in the shared hook shape so every list query
warns when it comes back at exactly the cap. One line in each `fetchX`, and it converts
every remaining instance of this class — including ones this audit did not reach — into a
console warning instead of a wrong number.

---

## Not reported, and why

- **The CRUD hook family shape itself.** Ten hooks repeat `fetchX(params)` with
  `.range()`, `.order()`, a chain of `.eq()` filters and a
  `normalizePostgrestSearch(...).or(ilike)` clause, then `useX` / `useXExport` /
  `useCreateX` / `useUpdateX` / `useDeleteX`. It *looks* like the notify-sender duplication
  of S02 #4 and is **not the same**: each entity's columns, filters and searchable fields
  genuinely differ, and a shared `createCrudHooks<T>()` would need a config object per
  entity that is longer than the code it replaces — the reference's test for an extraction
  that makes things worse. What *is* coupled inside that shape is the export cap, and that
  is finding 1. **Do not merge the hooks.**
- **`useInvoices.ts:31-34`'s `fetchAll` option** — correct, documented (*"see
  `fetchAllInvoicePages` for why a page cap was the wrong shape"*), and used by four call
  sites. The model finding 1's fix should follow.
- **`useCustomRoles.ts` (193 lines, 11 `as never`/`as any`)** — counted in **S06 #4**; the
  casts exist because migration 16 was never applied. Not a separate hooks finding.
- **`useLandingSettings.ts` (653 lines, 23 exports)** — the largest hook file, but it is 23
  small hooks over five landing tables, not one large one. Length without the symptoms.
- **`useContractCloseouts.ts:292,318`** — the duplicate browser-written audit rows. That is
  **H3**, counted in S01.
- **`useDeviceProfile`, `useEmailSignatures`, `useEvolutionConnection`** — small, single
  purpose, nothing to say.

## Test coverage of this scope

Several hooks have suites (`useInvoices`, `useContracts`, `useEditPartialPayment`,
`useContractCloseouts` among them), and `lib/pagedQuery` — the helper finding 1 needs — is
tested independently.

**Finding 1 is untested in every one of the eight cases**, which is exactly how two of the
ten got fixed and eight did not: the only way this surfaces is a user noticing a short CSV.
Add one test per export asserting that a dataset larger than the cap comes back whole; it is
the cheapest possible guard against a regression.

**Consequence for Pass 2:** finding 1 is a swap to an already-tested helper — safe on the
current suite, but write the test first so the fix is provable. Finding 2 is additive
(a `console.warn`) and cannot break anything.

## Ledger entries added

See `LEDGER.md` — the export-cap table, the paging-guard consumers, the CRUD hook shape
(recorded as *do not merge*).
