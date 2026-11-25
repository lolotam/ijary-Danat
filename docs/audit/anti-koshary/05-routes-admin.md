# S05 — `src/routes`: admin non-money (dashboard, tenants, units, properties, maintenance, inbox, employees, audit, reports)

**Lines read:** ~6,140 · **Files:** 16 · **Date:** 2026-09-22

`admin.inbox.tsx` (1035) · `admin.maintenance.index.tsx` (636) · `admin.properties.index.tsx` (592) ·
`admin.employees.tsx` (557) · `admin.tenants.index.tsx` (549) · `admin.units.index.tsx` (448) ·
`admin.index.tsx` (402) · `admin.audit.tsx` (387) · `admin.units.$id.tsx` (374) ·
`admin.properties.$id.tsx` (367) · `admin.tenants.$id.index.tsx` (326) · `admin.reports.tsx` (320) ·
`admin.tsx` (146) · `admin.tenants.$id.documents.tsx` (86) · `admin.electricity.tsx` (56) ·
`admin.tenants.$id.tsx` (9).

**Overall:** exports, permissions and list truncation are handled *well and consistently*
across all of these — see "Not reported". The finding is that the **dashboard** is the one
screen that skipped every one of those conventions, and it is the screen that reports money.

---

## Findings

### 1 · High — the dashboard's money KPIs silently stop being correct at 1,000 invoices, and the repo already has the fix

**Where:** `src/routes/admin.index.tsx:69` · `src/lib/idChunks.ts:29` · `src/lib/pagedQuery.ts`

```ts
supabase.from("invoices").select("state, total, balance"),   // no .range(), no paging
```

Every other row is then summed **in the browser** (`admin.index.tsx:110-124`) into
`invoicesOutstanding`, `invoicesPaid`, `invoicesOverdue` and `overdueCount`.

This deployment's PostgREST is capped: `src/lib/idChunks.ts:29` declares
`export const PGRST_MAX_ROWS = 1000`, and `idChunks.ts:34` states the rule —

> *"A query with no `.range()` is capped at `PGRST_MAX_ROWS`, and the clip is [silent]."*

**Which means:** past 1,000 invoice rows the dashboard receives the first 1,000, no error,
no indication, and reports **understated** outstanding, paid and overdue totals — the four
numbers the owner looks at first. This is not a distant risk: at ~70 units the portfolio
generates roughly 840 invoices a year, so the cap is crossed in **about 14 months** of
normal operation, and the failure arrives as "the dashboard disagrees with the invoices
page" with nothing in the logs.

The repo has already fought and won this exact battle elsewhere:
`docs/B1-bound-growing-queries-report.md:111` records that report CSV exports silently
clipped at 1,000 rows between PR #74 and 2026-09-07 and were fixed with `fetchAllPages`
(`src/lib/pagedQuery.ts`). `useInvoices` has a `fetchAll` option for the same reason
(`useInvoices.ts:31-34`) and four call sites use it. The dashboard uses neither.

**Fix — two options, and the second is better.**
(a) Immediate: wrap the select in `fetchAllPages` from `lib/pagedQuery.ts`. One line, matches
the fix already shipped for reports.
(b) Correct: these are four `SUM`s and a `COUNT` grouped by state. Push them into an RPC —
the dashboard currently makes **nine** round trips and ships every invoice row to the
browser to compute numbers Postgres can return in one. Five of the nine are already
`head: true` counts, so the pattern is understood; the two that pull rows (`invoices`,
`payments`) are the two that grow without bound.

---

### 2 · Medium — `assertNotRowCapped`, the guard written for exactly this bug, is used in 3 places out of ~20

**Where:** `src/lib/idChunks.ts:41-48`

```ts
if (rows.length < PGRST_MAX_ROWS) return;
console.warn(`${subject} returned ${PGRST_MAX_ROWS} rows, the server's cap for a request
  with no range, so the list is probably incomplete.`);
```

Grepped across `src/` including tests: **no usages**.

**Which means:** someone identified the silent-clip class of bug, wrote the detector, and it
was never wired to a single query — including the dashboard query in finding 1, which is
precisely what it describes. The repo's recurring written-but-never-read shape, here costing
the early warning that would have caught finding 1 before a user did.

**Fix:** call it at the five or six unguarded read sites (finding 1, finding 3), or delete
it. Leaving a guard that guards nothing is the worse of the two, because the next reader
assumes the clip is already detected somewhere.

---

### 3 · Medium — four more unbounded reads behind the tenants list

**Where:** `src/hooks/attachTenantLocations.ts:178-182` (`contracts`), `:190-198`
(`contract_units`), `:218` (`units` — `select("*")`), `:222-230` (overdue `invoices`)

None carries `.range()`, a page loop, or `assertNotRowCapped`. Every tenant list render fans out
to four full-table reads filtered only by `.in(...)` on the current page's tenant ids —
which does bound the first two, but `contract_units` grows per contract-unit line and the
overdue-invoice read is filtered only by `state` and `balance`, not by tenant.

**Which means:** the same silent clip as finding 1, one step removed and harder to notice —
a tenant whose overdue arrears fall past row 1,000 shows a clean balance on the tenants
list while the invoices page shows the debt. `contract_units` is the fastest-growing of the
four.

**Fix:** put the overdue read behind the same paging helper, and add `assertNotRowCapped` to all
four. Cheap, and it converts a silent wrong answer into a console warning.

---

### 4 · Medium — five more oversized list components (extends S04 #2)

| Component | Lines | `useState` | Also holds |
| --- | --- | --- | --- |
| `InboxPage` (`admin.inbox.tsx:104-865`) | **762** | **19** | thread list, message view, compose, attachments, WhatsApp/Gmail provider switch |
| `MaintenancePage` (`admin.maintenance.index.tsx:93-`) | ~540 | 15 | list, filters, form, delete, export |
| `PropertiesPage` (`admin.properties.index.tsx`) | ~520 | 12 | list, filters, form, buildings, export |
| `EmployeesPage` (`admin.employees.tsx`) | ~480 | 10 | list, form, salaries |
| `TenantsIndexPage` (`admin.tenants.index.tsx`) | ~480 | 11 | list, filters, form, import, export |

**Which means:** with S04's three, the admin app has **eight** components between 480 and
989 lines, each carrying 10–19 independent pieces of state. `admin.tenants.index.tsx` is the
single most-churned route file in the repo (58 changes in 12 months) and
`admin.inbox.tsx` is 25 — these are the files people actually edit, and each edit means
holding a 19-variable scope in your head to be sure nothing else reads what you moved.

**Fix:** same shape as S04 #2 — split by feature, lift the state with it. `InboxPage` first:
it is the largest, it has the most state, and its compose/attachment concerns already have
components in `components/admin/compose/` to move toward.

---

## Not reported, and why

These were checked specifically because they are the usual suspects, and they are **done
correctly** — worth recording so Pass 2 does not disturb them:

- **CSV export** — centralised in `lib/csv.ts` (`downloadCsv`, `exportRecordsToCsv`) with
  per-entity row mappers in `lib/contractCsv.ts`, `lib/tenantCsv.ts`. The `exportX()`
  functions in each route are thin mappers, not duplicated machinery. Correct as is.
- **Export permissions** — all fourteen `*_EXPORT` codes exist and every list screen gates
  its export on its own (`CONTRACTS_EXPORT`, `TENANTS_EXPORT`, `UNITS_EXPORT`,
  `PROPERTIES_EXPORT`, `MAINTENANCE_EXPORT`, …). No gaps found.
- **Export permission and wiring** — every screen exports from a **separate** `useXExport`
  query rather than from the on-screen page, so the CSV is not clipped to the *visible* rows.
  ⚠️ **Corrected in S16:** that does not make the exports complete. Each carries its own
  hard `pageSize` cap (500 or 5000, and PostgREST clips 5000 to 1000), so every CSV silently
  truncates. See **S16 #1** — that supersedes the "avoided the trap" reading here.
- **`listTruncated`** — wired on contracts, tenants and units (S04). Honest about the cap.
- **`admin.audit.tsx`** — 387 lines across **8** small components. The counter-example to
  finding 4, in the same directory.
- **`admin.units.$id.tsx`** — 374 lines, **zero** `useState`, four `useMemo`. Pure
  presentation over hooks. Also a counter-example.
- **`Row` in `admin.properties.$id.tsx:360`** — a 3-line label/value pair used only in that
  file. Coincidental with the `Field` components in S04 #4; not the same thing, do not merge.

## Test coverage of this scope

Effectively none at the route level — there are no `admin.inbox`, `admin.index`,
`admin.tenants.index` or `admin.maintenance` test files. The underlying hooks and libs are
tested (`useInvoices`, `lib/csv`, `lib/pagedQuery`, `lib/contractCsv` all have suites), so
the *pieces* are covered and the *assembly* is not.

**Consequence for Pass 2:** finding 1(a) is a one-line change with `fetchAllPages` already
tested underneath it — low risk, but verify the dashboard numbers in the running app since
nothing asserts them. Finding 1(b) is a new RPC and needs a SQL test (`bun run test:sql`).
Finding 4 is a large uncovered refactor: small commits, one feature per commit, manual check
of each screen. Finding 2 is delete-or-wire, both trivial.

## Ledger entries added

See `LEDGER.md` — the unbounded reads, `PGRST_MAX_ROWS` / `fetchAllPages` / `assertNotRowCapped`,
the oversized components, the export conventions (recorded as *correct*, so later scopes do
not re-flag them).
