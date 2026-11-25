# App enhancements batch (11 items) + dashboard aggregate RPC (row 2.4) — design

Date: 2026-09-23 · Branch: `feat/app-enhancements-batch` · Base: `origin/main` 9518ec0

## Goal

Ship eleven admin/portal enhancements requested by the owner plus the one open
anti-koshary row (2.4, dashboard aggregate RPC), deployed and verified on
production.

## Facts established before design (evidence)

Repository facts are at base commit 9518ec0. Prod facts are 2026-09-23
snapshots and are re-checked before release.

| Area | Fact | Where |
|---|---|---|
| Contracts KPIs | `useContractsSummary` receives the tab's `archiveMode`; the RPC accepts `'all'` | `admin.contracts.tsx:121-124`, `get_contracts_summary` |
| Contracts table | `type` column header/cell; `deposit` already on the row (`select *`); `formatKwd` already imported | `ContractsTable.tsx:106-108,185,31` |
| Tenant user dialog | picking a tenant **already** prefills email + `whatsapp ?? mobile` | `CreateUserDialog.tsx:111-118` |
| Tenant user save | `createAppUser` only sets `tenants.tenant_portal_enabled`, ignores its error | `createAppUser.ts:196-201` |
| Users search | server-side ilike on `profiles` only; no tenant name/code; `pageSize = 20`; shared `page` | `useUsers.ts:90-93`, `admin.settings.users.tsx:78,335-340` |
| Debounce | no `useDebounce` at base; no search is debounced | — |
| WhatsApp contacts | no `#` column; loading/empty rows `colSpan={8}` | `WhatsAppContacts.tsx:131-171` |
| Insurance | one-way sync contract.deposit → insurance_payments (client-side); nothing flows back; InsurancePanel has no `updatePermission` | `useContractInsurance.ts:52-123`, `PaymentSidePanels.tsx:490-513` |
| Payment links | `reservePaymentRequest` **already** reuses a pending link keyed by sha256(tenant, invoice ids) when amount + method match | `createPayment.ts:327-411` |
| Invoice state | `apply_payment_allocation` (217) and nightly `evaluate_overdue` (82) rank **overdue above partially_paid**; `recompute_invoice_from_confirmed` (153) ranks partially_paid first — the outlier. Prod: 0 invoices in `partially_paid`; 2 partially-paid invoices show `overdue` | 217:142-147, 82, 153:172-178 |
| INV-0007725 | prod now `paid` 700/700: two 350 KD cash partials (2026-08-29, 2026-09-23), allocations sum 700, both partials `complete` | prod query 2026-09-23 |
| Contract PDF | 11.5px / 1.45; logo 96×70; company 26px; title 20px; `html.pdf.test.ts` pins exactly 5 pages (runs when `CHROMIUM_PATH` resolves); server renders a temp **file** with Chromium; image has only Noto + DejaVu fonts | `contractBuilder/html.ts:80-121`, `serverPdf.ts:94-100,185`, `Dockerfile:42-48` |
| Dashboard | `fetchDashboardKpis` runs 9 queries (invoices paged, payments paged, 7 head counts/sums) | `useDashboardKpis.ts` |

## Decisions & deviations from the request

Decided by the orchestrator with the advisor (user direction 2026-09-23: "if you
want decisions ask the advisor") and the debate. Each is surfaced in the PR body.

| # | Request said | We do | Why |
|---|---|---|---|
| D1 | T10: partial payment must set `state='partially_paid'` | Keep DB precedence **overdue > partially_paid**; add a UI "partially paid · paid/total" indicator on `due`/`overdue` invoices with `paid > 0 && balance > 0` | nightly `evaluate_overdue` (82) already flips `partially_paid` → `overdue`, so a DB-level `partially_paid` survives only until midnight; overdue state is what reminders and the overdue KPI read |
| D2 | T10: amount strictly `< balance` | Keep `≤ balance` (reject `> balance`) | Today's real 350 KD partial equalled the balance and correctly closed INV-0007725; `<` makes the final instalment unrecordable. One-character flip if the owner insists |
| D3 | T10: invoke `recompute_invoice_from_confirmed` for INV-0007725 | No data fix; migration 218 aligns `recompute_invoice_from_confirmed` to overdue-wins | Prod data is already correct. 153's ordering causes a same-day flicker (partially_paid until the nightly flip; the dashboard "paid" KPI jumps then drops). 218 removes the flicker; that KPI effect is intended |
| D4 | T9: build link reuse | **No code change** — already implemented at `createPayment.ts:327-411` | a 24 h expiry would create *more* merchant-dashboard links, and each reset orphans a still-payable MyFatoorah invoice (no `ExpiryDate` is sent) — debate finding 1 |
| D5 | T3 Tenant → User prefill | Already done; no change | `CreateUserDialog.tsx:111-118` |
| D6 | T11 Cairo/Tajawal | Vendor Cairo (OFL) into `public/fonts/`; `@font-face` whose `src` the caller resolves: `/fonts/…` in the browser, absolute `file://…/fonts/…` in `serverPdf` | server renders a temp file, so `/fonts` would not resolve; `font-family: Cairo` alone is a no-op |
| D7 | T11 12.5px/1.55 | Apply; if `html.pdf.test.ts` (5 pages) fails for English, step down for `lang=en` only, never below 12px, and record the shipped value | the 11.5px comment concerns English page 1 |
| D8 | T4 "across the application" | 1000 ms debounce on the four named pages (contracts, invoices, users staff tab, WhatsApp contacts) | bounded scope; other pages are a follow-up |
| D9 | Part B "useDashboardStats" | The hook is `useDashboardKpis`; the RPC replaces its 9 queries only | name correction |
| D10 | T3 sync on save | Tenant-contact sync never fails the account call: it returns `{ synced, error? }`, surfaced as a warning toast | throwing after the auth user exists strands an account (debate 3) |
| D11 | T8 reverse sync | On insurance create **and** update (wires `insurance.update`); delete does not touch `contracts.deposit` | deposit is the contractual amount; delete semantics unchanged (debate 8) |

## Design per item

1. **KPI cards independent of tab** — `useContractsSummary({ search, state, archiveMode: "all" })`. The outstanding-balances query (`:126-145`): if it feeds a KPI card, that card must not depend on the tab either.
2. **Insurance Paid column** — header `t("contracts.insurancePaid")` (new key in `documents.ts`, ar "التأمين المدفوع", en "Insurance Paid"), sortKey `deposit`, cell `formatKwd(contract.deposit ?? 0, locale)`.
3. **User → Tenant sync** — in `createAppUser` (tenant kind) and `updateAppUser`: target = effective post-update tenant (payload `tenantId` if present, else the profile's; skip when `null`). Update `tenants.email` / `tenants.whatsapp` only for fields present and non-empty in the payload and different from stored ones; phone normalised as tenants store it. The result carries `tenantContactSynced` (D10). No `as any`.
4. **Debounce** — `src/hooks/useDebounce.ts` (landed in 0b13977). The debounced value feeds query keys and exports; page resets run in an effect on the debounced value; export is disabled while `search !== debouncedSearch`. `?q=` only seeds initial state.
5. **Tenant-user search** — tenants tab drops the server `search`, loads all tenant users with the repo's fetch-all paging, and filters client-side over display_name, username, email, phone and tenant name, name_en, code (extend the `tenantNames` map with `name_en`). No network debounce there. Tenant cell becomes `<Link to="/admin/tenants/$id" params={{ id }}>`.
6. **No pager on tenant users** — the tenants tab renders every row, with no `<Pager/>`. The staff tab keeps its pager.
7. **WhatsApp `#` column** — first column, `index + 1`, `w-12 text-center`; `colSpan` 8 → 9.
8. **Insurance → contract deposit** — after a manual `insurance_payments` create/update with a `contract_id`: `contracts.update({ deposit: amount }).eq("id", contract_id).select("id, deposit").single()`. An error **or no returned row** (RLS) shows a warning toast; insurance is not rolled back. Invalidate `["contracts"]`. Wire `INSURANCE_UPDATE` + `updatePermission` so edits exist. Forward sync is untouched.
9. **Link reuse** — no change (D4).
10. **Partial payments** — `useSettleableInvoices` also selects `total`. `RecordPanelDialog` shows read-only invoice total and remaining balance, plus helper text "Enter an amount up to {max} KD", where max is the balance (create) or `remainingForEdit` labelled "maximum" (edit). Validation stays `> max` → reject. `InvoicePartialIndicator({ state, paid, total })` renders only for `due`/`overdue` with `paid > 0 && paid < total`, in the tenant-detail invoice table, the admin invoices table and the portal invoice list. Migration 218 reorders `recompute_invoice_from_confirmed`'s CASE to paid → overdue → partially_paid → due.
11. **Contract PDF typography** — `.contract-sheet.doc-page` 12.5px / 1.55; `.contract-company` `'Cairo','Tajawal',<existing stack>` 28px/800; logo 110×80 contain; `.contract-title` 22px/800; vendored Cairo `@font-face` (D6).
12. **Row 2.4** (a refactor; formulas preserved byte-for-byte) — migration 219 `get_dashboard_aggregates()`: `security invoker` (RLS applies), `stable`, `set search_path = public`; `revoke execute … from public, anon`; `grant … to authenticated`. It returns one `jsonb` with exactly the fields `fetchDashboardKpis` computes today. `useDashboardKpis` calls the RPC, and the RPC is hand-added to `database.types.ts`. The SQL test runs it under `authenticated` claims (an admin plus one restricted staff role), compares each key to the equivalent direct query, and checks that anon is denied.

## As shipped (implementation notes)

- **D7 outcome.** At the field limits, English page 1 had no headroom: any header increase alone broke the 5-page test at 11.5px/1.45 (bisected on local Chrome, which passes the base). Shipped per-page sizing instead. Pages 2–5 use 12.5px/1.55. Page 1 uses 11.5px/1.45 in Arabic and 11px/1.45 in English. The header is at full spec size (logo 110×80, Cairo 28px/800, title 22px). The D7 12px floor holds for pages 2–5 only. Cairo-Bold is confirmed embedded in the server PDF's font dictionary.
- **D3 outcome.** Migration 218 made nine existing SQL tests fail (`depositInvoiceLink`, `partialPaymentDeleteLock`, `partialPaymentResync`, `partialPaymentSettlement`). They seed past-due invoices and asserted `partially_paid`. After 218 they read `overdue`, which matches `apply_payment_allocation` (217), the path portal/KNET payments already use. The assertions were updated. Future-due partials still read `partially_paid`, as pinned in `recomputeOverduePrecedence.sqltest.ts`.
- **D10 refinement.** A failed `tenant_portal_enabled` write has its own flag (`tenantPortalEnabled`) and its own warning. The tenant cannot sign in in that case, which is a different problem from an unmirrored email.

## Out of scope

- Debouncing pages other than the four.
- Changing overdue/partial precedence in favour of partial.
- Splitting over-ceiling files (`admin.invoices.tsx`, `PaymentSidePanels.tsx`, `createPayment.ts`). They must not grow past 600 lines.

## Follow-ups (issues filed from the PR)

- The existing amount-change reset in `reservePaymentRequest` keeps `created_at`, so a request older than 7 days that gets reset drops out of the reconcile window (debate 2).
- The dashboard "paid" KPI excludes money collected on overdue invoices (debate 14).
- Deleting an insurance record leaves `contracts.deposit` in place, and a later contract save recreates the row (debate 8).

## Release

Migrations 218 + 219 are backward-compatible (a function replace and a new
function). Runbook in the plan: full gates on the final PR head SHA →
`pg_dump` → transfer (chunked base64, per-chunk md5 against that SHA's files)
→ apply with `ON_ERROR_STOP=1` → `notify pgrst` → confirm via `pg_proc` →
merge → confirm the deployed SHA → per-feature live checks. If a migration
fails, there is no merge.
