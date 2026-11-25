# App enhancements batch — implementation plan

Spec: `docs/superpowers/specs/2026-09-23-app-enhancements-batch-design.md`
Integration branch: `feat/app-enhancements-batch` (worktree `F:/Danat-Mostakbal-enh`)

## Goal (closes the run)

Terminal state **deployed and verified**. Closes only when:
- `bun run lint`, `typecheck`, `test`, `test:sql` are green on the final PR head SHA, and the branch is up to date with `main`, so the merge tree equals the tested tree.
- clean-code-guard, test-guard and docs-guard are clean, and requesting-code-review is addressed.
- Migrations 218 + 219 are applied to prod **before** merge, per the release runbook, and confirmed in `pg_proc`.
- The PR is merged after the bot review.
- The deployed SHA is confirmed and the live per-feature checks below pass.

## Global constraints (quote verbatim in every brief)

1. Keep every new file under 500 lines. `src/routes/admin.invoices.tsx` (524),
   `src/components/admin/PaymentSidePanels.tsx` (513) and `src/fns/createPayment.ts`
   (584) are already over 500: do **not** grow them past 600, put new logic in new
   files, and do **not** split or refactor them.
2. Every new or changed function gets a doc comment **above** it that leads with an
   Arabic description; English may follow for the *why*. Comments explain why,
   never restate what.
3. i18n: add every key to BOTH `src/i18n/locales/ar/<module>.ts` and
   `src/i18n/locales/en/<module>.ts`, only in the module your slice owns. The
   parity test fails otherwise.
4. Money: use `formatKwd`/`formatAmount` from `src/lib/money.ts` and `roundToFils`
   from `src/lib/fils.ts`; never hand-format KD.
5. Server-fn permission checks go through `requirePermission`
   (`src/fns/requirePermission.ts`). Never `throw new Response(...)` in `src/fns`.
6. No `as any` in new code. Surface every Supabase `{ error }` — never swallow it;
   abort only before the first durable write, and after that return an explicit
   flag the UI shows.
7. Do NOT commit, push, branch, or rebase. Do NOT run `bun run test:sql`,
   `bun run test:db` or `bun run gen:types`. Do NOT touch production or any MCP
   server. Do NOT edit files outside your slice's list. Do NOT edit
   `src/routeTree.gen.ts`.
8. Gates to run in your worktree: `bun run typecheck`, `bun run lint`,
   `bun run test`. Report exact output.
9. User direction 2026-09-14, verbatim: "If any model goes out of quota
   (like GLM5.3 ), continue and delegate to Codex Astra 6 medium effort."

## Shared interface (landed in 0b13977)

```ts
// src/hooks/useDebounce.ts
export const SEARCH_DEBOUNCE_MS = 1000;
export function useDebounce<T>(value: T, delay = SEARCH_DEBOUNCE_MS): T
```
Debounce rule for every slice: the input keeps its own `search` state;
`const debouncedSearch = useDebounce(search)` feeds query keys and exports; any
"reset page to 1" moves to a `useEffect` on `debouncedSearch`; an export button
is disabled while `search !== debouncedSearch`.

## Slices

### Slice A — contracts page (GLM) · spec items 1, 2, 4
Files: `src/routes/admin.contracts.tsx`, `src/components/admin/contracts/ContractsTable.tsx`,
`src/i18n/locales/{ar,en}/documents.ts`.
- A1: `useContractsSummary` called with `archiveMode: "all"`. Read the
  outstanding-balances query (`:126-145`). If it feeds a KPI card, make that
  card tab-independent. If it feeds only the table's outstanding column, leave it.
- A2: replace the `type` column with **Insurance Paid** (`contracts.insurancePaid`:
  ar "التأمين المدفوع", en "Insurance Paid"), `sortKey="deposit"`, cell
  `formatKwd(contract.deposit ?? 0, locale)`.
- A3: debounce rule applied to `useContracts`, `useContractsSummary`, `useContractExport`.
Acceptance: switching Current/Archived/All leaves the KPI query key unchanged;
the table shows KD insurance and sorts by it; typing fires one query ~1 s after
the last keystroke.

### Slice B — users page + tenant sync (GLM) · spec items 3, 4, 5, 6
Files: `src/routes/admin.settings.users.tsx`, `src/components/admin/users/UsersTable.tsx`,
`src/components/admin/users/CreateUserDialog.tsx`, `src/components/admin/users/EditUserDialog.tsx`,
`src/hooks/useUsers.ts`, `src/fns/createAppUser.ts`, `src/fns/updateAppUser.ts`,
new `src/fns/syncTenantContact.ts`, `src/i18n/locales/{ar,en}/users.ts`.
- B1: `syncTenantContact(tenantId, { email?, phone? }): Promise<{ synced: boolean; error?: string }>`
  runs server-side with `supabaseAdmin`. It reads the tenant and updates `email` / `whatsapp`
  only for fields present and non-empty that differ from the stored values.
  The phone is normalised exactly as `createAppUser` already normalises it. It never throws.
  - `createAppUser` (tenant kind) calls it after the account exists, and also checks the existing
    `tenant_portal_enabled` update's error the same way.
  - `updateAppUser` calls it for the effective post-update tenant: the payload `tenantId` if
    present, otherwise the profile's current `tenant_id`; skip when that is `null`.
  - Both return `tenantContactSynced: boolean`. The dialogs show a warning toast
    (`users.tenantContactSyncFailed`) when it is false; success toasts are unchanged.
- B2: tenants tab loads **all** tenant-scope users. Use the repo's existing fetch-all paging
  helper (`fetchAllOffsetPages` or the `fetchAll` from PR #160; find it) through a new
  `useAllTenantUsers()` in `useUsers.ts`, with no server search. Filter client-side over
  display_name, username, email, phone and tenant name, name_en, code; extend the
  `tenantNames` map to carry `name_en`. No `<Pager/>` on that tab. Row numbers are
  1..N over the filtered list.
- B3: staff tab keeps server search + pager, with the debounce rule applied.
- B4: `UsersTable` tenant cell → `<Link to="/admin/tenants/$id" params={{ id: profile.tenant_id }}>`
  (route file `src/routes/admin.tenants.$id.tsx` exists).
Acceptance:
- Searching a tenant code on the tenants tab shows that tenant's user.
- Clicking the tenant name opens the tenant page.
- Every tenant user appears on one page.
- Creating or editing a tenant user with a new email updates `tenants.email`.
- A sync failure shows a warning and the user still exists.

### Slice C — WhatsApp contacts (GLM) · spec items 4, 7
Files: `src/components/admin/whatsapp/WhatsAppContacts.tsx`.
- `#` first column: `<TableHead className="w-12 text-center">#</TableHead>`, with the cell
  `<TableCell className="w-12 text-center font-mono text-xs text-muted-foreground">{index + 1}</TableCell>`.
- `sorted.map((contact, index) => …)`; colSpan 8 → 9.
- The debounced search feeds `useWhatsAppContacts`.

### Slice D — insurance + partial payments (GLM, dispatched last) · spec items 4, 8, 10-UI
Files: `src/components/admin/PaymentSidePanels.tsx` (≤600), `src/components/admin/RecordPanelDialog.tsx`,
`src/hooks/useInvoices.ts` (only `useSettleableInvoices`' select), new `src/hooks/useInsuranceDepositSync.ts`,
`src/lib/permissions.ts` (or wherever `PERMISSIONS` lives; add `INSURANCE_UPDATE: "insurance.update"` only),
`src/components/admin/tenant-detail/InvoiceRowsTable.tsx`, `src/routes/admin.invoices.tsx` (≤600),
`src/routes/portal.invoices.tsx` (indicator only), new `src/components/shared/InvoicePartialIndicator.tsx`,
`src/i18n/locales/{ar,en}/invoices.ts`.
- D1 (item 8): `useInsuranceDepositSync().sync(contractId, amount)` runs
  `contracts.update({ deposit: amount }).eq("id", contractId).select("id, deposit").single()`.
  An error or a missing row shows a warning toast (`insurance.depositSyncFailed`), and
  insurance is not rolled back. Invalidate `["contracts"]`. Called after InsurancePanel
  create and update succeed for a row with `contract_id`. InsurancePanel gets
  `updatePermission={PERMISSIONS.INSURANCE_UPDATE}`. One sentence in
  `useContractInsurance.ts`'s doc comment: reverse sync is create/update only; delete
  leaves the deposit.
- D2 (item 10): `useSettleableInvoices` also selects `total`. RecordPanelDialog, once an
  invoice is picked, shows read-only "Invoice total" and "Remaining balance", plus helper
  text `partialPayments.amountHint` "Enter an amount up to {max} KD".
  - `max` = the balance on create, or `remainingForEdit` on edit, labelled
    `partialPayments.maxForEdit`.
  - The pinned edit-context invoice must supply `total` too; extend that select where it is built.
  - Validation is unchanged (`value > max` rejects).
- D3 (item 10): `InvoicePartialIndicator({ state, paid, total })` renders
  `invoices.partiallyPaidIndicator` "Partially paid · {paid} / {total} KD" only when
  `state` is `due` or `overdue` and `0 < paid < total`. It sits next to the state badge
  in InvoiceRowsTable, the admin invoices table and the portal invoice list.
- D4: debounce rule applied to the admin invoices search.

### Slice E — contract PDF typography (GLM) · spec item 11
Files: `src/lib/contractBuilder/html.ts`, `src/lib/documentFonts.ts`, `src/lib/serverPdf.ts`,
`public/fonts/Cairo-Regular.ttf`, `public/fonts/Cairo-Bold.ttf`, `public/fonts/OFL-Cairo.txt`.
- CSS values per spec item 11.
- Cairo files: download from the google/fonts GitHub repo (`ofl/cairo`, static
  or variable TTF, OFL), and include the license.
- `documentFonts.ts` exports `cairoFontFace(baseUrl: string)`. The browser passes `/fonts`;
  `serverPdf` passes a `file://` URL of the absolute fonts directory. Resolve it from
  `process.cwd()`, trying `.output/public/fonts` (production image) then `public/fonts` (dev),
  and pick the first that exists.
- Verify: `CHROMIUM_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" bunx vitest run src/lib/contractBuilder`.
  `html.pdf.test.ts` must run (not skip) and report 5 pages for both languages.
  - If English overflows, step down for `lang=en` only, never below 12px, and report the shipped values.
  - Report whether "Cairo" appears in the produced PDF's font names.

### Slice F — migrations (Muse Spark, Migrations lane) · spec items 10-SQL, 12-SQL
Files: `db/migrations/218_recompute_overdue_precedence.sql`, `db/migrations/219_dashboard_aggregates_rpc.sql`.
- 218: `create or replace function public.recompute_invoice_from_confirmed`. Copy the body of
  153:141-181 unchanged, except the CASE becomes paid → overdue → partially_paid → due.
  Preserve the signature, security, search_path and grants exactly as 153 (re-issue grants
  if 153 had them).
- 219: `public.get_dashboard_aggregates()` returns `jsonb` with keys `outstanding, paid,
  overdue_amount, overdue_count, payments_this_month, tenants, active_tenants, units,
  occupied_units, properties, employees, salaries_paid`. Formulas are exactly as
  `fetchDashboardKpis` in `src/hooks/useDashboardKpis.ts` (read it; month boundaries in UTC,
  as the TS does). Declare it `language sql stable security invoker set search_path = public`,
  then `revoke execute … from public, anon; grant execute … to authenticated;`.
- LF line endings, `$$` tags, idempotent.

### Slice G — dashboard hook (GLM, after F lands) · spec item 12-TS
Files: `src/hooks/useDashboardKpis.ts`, `src/integrations/supabase/database.types.ts` (hand-add
the RPC entry in the existing Functions shape; never regenerate).
- `fetchDashboardKpis` makes one `supabase.rpc("get_dashboard_aggregates")` call, maps
  snake_case to the existing return shape, and throws on error. Same query key.

### Tests (agy Gemini 3.8 high, after slices land)
- Unit tests:
  - `syncTenantContact`: skip empty or unchanged fields, report failure without throwing.
  - `InvoicePartialIndicator` render rules, covering all 6 states.
  - Tenant-users client filter: matches on tenant code and name_en.
  - `fetchDashboardKpis` mapping and error propagation.
  - `useInsuranceDepositSync`: a missing row counts as failure.
- SQL tests (`src/db/*.sqltest.ts`):
  - 218: an overdue partially-paid invoice recomputes to `overdue`; a future-due partial
    recomputes to `partially_paid`.
  - 219: under `authenticated` claims (admin plus one restricted staff role; GUC
    `request.jwt.claim.sub`), each key equals the equivalent direct query on seeded rows,
    including an overdue partial excluded from `paid` and a UTC month boundary; anon
    execution is denied.
- The orchestrator runs `TEST_DB_PORT=55329 bun run test:sql` serially.

## Dispatch order
- A, B, C, E, F dispatch in parallel from the commit carrying this plan, in worktrees
  `F:/Danat-enh-{a,b,c,e,f}` with node_modules junctions, staggering `opencode run` by ~20 s.
- Then D.
- Collect in the order F, A, B, C, E, D, then G.
- Then tests, then guards.
- Then the full suite, run serially with `.vite` cleared.
- Then review, then the release runbook.

## Release runbook
1. Final PR head SHA: branch up to date with `origin/main`; lint, typecheck, test and
   test:sql all green on that SHA.
2. Run `pg_dump` on prod (nohup + status file), then transfer 218 and 219 via chunked base64.
   Match each chunk's md5, and the file md5, against that SHA's files.
3. Apply with `psql -v ON_ERROR_STOP=1`, run `notify pgrst, 'reload schema'`, and confirm
   both functions in `pg_proc` along with the 218 CASE order. **Migration failure ⇒ no merge.**
4. Merge the PR, then confirm the Dokploy-deployed SHA equals the merge commit.
5. Live checks on https://danat-future.com:
   - The dashboard loads (RPC 200).
   - Contracts KPI cards match across tabs, and the Insurance Paid column shows.
   - Users tenant-code search works and the tenant link opens.
   - The WhatsApp `#` column shows.
   - The partial indicator shows on an overdue partial (INV-0003085).
   - A contract PDF downloads with 5 pages and Cairo in its fonts.
   - Assert data changes via the DB where the UI uses native `confirm()`.

## Debate — round 1 (Codex astra 6 medium, `gpt-6-astra --effort medium`, relay `--read-only` sandbox)

| # | Finding | Sev | Verdict | Reason |
|---|---------|-----|---------|--------|
| 1 | Link expiry orphans the old payment's reconciliation | P1 | accept | Dropped the 24 h bound; Task 9 is already implemented (D4) |
| 2 | Reset requests fall out of the 7-day reconcile window | P1 | partial | Real, but it lives on the pre-existing amount-change reset path, which is out of scope once D4 drops; filed as a follow-up |
| 3 | Throwing tenant sync strands a created account | P1 | accept | Sync returns `{ synced }`, and the UI warns (D10, constraint 6) |
| 4 | Sync target ambiguous on reassignment | P2 | accept | Effective post-update tenant; present, non-empty fields only; skip when null |
| 5 | pageSize 1000 is not "all"; map lacks name_en | P2 | partial | Fetch-all paging and name_en added; server search not restored (scale is tiny, client filter is complete) |
| 6 | Error-only check misses RLS zero-row updates | P1 | accept | `.select().single()`; a missing row counts as failure |
| 7 | No insurance update path exists | P2 | accept | Wire `INSURANCE_UPDATE` + `updatePermission` |
| 8 | Insurance delete/forward sync contradictions | P2 | reject | Deposit is the contractual amount; delete/forward semantics are the documented existing design (`useContractInsurance.ts:33-46`), out of scope; follow-up filed |
| 9 | No `total` in settleable invoices; edit max differs | P2 | accept | Select `total`; edit shows `remainingForEdit` as "maximum" |
| 10 | Indicator cannot see state | P2 | accept | Pass `state`; due/overdue only |
| 11 | Cairo cannot resolve via `/fonts` in file-rendered PDF | P1 | accept | Caller-resolved `file://` base; test runs with `CHROMIUM_PATH`; 12px floor |
| 12 | Debounce vs page reset/export/URL | P2 | accept | Page reset on the debounced value; export disabled while unsettled; URL only seeds |
| 13 | Anon-denied test proves nothing about RLS | P2 | partial | Run under authenticated admin + restricted staff; tenant skipped (dashboard is staff-only) |
| 14 | 218 changes the "paid" KPI; D1 rationale overstated | P2 | partial | Rationale corrected (82 flips nightly); the KPI effect is intended and pinned; formula kept; follow-up filed |
| 15 | Verification after auto-deploy | P1 | accept | Release runbook: gates on the final SHA, migrations before merge, deployed SHA confirmed |
| 16 | Completion gate too weak; docs-guard missing; stale fact | P2 | accept | Per-feature live checks, docs-guard, fact table dated to base 9518ec0 |
