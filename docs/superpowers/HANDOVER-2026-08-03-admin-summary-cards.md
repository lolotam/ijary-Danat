# HANDOVER — Admin summary cards

**Date:** 2026-08-03
**Branch:** `feat/admin-summary-cards` (off `main` at `ad654fa`)
**For:** Grok, continuing this work
**Status:** **SHIPPED.** PR [#71](https://github.com/lolotam/Dana-kuwait/pull/71)
merged to `main` (`7d0dc26`), migration 79 applied to production, PostgREST cache
reloaded, all five RPCs verified live and cross-checked against
`get_budget_summary`. See §9 for the verification record.
Outstanding: a human still needs to eyeball the rendered cards in a browser.

---

## 1. What this feature is

A row of KPI cards above the table on five admin list pages — `/admin/payments`,
`/admin/expenses`, `/admin/contracts`, `/admin/tenants`, `/admin/units`. Each
card carries a money total _and_ a record count, computed server-side from the
page's active filters.

Read these two first, in order — they contain the reasoning, not just the what:

- `docs/superpowers/specs/2026-08-03-admin-summary-cards-design.md`
- `docs/superpowers/plans/2026-08-03-admin-summary-cards.md`

---

## 2. Commits on this branch

```
bcdacad fix(test): type the summary SQL helper and prove silent card failure
cca0f7d docs: add handover for admin summary cards work
5b238ca test(db): scope module-summary SQL assertions to their own fixtures
b91ddaa feat(admin): show filter-aware KPI summary cards on five list pages
b93349b feat(admin): add summary-card scaffolding, money helper and i18n keys
028bd65 feat(db): add module summary RPCs for admin list-page KPI cards
5755454 docs: add admin summary cards spec and implementation plan
```

Working tree is **clean for this feature**. (`git status` shows a large volume
of unrelated modified/untracked files — `graphify-out/`, `stitch_*/`, `spec/`,
`specs/`. Those are not this work. **Always `git add` by explicit path. Never
`git add -A` or `git add .`.**)

---

## 3. What exists now

**Database — `db/migrations/79_module_summary_rpcs.sql`** (353 lines, 5 functions):

| Function                | Args                                                                      | Returns (jsonb keys)                                                             |
| ----------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `get_payments_summary`  | `p_search, p_method, p_status, p_tenant_id`                               | `full/partial/insurance/refunds` each `{total,count}`, plus `net`                |
| `get_expenses_summary`  | `p_search, p_class, p_category_id, p_property_id, p_status, p_from, p_to` | `total/approved/pending/this_month` each `{amount,count}`                        |
| `get_contracts_summary` | `p_search, p_state, p_tenant_id`                                          | `total, active, expiring_60d, ended, next_expiry, monthly_amount, annual_amount` |
| `get_tenants_summary`   | `p_search, p_category, p_lifecycle`                                       | `total, active, blocked_inactive, arrears{amount,tenants}`                       |
| `get_units_summary`     | `p_search, p_property_id, p_building_id, p_status, p_type, p_meter`       | `total, occupied, vacant, under_maintenance, rent_potential`                     |

All are `stable security definer set search_path = public, auth, pg_temp`, each
guarded by `has_permission(auth.uid(), '<module>.read')`, each ending with
`revoke all ... from public, anon` then `grant execute ... to authenticated, service_role`.

**Frontend:**

- `src/lib/json.ts` — `numberValue(Json|undefined): number`
- `src/lib/money.ts` — `formatKwd(value, locale)` → `"1,240.000 KWD"`
- `src/components/admin/SummaryCards.tsx` — grid + skeleton + **silent failure**
- `src/hooks/use{Payments,Expenses,Contracts,Tenants,Units}Summary.ts`
- Five `src/routes/admin.*.tsx` wired with `<SummaryCards>` + `<VibrantKpiCard>`
- `src/i18n/dictionary.ts` — `summary.*` keys in **both** locales
- `src/integrations/supabase/database.types.ts` — five `Functions` entries added by hand

**Tests:**

- `src/db/moduleSummaries.sqltest.ts` — 20 tests, needs Docker (`bun run test:sql`)
- `src/db/moduleSummaries.structure.test.ts` — Docker-free structural checks
- `src/lib/money.test.ts`, `src/lib/json.test.ts`

---

## 4. Gate status — what I actually ran

| Gate                                 | Result                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `bun run typecheck`                  | **PASS** (clean)                                                               |
| `bun run lint`                       | **PASS** — 0 errors, 17 warnings, all pre-existing shadcn `react-refresh` ones |
| `bun run test`                       | **PASS** — 689 tests / 95 files                                                |
| `bun run test:db`                    | **PASS** — container provisioned                                               |
| `bun run test:sql` (this file alone) | **PASS** — 20/20                                                               |
| `bun run test:sql` (full suite)      | **1 unrelated failure** — see §5                                               |

**Done by Grok after handover:**

- `moduleSummaries.sqltest.ts` re-run **3×** — 20/20 stable each time.
- Typecheck fix: `summaryWith` returned `Record<string, never>` (broke `tsc`);
  now `Record<string, any>` + `SummaryCards.test.tsx` for silent-failure proof.
- Structural checks: all five routes wire cards; payments uses `{}`; net excludes
  insurance; five `revoke … anon` grants present.
- Pushed to `origin/feat/admin-summary-cards`; PR **#71** open.

**Still remaining:**

- **Browser verification of all five pages** against a DB that has migration 79
  applied (local or staging). See §7 / §9.
- **Production apply only after PR merge** — see §10.

---

## 5. The one failing test is NOT this feature

```
FAIL src/db/workflowRegistry.sqltest.ts > recipient_targets >
     WORKFLOW_CATALOG keys match the seeded cron_jobs keys (no drift)
AssertionError: expected [ …(15) ] to deeply equal [ …(16) ]
```

Missing key is `manual-payment-invoice`. This belongs to **separate concurrent
work** (the manual-payment-for-invoice event workflow) that added the key to
`src/lib/workflowCatalog.ts` without its migration being applied to the test
database. Do not try to fix it here — it is not caused by, and does not affect,
the summary cards.

---

## 6. Two bugs I fixed — do not reintroduce them

**a) `moduleSummaries.structure.test.ts` sliced the migration at fixed character
offsets** (`migration.slice(start, start + 2500)`). The two longest functions had
their `grant` fall outside the window, so two tests failed while the SQL was
correct. Worse, a _short_ function could have had its grant deleted and still
passed by borrowing the next function's. Replaced with `sectionFor(name)`, which
extracts from one `create or replace function` to the next.

**b) `moduleSummaries.sqltest.ts` asserted exact deltas on global aggregates.**
The arrears test failed in the full suite and passed when run alone. Root cause:
Vitest runs test **files in parallel** against one Postgres, so a `before`/`after`
pair straddles two READ COMMITTED snapshots and a concurrent file moving the same
global number makes the delta wrong. `withRollback`'s own docstring in
`src/db/testDb.ts` already mandates the rule:

> _"assertions must be scoped to the fixtures the test itself created rather than
> to global counts."_

Every assertion is now scoped by `p_tenant_id`, `p_property_id`, or (for tenants,
which has no id arg) `p_search` on the fixture's unique code.

Also in that pass: dropped hardcoded `'PAY-A'` / `'EXP-A'` / `'INV-OD'` literals
— those columns are `unique` **and already default** from `next_*_code()`
sequence functions, so hardcoding was both unnecessary and a collision hazard.

---

## 7. Gotchas that will bite you

**`actAs` takes three arguments:** `actAs(client, "authenticated", userId)`. The
plan originally had it as two and was wrong. The test image reads
`request.jwt.claim.sub`, not the JSON claims object — set the wrong GUC and
`auth.role()` is not `authenticated`, the permission guard is skipped entirely,
and the test **passes vacuously while proving nothing**. See `src/db/rls.sqltest.ts`.

**Reversal cannot self-reference:** migration 05 has
`check (reversed_by_payment_id is null or reversed_by_payment_id <> id)`. A
reversal is a _second_ payment row that the original points at.

**`invoices.balance` is `generated always as (total - paid)`** — you cannot insert
it. Set `total` and `paid`. Periods are `period_year` / `period_month` integers,
not a date range. `idempotency_key` is required and unique.

**No CTE before `select ... into`.** All ~12 existing `into v_` sites in
`db/migrations/` use a plain select or `from (subquery) f`. Follow that form.

**`database.types.ts` is hand-maintained** despite looking generated. Never run
`bun run gen:types` over it — that writes a _reference_ file.

**i18n parity is enforced** by `src/i18n/dictionary.test.ts`, and it checks by
**truthiness** — an empty-string value fails exactly like a missing key. Only
double-quoted `t("literal")` calls are seen by its scanner.

**Migration number 79 was contested.** A `79_manual_payment_invoice_workflow.sql`
briefly existed in the working tree from concurrent work. It is gone now and
`79_module_summary_rpcs.sql` is the tracked one on this branch — but **re-check
before pushing**, because the other work may still claim 79 when it lands:

```bash
git fetch origin main && git ls-tree -r --name-only origin/main -- db/migrations | tail -3
```

If it collides, renumber to 80 consistently across the migration, the sqltest,
`moduleSummaries.structure.test.ts` (it reads the path literally at line ~12) and
the production-apply step.

---

## 8. Design decisions you should not silently reverse

**Payments cards are module-wide, not filter-following** — a deliberate deviation
from the "cards follow filters" rule agreed for the other four pages.
`partial_payments`, `insurance_payments` and `refunds` have **no `code` and no
`status` column**; they are plain ledgers. A search filter is not expressible
against three of the four tables, so a search-driven card row would contradict
three of the four tabs. The RPC still _accepts_ the args, so lifting the Payments
search box above the tabs later turns this on in one line.

**Insurance does not move `net`.** `net = full + partial − refunds`. Insurance is
a holding, not income — same rule as `BudgetSummary` in `src/hooks/useBudget.ts`.

**There is no `expiring` contract state.** `expiring_60d` is computed from
`end_date` over `state = 'active'`; `ended` means `state in ('expired','terminated')`.
Migration 76 states that nothing in this codebase ever transitions a contract to
`expired`.

**Cards fail silently.** A broken aggregate must never blank the table beneath
it. `SummaryCards` logs and renders nothing on error. Keep it that way.

**Cards may disagree with the `/admin` dashboard tiles.** `useDashboardKpis`
counts tenants and units _without_ an `archived_at` filter; the list hooks and
these RPCs exclude archived rows. The page card is the correct one. Fixing the
dashboard is a separate, out-of-scope change.

---

## 9. SHIPPED — production verification, 2026-08-03

PR [#71](https://github.com/lolotam/Dana-kuwait/pull/71) merged to `main` as a
merge commit `7d0dc26`; remote branch deleted. Dokploy rebuilt and redeployed.
Everything below was **verified against production**, not assumed.

**Database — migration 79 is applied.** All five functions exist:

```
get_contracts_summary  get_expenses_summary  get_payments_summary
get_tenants_summary    get_units_summary
```

**Grants are correct on all five** — `anon` denied, `authenticated` allowed:

| function                 | anon | authenticated |
| ------------------------ | ---- | ------------- |
| all five `get_*_summary` | `f`  | `t`           |

**PostgREST exposes them — the schema cache is fresh.** Ran
`notify pgrst, 'reload schema';` then called the RPC directly against the
`rest` container (bypassing Kong, so no JWT → runs as `anon`):

```
POST http://<rest>:3000/rpc/get_units_summary
→ HTTP 401 {"code":"42501","message":"permission denied for function get_units_summary"}
```

That is the **good** result. A stale cache returns 404 _"Could not find the
function"_; a `42501` means PostgREST found it and Postgres refused `anon`. One
call proves both the cache is fresh and the security posture holds.

**Live production values** (2026-08-03):

| RPC       | result                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| units     | `total 70, occupied 10, vacant 54, under_maintenance 6, rent_potential 32,880.000`                           |
| payments  | `full 21,770.000 / 39 · partial 0 · insurance 3,320.000 / 5 · refunds 0 · net 21,770.000`                    |
| expenses  | `total 420.000 / 2 · approved 420.000 / 2 · pending 0 · this_month 0`                                        |
| contracts | `total 11, active 10, expiring_60d 4, ended 0, next_expiry 2026-08-31, monthly 5,260.000, annual 63,120.000` |
| tenants   | `total 21, active 9, blocked_inactive 11, arrears 14,490.000 across 6 tenants`                               |

**Invariants cross-checked against live data — all hold:**

- Units partition exactly: `10 + 54 + 6 = 70`. ✅
- `net` excludes insurance: `21,770 + 0 − 0 = 21,770`, with 3,320 insurance held
  outside it. ✅
- `annual_amount = monthly_amount × 12`: `5,260 × 12 = 63,120`. ✅
- **Payments "full" == `get_budget_summary` `collections`** over an all-time
  range: `21,770.000 == 21,770.000`. ✅ This was the spec's headline consistency
  claim.
- **Expenses "approved" == budget `expenses`**: `420.000 == 420.000`. ✅

**Frontend is deployed.** App container redeployed from `main`. Every one of the
five route bundles served from https://danat-future.com contains its RPC call:

```
/assets/admin.units.index-BK1xUTV3.js   get_units_summary, rent_potential, under_maintenance
/assets/admin.payments-DVqcv-gg.js      get_payments_summary
/assets/admin.expenses-CLsHOxjN.js      get_expenses_summary
/assets/admin.contracts-v-Z743cW.js     get_contracts_summary
/assets/admin.tenants.index-DrsTW2ss.js get_tenants_summary
```

### The known dashboard discrepancy is now quantified

Section 8 warned the cards may disagree with `/admin` tiles. On live data:

|                                  | all rows | unarchived (what the cards count) |
| -------------------------------- | -------- | --------------------------------- |
| tenants                          | 22       | **21**                            |
| contracts                        | 12       | **11**                            |
| units with `status = 'archived'` | —        | 0                                 |

So the Tenants card reads **21** where the dashboard tile reads **22**. The card
is the correct one — `useDashboardKpis` (`admin.index.tsx:97`) omits the
`archived_at` filter that every list hook applies. Units are unaffected (nothing
is archived). Fixing the dashboard remains a separate, out-of-scope change.

### Still not done

- **No human has looked at the rendered cards in a browser.** Everything above
  proves the data layer is correct and the code is served; it does not prove the
  cards _look_ right. Spot-check the five pages, and toggle to Arabic to confirm
  labels translate and numerals stay LTR inside RTL.

---

## 10. Production runbook (kept for the next migration)

Dokploy **auto-deploys on push to `main`**, so schema must land on the live
database _before_ the frontend that calls it.

1. Transfer the migration via `ssh-danatfuture-mcp`. SSH exec caps at ~1000 chars
   — send as chunked base64, verify with `md5sum`.
2. Apply it:
   ```bash
   docker exec -i danatfuture-supabase-ozoxsa-db-1 \
     psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f /tmp/<migration>.sql
   ```
   **Do not replay the whole migration set** — several are not idempotent.
3. Reload the PostgREST cache — without this the functions exist but every RPC
   call 404s:
   ```sql
   notify pgrst, 'reload schema';
   ```
4. Verify exposure _and_ grants in one call, from the host:
   ```bash
   IP=$(docker inspect danatfuture-supabase-ozoxsa-rest-1 \
        --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
   curl -s -X POST "http://$IP:3000/rpc/<fn>" -H 'Content-Type: application/json' -d '{}'
   # 42501 permission denied → exposed + anon correctly blocked  (good)
   # 404 could not find      → schema cache still stale          (bad)
   ```
   Note the host cannot reach the app container's `dokploy-network` overlay
   directly; use the public domain for app checks and container IPs only for the
   Supabase stack.

---

## 11. Commands

```bash
bun run dev          # Vite dev server
bun run lint         # ESLint 9
bun run typecheck    # tsc --noEmit
bun run test         # Vitest — includes i18n parity
bun run test:db      # provision/refresh the test Postgres (needs Docker)
bun run test:sql     # SQL integration suite against that Postgres
```

Run a single SQL test file:

```bash
npx vitest run --config vitest.sql.config.ts src/db/moduleSummaries.sqltest.ts
```
