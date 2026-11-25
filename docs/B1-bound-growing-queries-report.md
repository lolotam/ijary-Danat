# B1 Implementation Report — Bound Growing Queries with Server-Side Pagination

**Project:** Danat Al Mustaqbal ERMP (دانة المستقبل العقارية)  
**Backlog item:** B1 — Bound growing queries with real server-side pagination  
**Date:** 2026-08-06  
**Branch:** `perf/bound-growing-queries`  
**Pull request:** [#74](https://github.com/lolotam/Dana-kuwait/pull/74)  
**Merge commit:** `64076c2` (merged into `main`)  
**Status:** Complete — the export cap recorded in §4.5 was closed on 2026-09-07 (paged export).

---

## 1. Objective

Prevent list pages from downloading unlimited records and heavy fields as data grows over time, while:

- Keeping all historical records accessible (no silent truncation)
- Applying filters, search, and sorting **server-side** before pagination
- Protecting financial correctness (totals, allocations, receipts)
- Preserving RLS and existing permissions

This was a **preventive correctness** change, not an emergency performance fix.

---

## 2. Delivery summary

| Item                         | Detail                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| Commits                      | `b48f937` — Gmail + inbox pagination<br>`da4804e` — operational lists, receipts, reports, financial docs |
| Files changed                | 22                                                                                                       |
| Lines                        | +1,072 / −358                                                                                            |
| Schema / migrations          | None                                                                                                     |
| RLS changes                  | None                                                                                                     |
| Force-push / history rewrite | None (Lovable-safe merge)                                                                                |

---

## 3. Investigation & classification

Every targeted hook was classified before changing behavior:

| Hook                     | Classification            | Action taken                            |
| ------------------------ | ------------------------- | --------------------------------------- |
| `useGmailMessages`       | Growing list              | Server pagination + slim list columns   |
| `useGmailMessage`        | Already bounded           | Kept detail-on-open (`select *` by id)  |
| `useTenantMessages`      | Growing list              | Server pagination                       |
| `useContactInquiries`    | Growing list              | Server pagination (inbox source)        |
| `useLeasingInquiries`    | Growing list              | Server pagination (inbox source)        |
| `useReceipts`            | Parent-scoped child       | Require parent id; drop `html_snapshot` |
| `usePaymentAllocations`  | Parent-scoped (financial) | **No pagination** — full set required   |
| `useContractPayments`    | Parent-scoped (financial) | **No pagination** — full set required   |
| `useUsersWithRoles`      | Growing list              | Server pagination + scope + search      |
| `useEmployees`           | Growing list              | Server pagination + search              |
| `useReportPreview`       | Preview / export          | Preview cap 100; separate full export   |
| Config / reference hooks | Small lists               | Deferred (no change)                    |

---

## 4. What changed (by area)

### 4.1 Shared pagination helpers

- **`src/hooks/pagination.ts`** — 1-based page math for PostgREST inclusive `.range(from, to)`, page count, and clamp after delete
- **`src/hooks/pagination.test.ts`** — first/second page, custom size, empty result, partial last page, clamp

### 4.2 Gmail & unified inbox (highest priority)

**List query**

- Explicit column list (`GMAIL_LIST_COLUMNS`)
- Excludes heavy fields: `raw_payload`, `body_text`
- Includes: id, addresses, subject, snippet, dates, read state, category, thread/message ids
- Server filters: category, optional `isRead`, search
- Deterministic order: `received_at` desc, `id` desc
- `.range()` + `count: "exact"`
- Query key includes page, pageSize, search, category, isRead

**Detail query**

- `useGmailMessage(id)` still loads full row (including `raw_payload`) only when a message is open
- Disabled when id is null

**UI**

- Admin inbox Gmail tab: `Pager`, category filter resets page to 1
- Tenant / visitor / lead tabs: same pagination pattern
- **InboxBell:** unread queries use status/`is_read` filters with exact counts (badge not undercounted by list pagination)

### 4.3 Users & employees

- **Users:** page, pageSize, search, scope (`managerial` | `tenant` | `all`)
- **Employees:** page, pageSize, search, includeInactive
- Settings/employees UIs: search box + existing `Pager` component
- Tab/filter changes reset to page 1

### 4.4 Financial hooks (correctness-first)

| Hook                    | Behavior                                                           | Why                                                           |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `usePaymentAllocations` | Still loads **all** allocations for one payment                    | Receipts and allocation UI need full breakdown                |
| `useContractPayments`   | Still loads **all** payments attributed to one contract            | Paid totals must not be page-sliced                           |
| `useReceipts`           | Enabled only with `paymentId` or `tenantId`; omits `html_snapshot` | Parent-scoped; print rebuilds HTML from payment + allocations |

**Rule applied:** never compute paid totals, balances, or receipt lines from a truncated page.

### 4.5 Report preview vs export

- Preview: hard cap **`REPORT_PREVIEW_LIMIT = 100`**
- UI shows partial message: `reports.previewPartial` (AR + EN)
- CSV export calls **`fetchReportExport`** — pages through every match in steps of `PGRST_MAX_ROWS` via `fetchAllPages` (`src/lib/pagedQuery.ts`), so the 1,000-row PostgREST clip no longer applies. Between PR #74 and 2026-09-07 export mode merely dropped `.range()`, and reports over 1,000 rows exported the first 1,000 silently; the overdue-aging report had the same clip in preview too. Fixed 2026-09-07 (PR #192).
- Print still uses on-screen preview rows (preview only)

### 4.6 i18n

- Added `reports.previewPartial` in Arabic and English
- Pager continues to use existing `common.previous` / `common.next`
- Dictionary parity tests remain green

---

## 5. Pagination design (project conventions)

| Concern            | Choice                                                                    |
| ------------------ | ------------------------------------------------------------------------- |
| Page index         | **1-based** (matches existing `Pager` in `Phase2Ui`)                      |
| Default page sizes | Inbox 20; users/employees 20; report table pages the capped preview by 20 |
| Count              | `count: "exact"` where a pager is shown                                   |
| Ordering           | Primary sort + **`id` tie-breaker** for stable pages                      |
| Filter order       | select → filters → search → order → range                                 |
| Query keys         | Include every input that changes the result                               |
| Cache invalidation | Mutations invalidate key **prefixes** (all pages), not page 1 only        |
| Loading UX         | `placeholderData: previous` to reduce flash                               |

---

## 6. Gmail payload improvement

|                       | Before                                    | After                             |
| --------------------- | ----------------------------------------- | --------------------------------- |
| Rows returned         | Entire mailbox                            | One page (default 20)             |
| List fields           | Non-payload columns including `body_text` | Slim list columns only            |
| `raw_payload` in list | Already excluded                          | Still excluded                    |
| `body_text` in list   | Included                                  | **Excluded** (snippet used in UI) |
| Full message          | On open via `useGmailMessage`             | Unchanged                         |

Live production payload sizes were not measured (no PII/email content logged). Structural effect: list responses no longer carry full MIME payloads or full body text.

---

## 7. Verification

| Gate                            | Result                                             |
| ------------------------------- | -------------------------------------------------- |
| Typecheck (`tsc --noEmit`)      | Passed                                             |
| Tests (`vitest run`)            | **740** passed                                     |
| Production build (`vite build`) | Passed                                             |
| ESLint (changed files)          | Passed                                             |
| Full-repo ESLint                | Pre-existing prettier issues in unrelated files    |
| Browser smoke                   | Not run in this delivery environment               |
| Graphify update                 | CLI unavailable; graph artifacts untracked on main |

---

## 8. Files touched

### Created

- `src/hooks/pagination.ts`
- `src/hooks/pagination.test.ts`
- `src/hooks/useGmailMessages.test.ts`
- `src/hooks/useReceipts.test.ts`
- `src/hooks/useReportPreview.test.ts`

### Modified

- `src/hooks/useGmailMessages.ts`
- `src/hooks/useTenantMessages.ts`
- `src/hooks/useLandingSettings.ts` (leasing inquiries)
- `src/hooks/useReceipts.ts`
- `src/hooks/usePaymentAllocations.ts` (+ test)
- `src/hooks/useContractPayments.ts`
- `src/hooks/useEmployees.ts`
- `src/hooks/useUsers.ts`
- `src/hooks/useReportPreview.ts`
- `src/components/admin/InboxBell.tsx`
- `src/components/admin/ReceiptPrint.tsx`
- `src/routes/admin.inbox.tsx`
- `src/routes/admin.employees.tsx`
- `src/routes/admin.settings.users.tsx`
- `src/routes/admin.reports.tsx`
- `src/i18n/dictionary.ts`

---

## 9. Deferred / intentional non-changes

- **Payment allocations & contract payments** — parent-scoped full collections required for money paths
- **Config lists** (permissions, option lists, providers) — small reference data
- **Tenants full list** — previously product-unpaginated by request
- **No DB indexes / migrations** — none proven necessary for current volume; report separately if slow queries appear
- **No multi-company RLS, PDF, dictionary split, or report engine rewrite**

---

## 10. Remaining risks & follow-ups

1. **Browser smoke** on staging/production after deploy (Gmail page/payload, open detail, users, employees, reports export, Arabic RTL).
2. **Overdue aging report** still joins/filters tenant names in memory for search; large overdue sets remain heavier than pure SQL range.
3. **User scope** still loads role-assignment id sets before paginating profiles (fine for staff-scale, not for tens of thousands of portal users).
4. **Inbox “select all”** selects the current page only (consistent with other admin tables).
5. Optional: measure Gmail list payload size in a safe staging mailbox after deploy.

---

## 11. Git / release trail

```
64076c2  Merge pull request #74 from lolotam/perf/bound-growing-queries
da4804e  perf: paginate growing operational lists
b48f937  perf: paginate Gmail and inbox message queries
```

- **PR:** https://github.com/lolotam/Dana-kuwait/pull/74
- **Base:** `main`
- **Merged:** 2026-08-06
- **Remote feature branch:** deleted after merge

Deploy follows the normal Dokploy path: push to `main` → rebuild app container (already merged; wait for/deploy pipeline as configured).

---

## 12. Acceptance criteria checklist

| Criterion                                          | Met                 |
| -------------------------------------------------- | ------------------- |
| Every targeted hook investigated and classified    | Yes                 |
| True growing lists server-side paginated           | Yes                 |
| No silent truncation of financial/operational data | Yes                 |
| Gmail list omits heavy full-message payload        | Yes                 |
| Gmail detail loads only when requested             | Yes                 |
| Filters/search before pagination                   | Yes                 |
| Deterministic ordering                             | Yes                 |
| Query keys include page, size, filters             | Yes                 |
| Mutation invalidation covers paginated caches      | Yes                 |
| Historical records remain accessible via paging    | Yes                 |
| Financial totals independent of visible page       | Yes                 |
| Report preview does not limit CSV export           | Yes                 |
| Arabic + English labels for new copy               | Yes                 |
| No RLS / permission changes                        | Yes                 |
| Lint (changed files) / typecheck / tests / build   | Yes                 |
| Browser smoke                                      | Pending environment |
| No unrelated refactor                              | Yes                 |

---

_End of report._
