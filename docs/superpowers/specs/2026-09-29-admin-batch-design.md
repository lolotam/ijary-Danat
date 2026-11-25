# Admin batch 2026-09-29 — design

Eight independent admin/portal changes shipped as one PR (`feat/admin-batch-sep29`).
Every decision below marked **(user)** was chosen by the owner on 2026-09-29;
**(default)** marks an engineering default the owner can still overturn at review.

Next free migration number: **239** (latest on main is 238).

---

## Task 1 — Notification settings: renames + workflow ↔ template link

### Renames (label text only; tab values and routes unchanged)

| Where | Key | Today ar / en | New ar / en |
|---|---|---|---|
| Page header (`admin.settings.notifications.tsx:171`) | `notifications.logTitle` | سجل الإشعارات / Notification Log | إعدادات الإشعارات / Notification Settings |
| `pool` tab label (`:214`) and its `entityLabel` (`:260`) | `notifications.title` | مجمع الإشعارات / Notification Pool | سجل الإشعارات / Notification Log |

Both keys are used only on this page, so the values change in place. The tab
value stays `"pool"` (and `"jobs"`) — renaming values resets saved browser state
(comment at `admin.settings.notifications.tsx:348-352`).

### Workflow ↔ template link **(user: template column + edit chips)**

- New module `src/lib/workflowTemplates.ts` exporting
  `WORKFLOW_TEMPLATE_CODES: Record<WorkflowKey, readonly string[]>` next to
  `WORKFLOW_CATALOG`, plus `workflowsUsingTemplate(code)` for the reverse lookup.
  Content is the explorer's sender map, e.g. `payment-succeeded → ["receipt",
  "payment-admin-alert"]`, `contract-expiry → ["contract-expiry"]`,
  `overdue-reminders → ["overdue-reminder"]`, `backup → []`.
- **Anti-drift test** (`src/lib/workflowTemplates.structure.test.ts`): scans
  `src/fns/**/*.ts` (non-test) for template-code literals passed to
  `loadTemplateCopy(...)` / `template_code:` and fails if a code is used by a
  sender but absent from every workflow's list (allow-list for the three
  workflow-less codes: `invoice-document`, `company-info`, `due-reminder`), and
  fails if the map names a code no sender uses.
- **Workflows table** (`WorkflowTable.tsx`): new column "القالب / Template"
  after Workflow. One chip per code (`Badge` + pencil icon). Clicking opens the
  existing `TemplateEditorDialog` for that template row. A code with no DB row
  renders a muted chip "not found" (no dialog). Custom UI-added workflows show
  "—".
- **Templates table** (`NotificationTemplatesTable.tsx`): new column
  "مستخدم في / Used by" listing workflow names (locale-aware) from the reverse
  lookup; "—" when none.
- Opening the editor from the Workflows tab reuses the route's existing
  `TemplateEditorDialog` and `openTemplate`: the route passes a
  `templatesByCode` map and `onEditTemplate` down through `WorkflowsPanel`, so
  there is still exactly one editor instance. `WorkflowTable.tsx` is 444 lines — put the chip cell in its own
  component (`WorkflowTemplateChips.tsx`) so the table stays under the ceiling.
- Permissions: chips render for everyone who sees the Workflows tab; the edit
  action is enabled only when the viewer can edit templates (same check the
  templates tab uses today).

No migration.

---

## Task 2 — Dropdown-list value changes propagate everywhere

### Root cause (verified in prod 2026-09-29)

On 2026-09-26 the `unit_types` item's **value** was edited `Roof_Apartment` →
`managemental-services` (audit `option_list_item.update`). `units.type` stores
the value as free text with no FK and no cascade (migration 103), so 6 units
still hold `Roof_Apartment` and render the raw string; 4 were fixed by hand.
Labels already propagate; values do not.

### Design **(user: cascade on value change)**

- **RPC `rename_option_list_value(p_item_id uuid, p_new_value text)`** (migration
  239), `security definer`, `set search_path = public`, first statement checks
  `has_permission(auth.uid(), 'settings.lists')` (same permission as the RLS
  write policy in migration 230) and raises otherwise. In one transaction:
  1. locks the item row, rejects empty / duplicate-in-list values;
  2. updates every referencing column for that list — the cascade map is a
     `case` on `option_lists.code`:
     `unit_types → units.type`, `property_types → properties.type`,
     `unit_floors → units.floor`, `commercial_activities →
     contracts.commercial_activity`; the implementer greps for any other
     free-text list column (e.g. `kuwait_banks`) and adds it or documents that
     none exists;
  3. updates the item's value;
  4. writes one `write_audit` row with old value, new value and per-table
     counts; returns `jsonb` `{ updated: { units: n, … } }`.
- **Preview RPC `count_option_list_value_usage(p_item_id uuid)`** returns the
  same per-table counts so the UI can confirm before renaming.
- Grants: `revoke all … from public, anon; grant execute … to authenticated`
  (see memory: revoke-from-public misses anon).
- **Data fix** in migration 239: on a database that still has the
  `Roof_Apartment` item (fresh builds from seed 148) rename it to
  `managemental-services` / خدمات إدارية; then `update units set type =
  'managemental-services' where type = 'Roof_Apartment'`. Prod and fresh
  databases end in the same state.
- **UI** (`ListItemsPanel.tsx`): when the edited value differs from the stored
  one, call the preview RPC, show an `AlertDialog` (not native `confirm()` —
  memory: native confirm freezes automation) "Renaming updates N units …",
  then call the rename RPC, then update labels/sort/active via the existing
  update (value excluded; a DB trigger now rejects direct value updates).
  If the rename succeeded and the label update fails, the row stays open and a
  retry re-runs only the label update. Invalidate `option-lists` **and** the units/properties/contracts
  queries so tables refresh without reload. When the value is unchanged, the
  existing direct update runs as today.
- **Code-bound values**: `UNIT_FLOOR_TYPE_BINDING` (`unitFloorTypeBinding.ts`)
  hard-codes `roof: "Roof_Apartment"`. Update it to `managemental-services`
  and make the value field **read-only** (labels still editable, tooltip
  explains why) for any value present in `UNIT_FLOOR_TYPE_BINDING`, because a
  code-bound value can't follow a DB rename. `isRoofContract` and
  `contractBuilder/units.ts` already treat `floor === 'roof'` as roof, so
  roof detection keeps working; their `Roof_Apartment` literal is replaced by
  the binding constant.
- **Raw-value displays** → `useCatalogueLabel`: `admin.properties.$id.tsx:283`
  (unit type badge), `admin.properties.$id.tsx:178` (property type),
  `admin.units.$id.tsx:140` (unit type).
- `UnitFormDialog` already falls back to a raw option for an orphaned value;
  keep it.

Ships in migration **239**.

---

## Task 3 — المستأجر → المستثمر on invoices and receipts **(user: docs only, ar + en)**

| Surface | Change |
|---|---|
| Invoice print/PDF label `invoicePrint.tenant` | ar المستثمر, en Investor |
| Receipt print/PDF label `receipts.tenant` | ar المستثمر, en Investor |
| Invoice-document email built in code `emailTemplates/invoices.ts:100,109` | same |
| Live DB templates `invoice-document`, `invoice-disputed`, `invoice-written-off` | migration **240**: `replace(body_ar,'المستأجر','المستثمر')`, subjects too; English replaces only the label forms `Tenant:` and `>Tenant<` so prose is untouched. Idempotent; updates live rows (admins may have edited them), never re-seeds. |

Both i18n keys are used only by the document builders (grep verified). Update
both locales together (the i18n parity test enforces it). The admin
payment alert and the rest of the app keep "tenant". Also grep the
misspelling `المستاجر`.

---

## Task 4 — Tenant name is a real link

In `TenantsTable.tsx` replace the plain-text name (table cell `:451-453`, card
views `:179`, `:282`) with `<EntityLink kind="tenant" id=…>`, stopping
propagation of **click and keydown** so Enter on the link doesn't also fire the
row handler. Row / card click stays as is. Pattern: `admin.properties.index.tsx:415-439`.
Right-click → "Open in new tab" and middle-click then work natively.

---

## Task 5 — Occupancy badge in the contract-builder unit picker

- Add `status` to the select in `useUnitsForProperties` (`useUnits.ts:195-210`)
  and to `SelectableUnitRow`.
- `PlotUnitPicker.tsx:161-176`: after the PACI span, a small `Badge`:
  the app's existing `unitStatus.*` label and `unitStatusTone` colour
  (occupied مؤجر, vacant شاغر, available متاح …), so the builder reads the
  same as `/admin/units`. Source of truth is `units.status`, trigger-maintained from
  active contracts (migrations 76, 111). **(default)**
- Display-only: not in form values, not in `buildContractHtml`, not in the PDF.
  Selection is not blocked.

---

## Task 6 — Filled variables are bold in the contract PDF

- Clause functions (`clauses.ar.ts`, `clauses.en.ts`) wrap every interpolated
  value with `v(x)` → `\u0001x\u0002` (sentinel characters that cannot appear
  in form input — the schema strips control chars; add that if missing).
- `html.ts`: new `escWithBold(s)` = `esc(s)` then replace
  `\u0001(.*?)\u0002` with `<strong>$1</strong>`. Used by `renderClause`,
  `renderFrontMatter`; signature values wrapped in `<strong>` directly.
- `pageOneVariableLength` strips sentinels before measuring.
- Preview uses the same `buildContractHtml`, so it matches the PDF.
- **Gate:** `html.pdf.test.ts` ("stays five pages at the content limits") must
  actually run with `CHROMIUM_PATH` set — a skip is a failure for this task.
  If bold Arabic breaks five pages, tighten `PAGE_ONE_DENSE_AT`, don't drop the
  test.
- Update `html.test.ts:229` (occurrence count split by `<strong>`), keep the
  escape-once test at `:171` green.

---

## Task 7 — Portal KPI cards: flags, total-due card, auto width

- `cardRegistry.ts`: add `portal.insurance`, `portal.nextDue`,
  `portal.overdueInvoices`, `portal.totalOverdue` (page = portal), with ar/en
  labels next to the existing `settings.cards.portal.*` keys. The settings page
  renders them automatically. Default (no row) = visible.
- New card "إجمالي المستحق المتأخر / Total overdue": `usePortalInvoiceSummary`
  returns `overdueTotal` = sum of `balance` where `state = 'overdue'` **(default:
  same definition as the overdue-count card; excludes not-yet-overdue due and
  partially-paid invoices)**, summed with the money helpers, shown with
  `formatKwd`. The old comment at `usePortalData.ts:209-211` is replaced: this
  field now has a reader.
- `portal.index.tsx`: build `visibleCards` from the flags (fail closed while
  `!flags.isReady`, as today). Grid class from a static map
  `{1: "md:grid-cols-1", 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4:
  "md:grid-cols-2 xl:grid-cols-4"}` (full literal strings for Tailwind); hide
  the section at 0. Skeleton shows while flags load, sized to all four so the
  layout doesn't jump more than once.
- Works for tenant login and admin `?tenant=` preview (same hooks; RLS already
  lets authenticated users read `card_visibility`).

No migration.

---

## Task 8 — Weekly "overdue by contract" report **(user: separate weekly email)**

### Schema (migration 241)

- `report_schedules.report_kind text not null default 'summary'
  check (report_kind in ('summary','overdue_contracts'))`.
- `build_overdue_contracts_report_html(p_schedule_id uuid, p_as_of date)`
  returns the same row shape as `build_scheduled_report_html`
  (`period_start, period_end, html`), `security definer`, execute granted only
  to `service_role` and `authenticated` staff with the reports permission the
  existing builder uses (mirror its grants exactly).
- Rows: one per **contract** with overdue invoices
  (`state = 'overdue' and balance > 0`, contract `archived_at is null`)
  **(default: same flag the nightly job sets after grace days)**:

  | Column | Source |
  |---|---|
  | الاسم التجاري | `tenant_display_name(t, true)` (Arabic trade name, falls back to person) |
  | رقم العقد | `contracts.code` as stored (free text — no `COM-` parsing) |
  | عدد الأشهر المتأخرة | `count(distinct (period_year, period_month))` |
  | من | earliest period, Arabic month name + year (e.g. يناير 2026) |
  | إلى | latest period |
  | إجمالي المتأخر | `sum(balance)`, KWD 3 decimals |

  Sorted by total desc; footer row with grand total and contract count; empty
  state "لا توجد عقود متأخرة". Same HTML shell/branding as the weekly report so
  `renderAndStorePdf` produces a matching PDF. Locale follows
  `report_schedules.locale` (ar default; en headers when `en`).
- Seed (idempotent, `on conflict (code) do nothing`): code
  `WEEKLY-OVERDUE-REPORT`, weekly, `report_kind = 'overdue_contracts'`,
  names تقرير المتأخرات الأسبوعي / Weekly Overdue Report, **recipients,
  locale and `next_run_at` copied from the `7-DAYS-REPORT` row when it
  exists** so it arrives with the weekly report to the same admins. Always
  inserted **inactive** and activated only after the new runner is deployed
  (otherwise the old runner would build a summary under this name).
- Before re-issuing anything in `build_scheduled_report_html`: this design
  does **not** modify it. (Prod md5 `9c652b4f…`; memory: a hand-applied hotfix
  was once clobbered by a migration.)

### Code

- `runReportScheduleRecord`: pick the RPC by `schedule.report_kind`
  (`summary → build_scheduled_report_html`, `overdue_contracts →
  build_overdue_contracts_report_html`). Everything after (generated_reports,
  PDF, notification, `nextRun`) is shared.
- `ScheduleDialog.tsx`: "نوع التقرير / Report type" select (Summary / Overdue
  by contract); `database.types.ts` hand-updated (`report_kind`, new RPC) —
  never overwritten by `gen:types`.
- i18n keys under `reports.*` in both locales.

---

## Migrations summary (Migrations lane)

| # | File | Tasks |
|---|---|---|
| 239 | `239_option_list_value_rename.sql` | 2 — RPCs, grants, Roof_Apartment data fix |
| 240 | `240_investor_wording_templates.sql` | 3 — template text replace |
| 241 | `241_overdue_contracts_report.sql` | 8 — column, builder fn, seed |

All three verified with `bun run test:sql` on a clean DB, then applied to prod
(pg_dump first, md5 check, `notify pgrst`) **before** the merge.

## Testing

- Vitest per task next to the code (anti-drift test for task 1; RPC-call and
  invalidation behaviour for task 2; label values for task 3; link + no double
  navigation for task 4; badge rendering for task 5; bold markup, escaping and
  five-page PDF for task 6; flag-driven card count, grid class and total for
  task 7; RPC selection by kind for task 8).
- SQL tests (`test:sql`): rename RPC cascades + permission denial + duplicate
  rejection; template replace idempotence; overdue report grouping (two
  contracts of one tenant → two rows, month count, from/to, total, archived
  excluded).
- Gates: `bun run lint`, `typecheck`, `test`, `test:sql`.

## Out of scope

Renaming "tenant" outside invoice/receipt documents; choosing a different
template per workflow; changing the existing weekly summary report.
