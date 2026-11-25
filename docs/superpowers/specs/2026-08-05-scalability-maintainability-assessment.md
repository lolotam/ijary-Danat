# Scalability & Maintainability Assessment — Danat Al Mustaqbal ERMP

**Date:** 2026-08-05 · **Mode:** assessment only, nothing executed · **Branch:** `main`

## Context

Question asked: _how do we make the app scalable and maintainable — do we need to refactor?_

All four scaling axes were named (more data, multi-company SaaS, more features/devs,
infra throughput), with assessment-only appetite. This document answers each axis with
measurements taken from the repo and from production, then gives a prioritized
backlog to draw from later. **No code was changed.**

### Headline verdict

**No, this codebase does not need a refactor — and three of the four axes are
non-problems today.** The architecture is genuinely sound. What exists instead is
one hard blocker (multi-company is not implemented at the security layer, only
decorated) and a handful of bounded maintainability chores.

Spending weeks restructuring code that serves 94 invoices would be the wrong work.

---

## Evidence: the architecture is already good

Measured, not assumed:

| Signal           | Finding                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Size             | 67,322 source lines / 383 files; 9,536 test lines / 99 files                                                                                |
| Layering         | Clean `routes/` → `hooks/` → `fns/` → `lib/` separation; 65 domain hooks, 57 server fns, one concern each                                   |
| Pagination       | Real server-side paging — `.range(from, from+pageSize-1)` with `count: "exact"` in 24 hooks                                                 |
| Query shape      | Batched `.in()` lookups, **not** N+1. `useInvoices` fetches a page then 4 batch queries                                                     |
| Sort stability   | `useInvoices` adds `code` as a tiebreaker because bulk-generated invoices share `created_at` — a subtle bug someone already found and fixed |
| Indexes          | 113 `create index` statements across 78 migrations                                                                                          |
| DB logic         | 91 RPCs; money paths live in SQL, not the client                                                                                            |
| Money-path tests | 39 tests in `src/fns/`, 41 in `src/lib/`, 23 SQL integration tests in `src/db/`                                                             |
| Code splitting   | Working — `admin.reports`, `index`, `printDocument` are separate chunks                                                                     |

The money engine (`generateInvoices`, `applyAllocation`, `reversePayment`,
`createPayment`) is the best-tested part of the system. That is the correct place
to have concentrated the effort.

---

## Axis 1 — More data, same company: **not a problem**

Live row counts from production (`danatfuture-supabase-ozoxsa-db-1`):

```
audit_logs 680 · gmail_messages 103 · invoices 94 · invoice_items 94
units 70 · notifications 61 · payments 22 · payment_allocations 22
contracts 4 · profiles 1
```

**70 units. 94 invoices. 4 contracts.** With server-side pagination and 113 indexes
already in place, this design handles 100× that volume without a line changing.

Do **not** optimize for data scale. There is no evidence of a bottleneck and none
will appear for years at this trajectory.

The only data-shaped items worth queuing are in the backlog (B1, B2) — and they
matter for _correctness and page weight_, not throughput.

---

## Axis 2 — Multi-company SaaS: **hard blocker, and it is security, not refactoring**

This is the finding that matters. Verified three ways:

- `company_id` appears **121×** in migrations and exists on **32 tables**.
- Of **275 RLS policies**, exactly **2** reference `company_id` — and both are
  _tenant-portal_ policies that let a portal user read their own company's row
  (`companies_select_tenant`, `db/migrations/17_tenant_portal_units_rls.sql:22`).
  **No staff-facing policy scopes by company.**
- The two functions every staff policy delegates to are company-blind. These are the
  final definitions — only three migration files define either function
  (`01_schema_core.sql`, `03_phase1_permissions_audit.sql`, `16_custom_roles.sql`),
  and `supabase/migrations/` contains one unrelated file:

```sql
-- db/migrations/01_schema_core.sql:114  (only definition of is_staff)
create or replace function public.is_staff(_user_id uuid) ... as $$
  select exists (select 1 from public.user_roles
                 where user_id = _user_id
                   and role in ('admin','accountant','collector','readonly'))
$$;

-- db/migrations/16_custom_roles.sql:117  (last definition of has_permission; supersedes 03)
-- joins user_roles/custom_roles → permission_code. No company dimension.
```

And the core money policy is simply:

```sql
-- db/migrations/05_phase3_invoices_payments.sql:159
create policy invoices_select_allowed on public.invoices for select to authenticated
  using ( public.is_staff(auth.uid()) or ( ...tenant self-access... ) );
```

**Consequence:** if Company B were onboarded tomorrow, every staff user of Company A
would read Company B's invoices, tenants, payments and contracts — and vice versa.
RLS filters by _role_, never by _company_.

Reinforcing this, ~12 server functions resolve "the company" as _the oldest row in
the table_:

```ts
supabaseAdmin.from("companies").select("*").order("created_at").limit(1).maybeSingle();
// contractExpiryJob.ts:75, sendCompanyInfo.ts:108, enqueueNotification.ts:90,
// notifyContactInquiry.ts:39, notifyContractLifecycle.ts:48, gmailSyncJob.ts:218, …
```

`company_id` is a **written-but-never-read column** — the same defect shape this
codebase has produced before (`is_system`, `archived_at`). It looks like
multi-tenancy is implemented. It is not.

**This is not a refactor.** It is a security workstream: derive the caller's company,
add a company predicate to every policy on the 32 scoped tables, replace the
`limit(1)` company resolution with explicit scoping, and prove isolation with SQL
tests. Scope it separately and do it _before_ any second company exists — not after.

> Related open item: 57 `SECURITY DEFINER` functions are `anon`-executable,
> including money paths. That belongs to this same workstream.

---

## Axis 3 — More features / more devs: **the real, present pain**

### 3a. God route components

`src/routes/` is 23,108 lines across 47 files. The worst offenders mix data fetching,
business logic, dialogs and presentation in one function:

| File                              | Lines | `useState` | hook calls | inline dialogs |
| --------------------------------- | ----- | ---------- | ---------- | -------------- |
| `admin.settings.users.tsx`        | 1,272 | **28**     | 40         | 5              |
| `admin.settings.landing-page.tsx` | 1,884 | 22         | 42         | 3              |
| `admin.invoices.tsx`              | 1,071 | 17         | 35         | 5              |
| `routes/index.tsx`                | 2,039 | 14         | 33         | 3              |
| `admin.payments.tsx`              | 1,037 | 11         | 29         | 5              |

State density matters more than line count: `admin.settings.users.tsx` at **28
`useState` in one component** is harder to change safely than the 2,039-line landing
page. Every new feature in these files raises merge-conflict risk — acute here,
because this repo is edited concurrently and `main` auto-deploys.

### 3b. UI test coverage is near-zero where the risk now lives

| Layer         | Test files                  |
| ------------- | --------------------------- |
| `fns/`        | 39                          |
| `lib/`        | 41                          |
| `db/`         | 23                          |
| `components/` | 9 (mostly `ui/` primitives) |
| `hooks/`      | 5                           |
| **`routes/`** | **1**                       |

Coverage is inverted correctly for a money system — but it means every route change
is verified by hand.

### 3c. Friction multipliers

- `src/i18n/dictionary.ts` — 2,908 lines, single file. (Parity _is_ enforced by
  `dictionary.test.ts`, so a split must keep that test working.)
- `src/integrations/supabase/database.types.ts` — 1,607 lines, hand-maintained,
  ~70 importers, and `gen:types` clobbers it. Every schema change is a manual copy.
- **22 hooks use batch `.in()` lookups** (some are id joins, some are status filters);
  4 near-identical `enrich*()` join helpers exist — `useInvoices.ts:33`,
  `useElectricityCharges.ts:65`, `useElectricityMeters.ts:46`,
  `useMeterReadings.ts:59`. **Zero** PostgREST embedded selects are used anywhere,
  so every relation is assembled client-side by hand.

---

## Axis 4 — Infra throughput: **not a problem**

Measured on the production host on 2026-08-05:

```
load average: 0.42, 0.36, 0.43     ← 4 vCPU, so ~10% utilised
Mem: 15 GiB total · 4 used · 10 available
up 4 days
```

The app container plus the entire Supabase stack are idling. No capacity work is
justified by current evidence.

Two things to _watch_ rather than fix: cron entries overlapping if a run ever
exceeds its interval, and PDF generation (html2canvas) being CPU-bound and in-process.

---

## Prioritized backlog

Ordered by leverage. Nothing here is urgent except **P0**.

### P0 — Multi-company isolation (only if SaaS is actually on the roadmap)

Separate security project, scoped and specced on its own. Covers: company predicate
in 275 RLS policies, company-aware `is_staff`/`has_permission`, replacing the 12
`order(created_at).limit(1)` company lookups, revoking anon EXECUTE on the 57
`SECURITY DEFINER` functions, and SQL isolation tests in `src/db/*.sqltest.ts`.
**Blocks onboarding a second company. Do not ship company #2 before this.**

### B1 — Bound the growth-table queries _(small, safe)_

20 hooks have no `.range()`/`.limit()`. Most are config-sized and fine
(`useOptionLists`, `usePermissionsList`, `useProviderConfigs`, `usePortalTabs`).
These grow with usage and should be bounded:
`useGmailMessages` (`select("*")` on `gmail_messages`, whose `raw_payload` holds
entire messages — worst offender), `useTenantMessages`, `useReceipts`,
`usePaymentAllocations`, `useContractPayments`, `useUsers`, `useEmployees`,
`useReportPreview`.

### B2 — Split `printDocument.ts` and lazy-load the PDF renderer _(small, high value)_

`src/lib/printDocument.ts:11-12` statically imports `html2canvas` + `jspdf` → a
**591 KB chunk**, the largest in the build. Vite already emits it as its own chunk;
the problem is _which routes pull it in_. It has 8 static import sites — including
three that only want `safeFilename()`, a trivial string helper
(`invoiceDocument.ts`, `paymentDocument.ts`, `companyInfoDocument.ts`), which drags
the renderer into anything touching an invoice or payment document.
Move `safeFilename` to its own module and `await import()` the renderer, so the
chunk loads only when a PDF is actually rendered.
**The pattern already exists in the codebase** — `src/lib/downloadZip.ts:70` does
exactly this with `jszip`.

### B3 — Extract the three highest-state route files _(medium)_

`admin.settings.users.tsx` (28 `useState`) first, then `admin.invoices.tsx`, then
`admin.payments.tsx`. **Extraction only — move code, change no logic.** Pull each
inline dialog into `src/components/admin/`, following the existing precedent of
`PaymentSidePanels.tsx` and `TenantDocumentsManager.tsx`.

### B4 — Consolidate the client-side joins _(medium, needs a check first)_

Replace the 4 duplicated `enrich*()` helpers with PostgREST embedded selects.
**Prefer embeds over DB views:** a view needs a new numbered migration applied to
live Supabase over SSH _plus_ a hand-edit to `database.types.ts`. An embed needs
neither.
**Verify before committing to this:** embedded resources are also filtered by RLS on
the _joined_ table, so confirm tenant-portal isolation behaviour is unchanged. If it
isn't, drop this item.

### B5 — Split `dictionary.ts` by domain _(low urgency, mechanical)_

2,908 lines → per-module files re-exported from an index. Must keep
`dictionary.test.ts` parity enforcement passing.

---

## Rules of engagement (these constrain _how_, not _what_)

Non-negotiable given this project's setup:

1. **Push to `main` auto-deploys via Dokploy. There is no staging.** Every commit
   ships to production.
2. **Lovable-connected** — never force-push, rebase, amend or squash pushed commits.
3. **This repo is edited concurrently.** Re-check the branch before every commit.
4. Therefore: **each backlog item is its own small, independently revertible,
   same-day-merged commit.** No long-lived refactor branch touching 1,000+ line
   files — it will conflict badly and every merge goes straight to production.
5. Per the global CLAUDE.md, run `clean-code-guard` after production-code edits and
   `test-guard` after test edits.
6. If P0 proceeds: apply schema changes to live Supabase **first**, then push —
   Dokploy deploys before the migration otherwise.

---

## Verification for any item taken on

Baseline gates, from `CLAUDE.md`:

```bash
bun run lint && bun run typecheck && bun run test && bun run build
```

Per item:

- **B1** — confirm the bounded hooks still render; check payload size in DevTools
  Network for `gmail_messages`.
- **B2** — `bun run build`, confirm the 591 KB chunk no longer loads on routes that
  don't render a PDF; then smoke-test an actual invoice PDF download (the PDF is an
  html2canvas raster — verify by rasterizing, not by unit tests).
- **B3** — extraction only, so `typecheck` + `build` catch most breakage; then smoke
  each affected admin page in the browser, exercising every dialog.
- **B4** — `bun run test:sql` for RLS behaviour, plus a portal login confirming a
  tenant still sees only their own rows.
- **P0** — new `*.sqltest.ts` proving Company A cannot read Company B, run via
  `bun run test:sql`. Note the GUC shape gotcha: the test image reads
  `request.jwt.claim.sub`, not JSON claims.

---

## Recommendation

Do **not** refactor for scale. Current scale is 70 units and 10% CPU.

1. If multi-company SaaS is real → **P0 is the whole conversation.** Spec it
   separately; it is a security project and it blocks company #2.
2. If not → take **B1 and B2** as two small commits (a few hours, low risk), and
   treat **B3** as ongoing hygiene: whenever one of those route files is next
   touched, extract a dialog while in there.
3. Revisit this assessment when production crosses ~5,000 invoices or a second
   company is genuinely imminent.
