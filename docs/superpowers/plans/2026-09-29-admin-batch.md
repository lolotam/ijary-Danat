# Admin batch 2026-09-29 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship eight admin/portal changes (notification-settings renames + workflow↔template chips, cascading list-value renames, Investor wording on invoices/receipts, tenant name links, unit occupancy badge, bold contract variables, portal KPI card flags + total-due card, weekly overdue-by-contract report) as one PR.

**Architecture:** Three new migrations (239 list-value rename RPCs + data fix, 240 template wording, 241 overdue report) routed to the Migrations lane; everything else is TypeScript/React in disjoint slices. Existing patterns are reused: `EntityLink`, `card_visibility` + `cardRegistry`, `useCatalogueLabel`, `runReportScheduleRecord`, `TemplateEditorDialog`.

**Tech Stack:** TanStack Start (React 19), Supabase (Postgres 17, PostgREST), Tailwind 4 + shadcn/ui, Vitest (`bun run test`), SQL integration tests (`bun run test:sql`, files `src/db/*.sqltest.ts`, helpers in `src/db/testDb.ts`).

**Spec:** `docs/superpowers/specs/2026-09-29-admin-batch-design.md`

## Global Constraints

- Every new or edited function gets a doc comment **above it that leads with Arabic**; English may follow only for the *why*. Comments never restate the next line.
- No file may exceed **500–600 lines**; split by responsibility if an edit pushes one past it.
- i18n: every new key is added to **both** `src/i18n/locales/ar/*` and `src/i18n/locales/en/*` (parity is enforced by `dictionary.test.ts`).
- `src/integrations/supabase/database.types.ts` is **hand-maintained** — edit entries by hand; never overwrite it with `gen:types` output.
- Migrations: `db/migrations/NNN_name.sql`, next numbers **239, 240, 241**; idempotent; `security definer` functions set `search_path = public`; `revoke all … from public, anon` then `grant execute … to authenticated, service_role`.
- Never use native `confirm()`/`alert()` in new UI; use `AlertDialog`.
- Tab values `"pool"` and `"jobs"` on `/admin/settings/notifications` must not change.
- `contracts.code` is free text — never parse a `COM-`/`CON-` prefix.
- Archived contracts (`archived_at is not null`) are excluded from the overdue report.
- Implementers do **not** commit; the orchestrator commits after review.
- Gates: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run test:sql`.

## Slice map (parallel only where files are disjoint)

| Slice | Lane | Tasks | Files (exclusive unless noted) |
|---|---|---|---|
| M | Migrations lane (OpenCode Muse Spark 1.3 free) | 1, 2, 3 | `db/migrations/239_*.sql`, `240_*.sql`, `241_*.sql` |
| 0 | Orchestrator | 4 | `src/integrations/supabase/database.types.ts` |
| A | Cursor `grok-4.7-medium` | 5, 6 | notifications route + `components/admin/Workflow*`, `NotificationTemplatesTable`, `src/lib/workflowTemplates.ts`, `runReportSchedule.ts`, `ScheduleDialog.tsx`; locale keys in `admin.ts` (`notifications.*`) and `notificationChannel.ts` (`workflows.*`, `reports.*`) |
| B | OpenCode `zai-coding-plan/glm-5.3-flash` | 7, 8 | `ListItemsPanel.tsx`, `useOptionLists.ts`, `unitFloorTypeBinding.ts`, `isRoofContract.ts`, `admin.properties.$id.tsx`, `admin.units.$id.tsx`, `TenantsTable.tsx`, `EntityLink.tsx`; locale keys in `admin.ts` (`lists.*`) |
| C | Cursor `grok-4.7-medium` | 9, 10, 13 (13 dispatched after 9/10 is reviewed) | `src/hooks/useUnits.ts` (one select), `src/lib/contractBuilder/*`, `PlotUnitPicker.tsx` |
| D | OpenCode `zai-coding-plan/glm-5.3-flash` | 11, 12 | `invoicePrintHtml`/`paymentReceiptHtml` keys, `emailTemplates/invoices.ts`, `portal.index.tsx`, `usePortalData.ts`, `cardRegistry.ts`; locale keys in `invoices.ts`, `notificationChannel.ts` (`invoicePrint.tenant` only), `contractBuilder.ts` (`settings.cards.portal.*`, `portal.dashboard.totalOverdue`) |

**Shared files (debate R1 #12):** `locales/{ar,en}/admin.ts` — A (`notifications.*`) and B (`lists.*`); `locales/{ar,en}/notificationChannel.ts` — A (`workflows.*`, `reports.*`) and D (`invoicePrint.tenant`). Integration owner for both: the orchestrator, applying A, then B and D. No other file is touched by two slices; `locales/*/invoices.ts` is D only.

`contractBuilder/units.ts` is edited by **C only** (Task 9 also swaps its `Roof_Apartment` literal — see Task 9 Step 4). Shared locale files are edited on different keys; the orchestrator resolves any hunk collision on the integration branch. Order: M + 0 first (types and schema are the interface), then A–D in parallel, then the Tests lane.

---

### Task 1: Migration 239 — list-value rename RPCs + Roof_Apartment data fix

**Files:**
- Create: `db/migrations/239_option_list_value_rename.sql`
- Test (Tests lane): `src/db/optionListValueRename.sqltest.ts`

**Interfaces:**
- Produces: `public.option_list_value_references(p_list_code text) returns table(table_name text, column_name text)`; `public.count_option_list_value_usage(p_item_id uuid) returns jsonb` → `{"units.type": 6}`; `public.rename_option_list_value(p_item_id uuid, p_new_value text) returns jsonb` → `{"updated": {"units.type": 6}}`.

- [ ] **Step 1: Write the migration**

```sql
-- 239_option_list_value_rename.sql
--
-- On 2026-09-26 an admin edited the unit_types item value Roof_Apartment →
-- managemental-services. units.type stores the value as free text (103) with
-- no FK, so 6 units kept the old string. This migration adds an atomic rename
-- that cascades to every column that stores a list value, and repairs the data.

-- يعيد الأعمدة التي تخزن قيم قائمة منسدلة معينة.
-- One home for the list→column map so the count and the rename cannot disagree.
create or replace function public.option_list_value_references(p_list_code text)
returns table(table_name text, column_name text)
language sql immutable
set search_path = public
as $fn$
  select v.table_name, v.column_name
  from (values
    ('unit_types',            'units',      'type'),
    ('property_types',        'properties', 'type'),
    ('unit_floors',           'units',      'floor'),
    ('commercial_activities', 'contracts',  'commercial_activity'),
    ('gmail_categories',      'gmail_messages', 'category'),
    ('kuwait_banks',          'deposits',   'bank_name')
  ) as v(list_code, table_name, column_name)
  where v.list_code = p_list_code;
$fn$;

-- يعد السجلات التي تستخدم قيمة عنصر القائمة، لعرضها قبل إعادة التسمية.
create or replace function public.count_option_list_value_usage(p_item_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_item public.option_list_items%rowtype;
  v_code text;
  v_ref record;
  v_n integer;
  v_counts jsonb := '{}'::jsonb;
begin
  if not public.has_permission(auth.uid(), 'settings.lists') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  select * into v_item from public.option_list_items where id = p_item_id;
  if not found then raise exception 'Option list item not found' using errcode = 'P0002'; end if;
  select code into v_code from public.option_lists where id = v_item.list_id;
  for v_ref in select * from public.option_list_value_references(v_code) loop
    execute format('select count(*) from public.%I where %I = $1', v_ref.table_name, v_ref.column_name)
      into v_n using v_item.value;
    v_counts := v_counts || jsonb_build_object(v_ref.table_name || '.' || v_ref.column_name, v_n);
  end loop;
  return v_counts;
end;
$fn$;

-- يعيد تسمية قيمة عنصر القائمة ويحدّث كل السجلات التي تخزنها في معاملة واحدة.
-- Enum-backed lists are rejected: their values are Postgres enum members.
create or replace function public.rename_option_list_value(p_item_id uuid, p_new_value text)
returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_item public.option_list_items%rowtype;
  v_code text;
  v_new text := btrim(coalesce(p_new_value, ''));
  v_ref record;
  v_n integer;
  v_counts jsonb := '{}'::jsonb;
begin
  if not public.has_permission(auth.uid(), 'settings.lists') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_new = '' then raise exception 'Value is required' using errcode = '22023'; end if;
  select * into v_item from public.option_list_items where id = p_item_id for update;
  if not found then raise exception 'Option list item not found' using errcode = 'P0002'; end if;
  select code into v_code from public.option_lists where id = v_item.list_id;
  if v_code in ('unit_statuses','contract_types','contract_states','payment_methods',
                'contract_statuses','email_categories','tenant_categories',
                'manual_payment_reasons') then
    raise exception 'Values of this list cannot be renamed' using errcode = '22023';
  end if;
  if v_item.value = v_new then return jsonb_build_object('updated', v_counts); end if;
  if exists (select 1 from public.option_list_items
             where list_id = v_item.list_id and value = v_new) then
    raise exception 'Value already exists in this list' using errcode = '23505';
  end if;
  for v_ref in select * from public.option_list_value_references(v_code) loop
    execute format('update public.%I set %I = $1 where %I = $2',
                   v_ref.table_name, v_ref.column_name, v_ref.column_name)
      using v_new, v_item.value;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object(v_ref.table_name || '.' || v_ref.column_name, v_n);
  end loop;
  perform set_config('app.option_value_rename', 'on', true);
  update public.option_list_items set value = v_new, updated_at = now() where id = p_item_id;
  perform public.write_audit(
    'option_list_item.rename_value', 'option_list_item', p_item_id,
    jsonb_build_object('value', v_item.value, 'list', v_code),
    jsonb_build_object('value', v_new, 'list', v_code, 'updated', v_counts));
  return jsonb_build_object('updated', v_counts);
end;
$fn$;

-- يمنع تغيير قيمة عنصر قائمة مباشرة دون المرور بدالة إعادة التسمية.
-- Old browser bundles (and useUpdateOptionListItem) can still PATCH `value`
-- through the RLS write policy; that write would skip the cascade and recreate
-- the 2026-09-26 orphaning. Only rename_option_list_value sets the GUC.
create or replace function public.option_list_items_guard_value()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.value is distinct from old.value
     and coalesce(current_setting('app.option_value_rename', true), '') <> 'on' then
    raise exception 'Change a list value through rename_option_list_value'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists option_list_items_guard_value on public.option_list_items;
create trigger option_list_items_guard_value
  before update of value on public.option_list_items
  for each row execute function public.option_list_items_guard_value();

revoke all on function public.option_list_value_references(text) from public, anon;
revoke all on function public.count_option_list_value_usage(uuid) from public, anon;
revoke all on function public.rename_option_list_value(uuid, text) from public, anon;
grant execute on function public.option_list_value_references(text) to authenticated, service_role;
grant execute on function public.count_option_list_value_usage(uuid) to authenticated, service_role;
grant execute on function public.rename_option_list_value(uuid, text) to authenticated, service_role;

-- Data repair. Prod already renamed the item; a fresh database (seed 148) still
-- has Roof_Apartment, so rename it there too — both end in the same state.
-- One DO block = one statement = one transaction, so the transaction-local
-- GUC is still set when the guarded update runs. The migration runner and the
-- prod psql apply both run in autocommit (debate R2 #1).
do $repair$
begin
  perform set_config('app.option_value_rename', 'on', true);

  update public.option_list_items i
     set value = 'managemental-services', label_ar = 'خدمات إدارية',
         label_en = 'Managemental Services', updated_at = now()
    from public.option_lists l
   where l.id = i.list_id and l.code = 'unit_types' and i.value = 'Roof_Apartment'
     and not exists (select 1 from public.option_list_items x
                     where x.list_id = i.list_id and x.value = 'managemental-services');

  update public.units set type = 'managemental-services'
   where type = 'Roof_Apartment'
     and exists (select 1 from public.option_list_items i
                 join public.option_lists l on l.id = i.list_id
                 where l.code = 'unit_types' and i.value = 'managemental-services');
end
$repair$;
```

Verify by building a fresh database with `bun run test:db` (the real runner) — a green build is the proof the guard did not block the repair.

The implementer must make the rejected-code list equal to the keys of `ENUM_BACKED_OPTION_LISTS` + the badge lists in `ListItemsPanel.tsx:269-271` + `tenant_categories` (it backs the `tenants.category` enum, migration 04:118, though the TS module omits it) + `manual_payment_reasons` (`invoices.manual_payment_reason`, migration 108, also stores payment-method values, so a string cascade could rewrite the wrong rows — renames are refused instead). Verify that `DepositFormDialog.tsx` stores the `kuwait_banks` item **value** (not its label) in `deposits.bank_name`; if it stores the label, drop that row from the map and say so in a SQL comment.

Known limitation (debate R1 #3, documented, not fixed): a unit form opened before a rename and saved after it writes the old value back. Owner scale is one or two admins; the form's orphan fallback shows the raw value and a second rename repairs it. Not worth an FK redesign in this batch.

- [ ] **Step 2: Tests lane writes `src/db/optionListValueRename.sqltest.ts`** covering: (a) admin renames a `unit_types` value used by two units → both units and the item carry the new value, return value counts `{"units.type": 2}`, one `audit_logs` row `option_list_item.rename_value`; (b) a user without `settings.lists` gets SQLSTATE `42501` and nothing changes; (c) renaming to a value already in the list → `23505`; (d) enum-backed lists (`unit_statuses`, `tenant_categories`) → `22023`; (d2) a direct `update option_list_items set value = ...` as an admin → `42501`, while a direct update of `label_ar`/`sort_order`/`is_active` still succeeds; (e) `count_option_list_value_usage` returns the same counts without changing anything; (f) after all migrations, no `units.type = 'Roof_Apartment'` remains and the literal `managemental-services` exists as an active `unit_types` item (DB state only — the binding constant is checked by Task 7's test after Slice B); (g) `manual_payment_reasons` → `22023`. Use `withRollback`, `actAs`, `actAsSuperuser` from `@/db/testDb`.

- [ ] **Step 3: Run** `bun run test:sql -- optionListValueRename` → PASS.

### Task 2: Migration 240 — Investor wording in live invoice templates

**Files:**
- Create: `db/migrations/240_investor_wording_templates.sql`
- Test (Tests lane): `src/db/investorWordingTemplates.sqltest.ts`

- [ ] **Step 1: Orchestrator pre-check (read-only, prod):** dump every line containing `المستأجر` or `Tenant` in `subject_ar, body_ar, subject_en, body_en` for the three codes below, and confirm each hit is a party label on the document (not, e.g., a URL or variable name like `{{tenant_name}}`). `replace()` on `المستأجر` cannot touch `{{tenant_name}}`; the English replace is restricted to label forms for that reason.

- [ ] **Step 2: Write the migration**

```sql
-- 240_investor_wording_templates.sql
--
-- The owner renamed the counter-party on invoices and receipts from المستأجر
-- (Tenant) to المستثمر (Investor). Code-built copy changes in the same PR; this
-- updates the admin-editable DB rows in place (never re-seeds — they may have
-- been edited since migrations 70/93). Idempotent: a second run matches nothing.
update public.notification_templates
   set subject_ar = replace(subject_ar, 'المستأجر', 'المستثمر'),
       body_ar    = replace(body_ar,    'المستأجر', 'المستثمر'),
       subject_en = replace(replace(subject_en, 'Tenant:', 'Investor:'), '>Tenant<', '>Investor<'),
       body_en    = replace(replace(body_en,    'Tenant:', 'Investor:'), '>Tenant<', '>Investor<'),
       updated_at = now()
 where code in ('invoice-document', 'invoice-disputed', 'invoice-written-off')
   and (   (coalesce(subject_ar,'') || coalesce(body_ar,'')) like '%المستأجر%'
        or (coalesce(subject_en,'') || coalesce(body_en,'')) ~ '(Tenant:|>Tenant<)');
```

- [ ] **Step 3: Tests lane** — after migrations: the three rows contain no `المستأجر`, no `Tenant:`/`>Tenant<`, do contain `المستثمر`; `{{tenant_name}}`-style placeholders are unchanged (compare placeholder sets before/after within a rollback by re-running the `update` on a row seeded with `المستأجر {{tenant_name}}`); running the migration file a second time changes 0 rows.

### Task 3: Migration 241 — overdue-by-contract weekly report

**Files:**
- Create: `db/migrations/241_overdue_contracts_report.sql`
- Test (Tests lane): `src/db/overdueContractsReport.sqltest.ts`

**Interfaces:**
- Produces: column `report_schedules.report_kind text not null default 'summary'` (`'summary' | 'overdue_contracts'`); `public.build_overdue_contracts_report_html(p_schedule_id uuid, p_as_of date default null) returns table(html text, period_start date, period_end date)`; `public.report_month_label(p_year int, p_month int, p_is_ar boolean) returns text`; schedule row `code = 'WEEKLY-OVERDUE-REPORT'`.

- [ ] **Step 1: Write the migration**

```sql
-- 241_overdue_contracts_report.sql
--
-- Weekly "overdue by contract" report: one row per contract with overdue
-- invoices. A second report kind on report_schedules rather than a section in
-- the summary report, so it can be switched off on its own. The summary builder
-- (build_scheduled_report_html, live body from 143) is NOT touched.

alter table public.report_schedules
  add column if not exists report_kind text not null default 'summary';
alter table public.report_schedules
  drop constraint if exists report_schedules_report_kind_check;
alter table public.report_schedules
  add constraint report_schedules_report_kind_check
  check (report_kind in ('summary', 'overdue_contracts'));

-- يعيد اسم الشهر والسنة بلغة التقرير، مثل «يناير 2026».
create or replace function public.report_month_label(p_year int, p_month int, p_is_ar boolean)
returns text language sql immutable
set search_path = public
as $fn$
  select (case when p_is_ar
    then (array['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'])[p_month]
    else (array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])[p_month]
  end) || ' ' || p_year;
$fn$;

-- يبني تقرير المتأخرات الأسبوعي: صف لكل عقد عليه فواتير متأخرة.
-- Overdue = state 'overdue' (set by evaluate_overdue after grace days) with a
-- positive balance; archived contracts are excluded (migration 82 rule).
create or replace function public.build_overdue_contracts_report_html(
  p_schedule_id uuid, p_as_of date default null)
returns table(html text, period_start date, period_end date)
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_schedule public.report_schedules%rowtype;
  v_company public.companies%rowtype;
  v_end date := coalesce(p_as_of, current_date);
  v_is_ar boolean;
  v_dir text;
  v_rows text := '';
  v_count integer := 0;
  v_total numeric(14,3) := 0;
  v_title text;
  v_company_name text;
  r record;
  c_on text := '#0b1c30'; c_muted text := '#434655'; c_outline text := '#c3c6d7';
  c_primary text := '#004ac6'; c_red text := '#EF4444'; c_bg text := '#f8f9ff';
begin
  if auth.role() = 'authenticated' and not public.has_permission(auth.uid(), 'reports.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  select * into v_schedule from public.report_schedules where id = p_schedule_id;
  if not found then raise exception 'Report schedule not found'; end if;
  v_is_ar := v_schedule.locale = 'ar';
  v_dir := case when v_is_ar then 'rtl' else 'ltr' end;
  select * into v_company from public.companies order by created_at limit 1;
  v_company_name := coalesce(case when v_is_ar then v_company.name_ar else v_company.name_en end,
                             v_company.name_ar, '');
  v_title := coalesce(case when v_is_ar then v_schedule.name_ar else v_schedule.name_en end,
                      v_schedule.name_ar);

  for r in
    with per_contract as (
      select i.contract_id,
             count(distinct (i.period_year, i.period_month)) as months,
             min(i.period_year * 100 + i.period_month) as first_ym,
             max(i.period_year * 100 + i.period_month) as last_ym,
             sum(i.balance) as total
        from public.invoices i
        join public.contracts c on c.id = i.contract_id
       where i.state = 'overdue' and i.balance > 0 and c.archived_at is null
       group by i.contract_id
    )
    select c.code,
           public.tenant_display_name(t, true) as party,
           pc.months, pc.first_ym, pc.last_ym, pc.total
      from per_contract pc
      join public.contracts c on c.id = pc.contract_id
      join public.tenants t on t.id = c.tenant_id
     order by pc.total desc, c.code
  loop
    v_count := v_count + 1;
    v_total := v_total + r.total;
    v_rows := v_rows || '<tr>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';" dir="rtl">'
      || replace(replace(replace(coalesce(r.party, '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';font-family:monospace;" dir="ltr">'
      || replace(replace(replace(coalesce(r.code, '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';text-align:center;">' || r.months || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';">'
      || public.report_month_label(r.first_ym / 100, r.first_ym % 100, v_is_ar) || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';">'
      || public.report_month_label(r.last_ym / 100, r.last_ym % 100, v_is_ar) || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';color:' || c_red || ';font-weight:700;" dir="ltr">'
      || to_char(r.total, 'FM999,999,990.000') || ' KWD</td>'
      || '</tr>';
  end loop;

  html := '<!doctype html><html lang="' || v_schedule.locale || '" dir="' || v_dir || '"><head><meta charset="utf-8">'
    || '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    || '<body style="margin:0;padding:16px;background:' || c_bg || ';font-family:Cairo,Segoe UI,Arial,sans-serif;color:' || c_on || ';">'
    || '<div style="max-width:900px;margin:0 auto;background:#fff;border:1px solid ' || c_outline || ';border-radius:16px;padding:20px;">'
    || '<div style="font-size:20px;font-weight:700;color:' || c_primary || ';">'
    || replace(replace(replace(v_company_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</div>'
    || '<div style="font-size:16px;font-weight:600;color:' || c_muted || ';margin:6px 0 16px;">'
    || replace(replace(replace(v_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || ' · ' || v_end || '</div>'
    || case when v_count = 0
         then '<p style="color:' || c_muted || ';">'
              || case when v_is_ar then 'لا توجد عقود متأخرة' else 'No overdue contracts' end || '</p>'
         else '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">'
           || '<thead><tr style="background:#eff4ff;text-align:start;">'
           || case when v_is_ar
                then '<th style="padding:8px;">الاسم التجاري</th><th style="padding:8px;">رقم العقد</th><th style="padding:8px;">عدد الأشهر المتأخرة</th><th style="padding:8px;">من</th><th style="padding:8px;">إلى</th><th style="padding:8px;">إجمالي المتأخر</th>'
                else '<th style="padding:8px;">Commercial name</th><th style="padding:8px;">Contract</th><th style="padding:8px;">Overdue months</th><th style="padding:8px;">From</th><th style="padding:8px;">To</th><th style="padding:8px;">Total overdue</th>'
              end
           || '</tr></thead><tbody>' || v_rows || '</tbody>'
           || '<tfoot><tr style="font-weight:700;background:#fff5f5;">'
           || '<td style="padding:8px;" colspan="5">'
           || case when v_is_ar then 'الإجمالي (' || v_count || ' عقد)' else 'Total (' || v_count || ' contracts)' end
           || '</td><td style="padding:8px;color:' || c_red || ';" dir="ltr">' || to_char(v_total, 'FM999,999,990.000') || ' KWD</td>'
           || '</tr></tfoot></table>'
       end
    || '</div></body></html>';
  period_start := v_end - 6;
  period_end := v_end;
  return next;
end;
$fn$;

revoke all on function public.report_month_label(int, int, boolean) from public, anon;
revoke all on function public.build_overdue_contracts_report_html(uuid, date) from public, anon;
grant execute on function public.report_month_label(int, int, boolean) to authenticated, service_role;
grant execute on function public.build_overdue_contracts_report_html(uuid, date) to authenticated, service_role;

-- Seed: copies recipients, locale and next run from 7-DAYS-REPORT (the owner's
-- weekly summary) and is ALWAYS inserted inactive: until the new runner is
-- deployed, an active row would be run by the old builder and email a summary
-- titled "Weekly Overdue Report". The orchestrator activates it after deploy.
insert into public.report_schedules
  (code, name_ar, name_en, frequency, recipients, locale, is_active, next_run_at, report_kind)
select 'WEEKLY-OVERDUE-REPORT', 'تقرير المتأخرات الأسبوعي', 'Weekly Overdue Report', 'weekly',
       coalesce(w.recipients, '[]'::jsonb),
       coalesce(w.locale, 'ar'),
       false,
       w.next_run_at,
       'overdue_contracts'
  from (select 1) as one
  left join lateral (
    select * from public.report_schedules where code = '7-DAYS-REPORT'
  ) w on true
on conflict (code) do nothing;
```

The implementer checks `report_schedules.locale`'s type (`LocaleCode` — text check or enum) and casts `'ar'` if it is an enum; checks `companies` has `name_ar`/`name_en` (else use the columns migration 143 uses for `v_company_name`).

- [ ] **Step 2: Tests lane writes `src/db/overdueContractsReport.sqltest.ts`**: seed one tenant (`commercial_name_ar = 'شركة الاختبار'`) with two contracts; contract A has overdue invoices for 2026-01, 2026-02, 2026-10 (balances 100, 50.5, 25) → row shows `3`, `يناير 2026`, `أكتوبر 2026`, `175.500 KWD`; contract B one overdue invoice → separate row; a `due` invoice and a `paid` invoice are ignored; an archived contract's overdue invoice is ignored; rows ordered by total desc; footer total equals the sum; no overdue → the empty-state text; `authenticated` user without `reports.read` → `42501`; the seed row exists with `report_kind = 'overdue_contracts'`, `frequency = 'weekly'`, `is_active = false`; with a `7-DAYS-REPORT` row present (plus a competing weekly schedule) it copies recipients/locale/next_run_at from `7-DAYS-REPORT` only; without it, recipients are `[]`.

- [ ] **Step 3: Run** `bun run test:sql -- overdueContractsReport` → PASS.

### Task 4: `database.types.ts` entries (orchestrator, before slices dispatch)

**Files:** Modify `src/integrations/supabase/database.types.ts`

- [ ] **Step 1:** Add `report_kind: ReportKind;` to `ReportScheduleRow` (after `recipients`) and export `export type ReportKind = "summary" | "overdue_contracts";` beside `ReportFrequency`.
- [ ] **Step 2:** Under `Functions`, next to `build_scheduled_report_html`:

```ts
      /** Migration 241 — weekly overdue-by-contract report. */
      build_overdue_contracts_report_html: {
        Args: { p_as_of?: string | null; p_schedule_id: string };
        Returns: { html: string; period_end: string; period_start: string }[];
      };
      /** Migration 239 — rows per referencing column that hold this list value. */
      count_option_list_value_usage: {
        Args: { p_item_id: string };
        Returns: Json;
      };
      /** Migration 239 — atomic cascade rename of a list value. */
      rename_option_list_value: {
        Args: { p_item_id: string; p_new_value: string };
        Returns: Json;
      };
```

- [ ] **Step 3:** `bun run typecheck` → PASS. Commit with the migrations.

---

### Task 5: Notification settings renames + workflow↔template chips (Slice A)

**Files:**
- Create: `src/lib/workflowTemplates.ts`, `src/components/admin/WorkflowTemplateChips.tsx`
- Modify: `src/components/admin/WorkflowTable.tsx`, `src/components/admin/WorkflowsPanel.tsx`, `src/components/admin/notifications/NotificationTemplatesTable.tsx`, `src/routes/admin.settings.notifications.tsx`, `src/i18n/locales/{ar,en}/admin.ts`, `src/i18n/locales/{ar,en}/notificationChannel.ts`
- Test (Tests lane): `src/lib/workflowTemplates.test.ts`, `src/components/admin/WorkflowTemplateChips.test.tsx`

**Interfaces:**
- Produces: `WORKFLOW_TEMPLATE_CODES: Readonly<Record<string, readonly string[]>>`, `WORKFLOWLESS_TEMPLATE_CODES: readonly string[]`, `templateCodesFor(workflowKey: string): readonly string[]`, `workflowsUsingTemplate(code: string): string[]`.

- [ ] **Step 1: Renames.** Change values only:
  - `ar/admin.ts` `"notifications.logTitle": "إعدادات الإشعارات"`, `"notifications.title": "سجل الإشعارات"`
  - `en/admin.ts` `"notifications.logTitle": "Notification Settings"`, `"notifications.title": "Notification Log"`

- [ ] **Step 2: Mapping module** `src/lib/workflowTemplates.ts`:

```ts
import { WORKFLOW_CATALOG } from "@/lib/workflowCatalog";

/**
 * يربط كل سير عمل مدمج برموز قوالب الإشعارات التي يرسلها.
 *
 * Senders hard-code their template codes (src/fns/notify*, *Job.ts); this map
 * is the admin-facing view of that wiring. workflowTemplates.test.ts fails when
 * a sender and this map disagree, so it cannot drift silently.
 */
export const WORKFLOW_TEMPLATE_CODES: Readonly<Record<string, readonly string[]>> = {
  overdue: [],
  "overdue-reminders": ["overdue-reminder"],
  "contract-expiry": ["contract-expiry"],
  "scheduled-reports": [],
  "notification-drain": [],
  "gmail-sync": [],
  salaries: [],
  "payment-reconcile": [],
  backup: [],
  "contact-inquiry-received": ["contact-inquiry"],
  "contract-created": ["contract-created"],
  "contract-ended": ["contract-ended"],
  "deposit-confirmed": ["deposit-confirmation"],
  "maintenance-request-created": ["maintenance-request"],
  "manual-payment-invoice": ["receipt", "payment-admin-alert"],
  "payment-succeeded": ["receipt", "payment-admin-alert"],
  "refund-recorded": ["refund-recorded"],
  "contract-closeout-completed": ["contract-closeout"],
  "contract-restored": ["contract-restored"],
  "invoice-written-off": ["invoice-written-off"],
  "invoice-disputed": ["invoice-disputed"],
  "user-credentials-managerial": ["user-credentials"],
  "user-credentials-tenant": ["user-credentials"],
};

/** قوالب تُرسل يدوياً بلا سير عمل، فلا تظهر في عمود القالب. */
export const WORKFLOWLESS_TEMPLATE_CODES: readonly string[] = [
  "invoice-document",
  "company-info",
  "due-reminder",
];

/**
 * يعيد رموز القوالب لسير عمل، أو قائمة فارغة لسير عمل مخصص غير مربوط.
 */
export function templateCodesFor(workflowKey: string): readonly string[] {
  return WORKFLOW_TEMPLATE_CODES[workflowKey] ?? [];
}

/**
 * يعيد مفاتيح سير العمل التي ترسل قالباً معيناً (عمود «مستخدم في»).
 */
export function workflowsUsingTemplate(code: string): string[] {
  return Object.keys(WORKFLOW_TEMPLATE_CODES).filter((key) =>
    WORKFLOW_TEMPLATE_CODES[key]!.includes(code),
  );
}

// Keep the map keyed exactly by the catalogue: a new catalogue entry without a
// row here is a type-visible omission caught by the test.
export const WORKFLOW_TEMPLATE_KEYS_MATCH_CATALOG =
  Object.keys(WORKFLOW_CATALOG).length === Object.keys(WORKFLOW_TEMPLATE_CODES).length;
```

Before finishing, verify each mapping against its sender (`notifyManualPaymentInvoice` / whatever sends `manual-payment-invoice` — grep `"manual-payment-invoice"` in `src/fns`) and correct the list if a sender differs. Delete the last export if the test (Step 6) covers key equality directly — prefer the test; do not ship an unread export.

- [ ] **Step 3: Chip component** `src/components/admin/WorkflowTemplateChips.tsx`:

```tsx
import { Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import type { Tables } from "@/integrations/supabase/database.types";
import { templateCodesFor } from "@/lib/workflowTemplates";

type Template = Tables<"notification_templates">;

/**
 * يعرض قوالب سير العمل كشرائح؛ النقر على شريحة يفتح محرر القالب نفسه.
 *
 * A code with no DB row (deleted by an admin) renders muted and inert — the
 * sender falls back to its built-in copy, so it is information, not an error.
 */
export function WorkflowTemplateChips({
  workflowKey,
  templatesByCode,
  onEdit,
}: {
  workflowKey: string;
  templatesByCode: ReadonlyMap<string, Template>;
  onEdit?: (template: Template) => void;
}) {
  const { t } = useI18n();
  const codes = templateCodesFor(workflowKey);
  if (!codes.length) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {codes.map((code) => {
        const template = templatesByCode.get(code);
        if (!template || !onEdit) {
          return (
            <Badge key={code} variant="outline" className="font-mono text-muted-foreground"
              title={template ? undefined : t("workflows.templateMissing")}>
              {code}
            </Badge>
          );
        }
        return (
          <Button key={code} type="button" size="sm" variant="outline"
            className="h-7 gap-1 px-2 font-mono text-xs"
            aria-label={`${t("common.edit")} ${code}`}
            onClick={() => onEdit(template)}>
            {code}
            <Pencil className="size-3" />
          </Button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Wire the column.**
  - `WorkflowTable` props gain `templatesByCode: ReadonlyMap<string, Tables<"notification_templates">>` and `onEditTemplate?: (template) => void`. Add `<TableHead>{t("workflows.template")}</TableHead>` right after the Workflow head, and a matching `<TableCell><WorkflowTemplateChips workflowKey={job.key} templatesByCode={templatesByCode} onEdit={onEditTemplate} /></TableCell>`. In the mobile/card branch (`isMobile`), add a `CardField`-style row with the same chips.
  - `WorkflowsPanel` accepts the same two props and forwards them.
  - Route: `const templatesByCode = useMemo(() => new Map((templates.data ?? []).map((row) => [row.code, row])), [templates.data]);` and render `<WorkflowsPanel templatesByCode={templatesByCode} onEditTemplate={permissions.can(PERMISSIONS.NOTIFICATIONS_UPDATE) ? openTemplate : undefined} />` — editing is gated on `NOTIFICATIONS_UPDATE`, which `useUpdateNotificationTemplate` requires (`useNotificationTemplates.ts:68`). Load templates with `useNotificationTemplates(canReadNotifications || canManageWorkflows)` so a workflow-only manager sees real (inert) chips instead of "not found". Confirm RLS on `notification_templates` lets such a user read; if it does not, keep their chips inert showing the code only.. `openTemplate` is declared after the early `forbidden` return — move the `useMemo` above that return (hooks rule); `openTemplate` stays a plain function.
  - Keep `WorkflowTable.tsx` under 500 lines; if it crosses, move the mobile card branch into `WorkflowCards.tsx`.

- [ ] **Step 5: "Used by" column** in `NotificationTemplatesTable`: add `<TableHead>{t("workflows.usedBy")}</TableHead>` before Actions; cell renders `workflowsUsingTemplate(template.code)` mapped to the workflow's localized name. Names come from a new optional prop `workflowNames: ReadonlyMap<string, string>` built in the route from `useCronJobs()` rows (`locale === "ar" ? name_ar : name_en`), falling back to the key; `—` when empty. Only query cron jobs when `canManageWorkflows || canReadNotifications` (reuse the hook's enabled flag if it has one; check `useCronJobs` signature).

- [ ] **Step 6: i18n** (both locales, all in `notificationChannel.ts` next to `workflows.title` — Slice A never touches `invoices.ts`):
  - `workflows.template`: ar `القالب` / en `Template`
  - `workflows.templateMissing`: ar `القالب غير موجود — يُستخدم النص الافتراضي` / en `Template not found — built-in copy is used`
  - `workflows.usedBy`: ar `مستخدم في` / en `Used by`

- [ ] **Step 7: Tests lane** — `workflowTemplates.test.ts`:
  1. `Object.keys(WORKFLOW_TEMPLATE_CODES).sort()` equals `Object.keys(WORKFLOW_CATALOG).sort()`.
  2. Every code in the map ∪ `WORKFLOWLESS_TEMPLATE_CODES` is in `LEGACY_TEMPLATE_STEMS ∪ {"company-info"}` (known template codes).
  3. Every known template code is either mapped or in `WORKFLOWLESS_TEMPLATE_CODES` (none orphaned).
  4. **Per-sender pairing, on the selection expressions.** A test-local table `SENDER_FILE: Record<workflowKey, string>` names the file that sends each mapped workflow (find each by grepping the workflow key in `src/fns`). From that file, extract only the codes in template-selection positions with `/(?:loadTemplateCopy\(\s*|renderAdminEmailCopy\(\{[^}]*?code:\s*|\btemplateCode:\s*|\bcode:\s*|const\s+\w*[Cc]ode\w*\s*=\s*)"([a-z0-9-]+)"/g` (extend the alternation if a sender selects its code another way; keep the list explicit). Every extracted code must be in that workflow's list, **and** must be a known template code (so `"invoice-disputed-v2"` fails); every code in the list must be extracted at least once. `contract-created`/`contract-ended` are an explicit exception asserted against the `` `contract-${event}` `` builder in `notifyContractLifecycle.ts`. Before shipping, the Tests lane runs the test once against a temporarily edited copy of `notifyInvoiceDisputed.ts` (code changed to `invoice-disputed-v2`) to confirm it fails, then reverts.
  5. `workflowsUsingTemplate("receipt")` equals `["manual-payment-invoice","payment-succeeded"]` (sorted).
  `WorkflowTemplateChips.test.tsx`: chips render per code; clicking calls `onEdit` with the matching row; missing template renders inert text; unknown workflow key renders `—`.

### Task 6: Overdue report kind in the runner and schedule dialog (Slice A)

**Files:**
- Modify: `src/fns/runReportSchedule.ts`, `src/components/admin/reports/ScheduleDialog.tsx`, `src/i18n/locales/{ar,en}/notificationChannel.ts`
- Test (Tests lane): `src/fns/runReportSchedule.test.ts` (extend or create)

**Interfaces:** Consumes `ReportKind`, `build_overdue_contracts_report_html` (Task 4).

- [ ] **Step 1: Runner.** Replace the single `rpc("build_scheduled_report_html", …)` call with:

```ts
/**
 * يستدعي مولّد HTML المناسب لنوع التقرير في الجدول الزمني.
 *
 * Two SQL builders share one output shape, so everything after the call —
 * generated_reports, PDF, notification, next run — stays one code path.
 */
async function buildReportSnapshot(schedule: { id: string; report_kind: ReportKind }, asOf: string | null) {
  const args = { p_schedule_id: schedule.id, p_as_of: asOf };
  const result =
    schedule.report_kind === "overdue_contracts"
      ? await supabaseAdmin.rpc("build_overdue_contracts_report_html", args)
      : await supabaseAdmin.rpc("build_scheduled_report_html", args);
  if (result.error) throw new Error(result.error.message);
  const snapshot = result.data[0];
  if (!snapshot) throw new Error("The report generator returned no snapshot.");
  return snapshot;
}
```

and use `const snapshot = await buildReportSnapshot(schedule, asOf);`.

- [ ] **Step 2: Dialog.** Add `reportKind: ReportKind` to the draft (default `"summary"`, loaded from `schedule.report_kind`), a `Select` labelled `t("reports.reportKind")` with items `summary` → `t("reports.reportKind.summary")`, `overdue_contracts` → `t("reports.reportKind.overdue_contracts")`, and send `report_kind: draft.reportKind` in both create and update values.

- [ ] **Step 3: i18n** under `reports.*`: `reports.reportKind` ar `نوع التقرير` / en `Report type`; `reports.reportKind.summary` ar `ملخص إداري` / en `Admin summary`; `reports.reportKind.overdue_contracts` ar `المتأخرات حسب العقد` / en `Overdue by contract`.

- [ ] **Step 4: Tests lane** — runner calls `build_overdue_contracts_report_html` for an `overdue_contracts` schedule and `build_scheduled_report_html` for `summary`, and the rest of the pipeline (generated_reports insert, notification insert) runs with the returned snapshot; a builder error propagates. Mock `supabaseAdmin` at the module boundary only (memory: vacuous tests via shared `createServerFn` mocks — test `runReportScheduleRecord` directly, not through the server fn).

---

### Task 7: Cascading list-value rename in the UI + code-bound values (Slice B)

**Files:**
- Modify: `src/hooks/useOptionLists.ts`, `src/components/admin/settings/ListItemsPanel.tsx`, `src/lib/unitFloorTypeBinding.ts`, `src/lib/isRoofContract.ts`, `src/routes/admin.properties.$id.tsx`, `src/routes/admin.units.$id.tsx`, `src/i18n/locales/{ar,en}/admin.ts`
- Create: `src/components/admin/settings/RenameValueDialog.tsx`
- Test (Tests lane): `src/hooks/useOptionLists.rename.test.ts`, `src/components/admin/settings/ListItemsPanel.test.tsx` (extend), `src/lib/unitFloorTypeBinding.test.ts` (update)

**Interfaces:**
- Consumes: RPCs `count_option_list_value_usage`, `rename_option_list_value` (Task 1/4).
- Produces: `useOptionListValueUsage()`, `useRenameOptionListValue()`, `isCodeBoundValue(listCode: string, value: string): boolean`.

- [ ] **Step 1: Hooks** in `useOptionLists.ts`:

```ts
/**
 * يعد السجلات التي ستتغير عند إعادة تسمية قيمة عنصر القائمة.
 */
export function useOptionListValueUsage() {
  return useMutation({
    mutationFn: async (itemId: string) => {
      const { data, error } = await supabase.rpc("count_option_list_value_usage", { p_item_id: itemId });
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
  });
}

/**
 * يعيد تسمية قيمة عنصر القائمة وكل السجلات التي تخزنها في معاملة واحدة على الخادم.
 *
 * Invalidates every query that shows a stored list value, so tables and forms
 * pick up the new value without a reload.
 */
export function useRenameOptionListValue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, newValue }: { itemId: string; newValue: string }) => {
      const { data, error } = await supabase.rpc("rename_option_list_value", {
        p_item_id: itemId,
        p_new_value: newValue,
      });
      if (error) throw error;
      return data as { updated: Record<string, number> };
    },
    onSuccess: () => {
      for (const key of ["option-list-items", "option-list-items-by-code", "units", "properties", "contracts", "unit", "property", "contract"]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}
```

Also invalidate the deposits and mailbox roots. Check the real query-key roots used by `useUnits.ts`, `useProperties*`, `useContracts.ts`, the deposits hooks and the Gmail inbox hooks (`grep -n "queryKey: \[" src/hooks/useUnits.ts src/hooks/useProperties*.ts src/hooks/useContracts.ts`) and use exactly those roots.

- [ ] **Step 2: Code-bound guard** in `unitFloorTypeBinding.ts`: change `roof: "Roof_Apartment"` → `roof: "managemental-services"` and add:

```ts
/**
 * يحدد ما إذا كانت القيمة مربوطة في الشيفرة فلا يجوز تغييرها من الإعدادات.
 *
 * The binding is keyed by unit_floors values and points at unit_types values;
 * renaming either in the database would silently break the floor lock.
 */
export function isCodeBoundValue(listCode: string, value: string): boolean {
  if (listCode === "unit_floors") return value in UNIT_FLOOR_TYPE_BINDING;
  if (listCode === "unit_types") return Object.values(UNIT_FLOOR_TYPE_BINDING).includes(value);
  return false;
}
```

Update the doc comment on the binding (it mentions the old spelling). In `isRoofContract.ts` nothing changes except the comment naming `Roof_Apartment` — update it to say the roof type is whatever `UNIT_FLOOR_TYPE_BINDING.roof` holds.

- [ ] **Step 3: Rename dialog** `RenameValueDialog.tsx`: an `AlertDialog` with props `{ open, oldValue, newValue, counts: Record<string, number> | null, pending, onConfirm, onCancel }`. Body: `t("lists.renameValueConfirm")` with `{old}`/`{new}` filled, then one line per non-zero count using `t("lists.renameValueTable." + key)` (keys `units.type`, `properties.type`, `units.floor`, `contracts.commercial_activity`, `gmail_messages.category`, `deposits.bank_name` — exactly the Task 1 map; an unknown key falls back to the raw key) and the number; `t("lists.renameValueNoRecords")` when all zero.

- [ ] **Step 4: `ListItemsPanel.saveEdit`.** Store `originalValue` on the `editing` state when edit starts. The save has two phases, and which phase is pending is derived from `editing.value.trim() !== originalValue` — no extra state:
  1. **Rename phase** (only when the value differs): `usage.mutateAsync(editing.id)` → open `RenameValueDialog` with the counts. Cancel → nothing saved, row stays open. Confirm → `rename.mutateAsync({ itemId, newValue })`. Preview error, duplicate (`23505` → `t("lists.renameValueDuplicate")`) or any rename error → nothing saved, row stays open. On success set `originalValue = newValue` immediately, so a later failure cannot re-run the rename.
  2. **Metadata phase**: the existing `updateItem` with `updates` **without** `value` (labels/sort/active — the DB trigger rejects `value` in a direct update). On success close the row. On failure: refetch items (the update may have committed before its separate audit request failed, `useOptionLists.ts:161`), keep the row open, toast `t("lists.renameValueLabelsNotSaved")` when phase 1 ran in this save, else the normal error. A retry then runs phase 2 only, because the value now equals `originalValue`.
  In the edit row, render the value `Input` `disabled` with `title={t("lists.valueCodeBound")}` when `isCodeBoundValue(list.code, originalValue)`.

- [ ] **Step 5: Raw-value displays** → labels:
  - `admin.properties.$id.tsx:178` `{p.type}` → `{propertyTypeLabel(p.type)}` with `const propertyTypeLabel = useCatalogueLabel("property_types", "propertyType");` (check the translatePrefix used for property types in `admin.properties.index.tsx`; use the same).
  - `admin.properties.$id.tsx:283` `{u.type}` → `{unitTypeLabel(u.type)}` with `useCatalogueLabel("unit_types", "unitType")`.
  - `admin.units.$id.tsx:140` `{u.type}` → same.
  Null-safe: `x ? label(x) : "—"`.

- [ ] **Step 6: i18n** (`admin.ts`, both locales, next to `lists.validationRequired`):
  - `lists.renameValueTitle`: `تغيير القيمة المخزنة` / `Change stored value`
  - `lists.renameValueConfirm`: `سيتم تغيير «{old}» إلى «{new}» في كل السجلات التالية:` / `"{old}" will change to "{new}" in every record below:`
  - `lists.renameValueNoRecords`: `لا توجد سجلات تستخدم هذه القيمة.` / `No records use this value.`
  - `lists.renameValueTable.units.type`: `نوع الوحدة في الوحدات` / `Unit type on units`
  - `lists.renameValueTable.properties.type`: `نوع العقار في العقارات` / `Property type on properties`
  - `lists.renameValueTable.units.floor`: `الطابق في الوحدات` / `Floor on units`
  - `lists.renameValueTable.contracts.commercial_activity`: `النشاط التجاري في العقود` / `Commercial activity on contracts`
  - `lists.renameValueTable.gmail_messages.category`: `تصنيف رسائل البريد` / `Category on mailbox messages`
  - `lists.renameValueTable.deposits.bank_name`: `البنك في الإيداعات` / `Bank on deposits`
  - `lists.renameValueLabelsNotSaved`: `تم تغيير القيمة المخزنة، لكن لم تُحفظ الأسماء. أعد الحفظ.` / `The stored value was changed, but the labels were not saved. Save again.`
  - `lists.renameValueDuplicate`: `هذه القيمة موجودة مسبقاً في القائمة.` / `This value already exists in the list.`
  - `lists.valueCodeBound`: `هذه القيمة مربوطة بقواعد النظام؛ يمكن تعديل الاسم فقط.` / `This value is bound to system rules; only its labels can be edited.`
  Check how existing messages fill placeholders (memory: `fill both message placeholders in one pass`, commit 5791233) and use the same helper.

- [ ] **Step 7: Tests lane** — hook: rename calls the RPC with the right args and invalidates the listed roots; panel: changing the value shows the dialog with counts and calls rename **then** update-without-value; cancel and duplicate save nothing and keep the row open; rename OK + metadata failure keeps the row open and a second save calls only the metadata update; unchanged value skips the RPCs; code-bound value input is disabled; binding test updated to `managemental-services` **plus a consistency test** (in `unitFloorTypeBinding.test.ts`) that `UNIT_FLOOR_TYPE_BINDING.roof` equals the value migration 239 repairs to (read the migration file and match the literal); `isCodeBoundValue` cases for both lists and an unrelated list.

### Task 8: Tenant name is a real link (Slice B)

**Files:**
- Modify: `src/components/admin/EntityLink.tsx`, `src/components/admin/tenants/TenantsTable.tsx`
- Test (Tests lane): `src/components/admin/tenants/TenantsTable.test.tsx` (extend)

- [ ] **Step 1: `EntityLink`** gains `stopRowEvents?: boolean`; when true, the link's `onClick` and `onKeyDown` call `event.stopPropagation()` (then the caller's `onClick`). Update its doc comment: rows that navigate on click/Enter use `stopRowEvents` so the link doesn't double-navigate.

- [ ] **Step 2: `TenantsTable`** — in the table name cell (`:451-453`) and both card views (`:179`, `:282`), replace `{tenantDisplayName(tenant, locale)}` with:

```tsx
<EntityLink kind="tenant" id={tenant.id} stopRowEvents className="text-foreground no-underline hover:underline">
  {tenantDisplayName(tenant, locale)}
</EntityLink>
```

(keep the surrounding `<p className="truncate font-semibold">` in the cards). Row/card `onClick` and `onKeyDown` stay unchanged.

- [ ] **Step 3: Tests lane** — the name renders as `<a href="/admin/tenants/<id>">`; clicking it navigates once (row `onOpen` not called); Enter on the link doesn't call `onOpen`; clicking elsewhere in the row still calls `onOpen`.

---

### Task 9: Occupancy badge in the contract-builder unit picker (Slice C)

**Files:**
- Modify: `src/hooks/useUnits.ts:195-210`, `src/lib/contractBuilder/units.ts`, `src/components/admin/contracts/PlotUnitPicker.tsx`
- Test (Tests lane): `src/components/admin/contracts/PlotUnitPicker.test.tsx`, fixtures in `units.test.ts`, `ContractBuilderForm.test.tsx`, `admin.contracts.builder.test.tsx`

- [ ] **Step 1:** Add `status` to the select string in `useUnitsForProperties`: `"id,code,name,name_en,paci_no,floor,type,property_id,status"`.
- [ ] **Step 2:** `SelectableUnitRow` gains `status: UnitStatus | null;` (import `UnitStatus` from `database.types`).
- [ ] **Step 3:** In `PlotUnitPicker` after the PACI span:

```tsx
{row.status ? (
  <Badge variant={unitStatusTone(row.status)} className="ms-auto" data-testid="unit-occupancy">
    {t(`unitStatus.${row.status}`)}
  </Badge>
) : null}
```

Import `Badge` and `unitStatusTone` (`@/lib/statusTone`). It reuses the app's existing unit-status labels (مؤجر / شاغر / متاح …) so the builder matches `/admin/units`. Display only — `toggleUnit`, form values, `buildContractHtml` are untouched.
- [ ] **Step 4:** In `isRoofUnit` replace the literal `"Roof_Apartment"` with `UNIT_FLOOR_TYPE_BINDING.roof` (import from `@/lib/unitFloorTypeBinding`) and update its doc comment.
- [ ] **Step 5: Tests lane** — occupied unit shows the occupied label, vacant shows the vacant label, null status shows no badge; the generated contract HTML for a selection containing an occupied unit contains no status label.

### Task 10: Bold filled variables in the contract (Slice C)

**Files:**
- Modify: `src/lib/contractBuilder/html.ts`, `src/lib/contractBuilder/clauses.ar.ts`, `src/lib/contractBuilder/clauses.en.ts`, maybe `src/lib/contractBuilder/clauses.types.ts`
- Create: `src/lib/contractBuilder/boldMarkers.ts`
- Test (Tests lane): `src/lib/contractBuilder/boldMarkers.test.ts`, update `html.test.ts`, run `html.pdf.test.ts`

**Interfaces:** Produces `v(value: string | number): string`, `renderBold(escaped: string): string`, `stripBoldMarkers(s: string): string`, `BOLD_OPEN = "\u0001"`, `BOLD_CLOSE = "\u0002"`.

- [ ] **Step 1:** `boldMarkers.ts`:

```ts
export const BOLD_OPEN = "\u0001";
export const BOLD_CLOSE = "\u0002";

/**
 * يعلّم قيمة مُدخلة من النموذج لتُطبع بخط عريض في العقد.
 *
 * Clause functions return plain strings that html.ts escapes whole, so a
 * literal <strong> would print as text. Control characters survive escaping
 * untouched and cannot come from the form (see schema check below).
 */
export function v(value: string | number): string {
  return `${BOLD_OPEN}${value}${BOLD_CLOSE}`;
}

/** يحوّل العلامات في نص مُهرَّب مسبقاً إلى وسوم <strong>. */
export function renderBold(escaped: string): string {
  return escaped.replace(/\u0001([^\u0001\u0002]*)\u0002/g, "<strong>$1</strong>");
}

/** يزيل العلامات لقياس طول النص الفعلي. */
export function stripBoldMarkers(text: string): string {
  return text.replace(/[\u0001\u0002]/g, "");
}
```

- [ ] **Step 2:** In `clauses.ar.ts` and `clauses.en.ts`, wrap **every value that comes from `ctx`** (party names, nationalities, civil ids, addresses, company fields, dates, `dayName`, amounts and their words, durations, property, activity, trade name) — but NOT `ctx.unitList` as a whole: `formatUnitList` (`units.ts:89`) mixes labels, PACI captions, conjunctions and plot wording, so wrap the unit label, the PACI number and the plot name individually inside `formatUnitList`/`describe` with `v()` as `${v(ctx.x)}`. Do **not** wrap fixed copy, labels, ordinals (`PERSON_ORDINALS`), or punctuation. Parentheses around civil ids stay outside: `(${v(person.civil_id)})`.
- [ ] **Step 3:** In `html.ts`: add `const escB = (s: string | number) => renderBold(esc(s));` (Arabic doc comment) and use it in `renderClause` (paragraphs only), `renderFrontMatter` (opening, second-party lines, preamble). In signature blocks wrap the value `<div>` contents: `<div><strong>${esc(ctx.company.company_name)}</strong></div>` etc. for `company_name`, `signatory_name`, `person.full_name`.
- [ ] **Step 4:** `pageOneVariableLength` joins `stripBoldMarkers(...)` of its parts.
- [ ] **Step 5:** Neutralise sentinels at the single entry point, not in the schemas (they share no string helper, and `refineSecondParty` discards parsed output, `schema.ts:268`): `v()` strips `\u0001`/`\u0002` from its argument before wrapping, and `buildContractHtml` strips them from every string in `values` (a small recursive `stripBoldMarkersDeep`) before `buildClauseContext`. Test: a person name, company name, property name and PACI number containing `\u0001x\u0002` render as plain escaped text with no extra `<strong>`.
- [ ] **Step 6: Tests lane** — multi-unit, multi-plot contract: unit labels, PACI numbers and plot names are each inside `<strong>`, while the conjunction, the PACI caption and parentheses are not; `boldMarkers.test.ts` (round trip, escaping-before-bold: `v("<b>x</b>")` → `<strong>&lt;b&gt;x&lt;/b&gt;</strong>`); `html.test.ts`: escape-once test at `:171` still passes; update `:229` count to match on text content (strip tags) rather than raw HTML; assert a known value (e.g. the tenant's full name) appears inside `<strong>`; fixed copy like `أقر الطرفان` is not inside `<strong>`.
- [ ] **Step 7: Gate** — run `CHROMIUM_PATH=<local chromium> bun run test -- html.pdf` and confirm the five-page test **ran** (not skipped) and passes. If it fails on page count, lower `PAGE_ONE_DENSE_AT` values in `html.ts` until it passes; report the change.

---

### Task 11: Investor wording in invoice/receipt documents (Slice D)

**Files:** Modify `src/i18n/locales/{ar,en}/notificationChannel.ts` (`invoicePrint.tenant` only), `src/i18n/locales/{ar,en}/invoices.ts` (`receipts.tenant` only), `src/lib/emailTemplates/invoices.ts:100,109`
- Test (Tests lane): `src/lib/invoicePrintHtml.test.ts`, `src/lib/paymentReceiptHtml.test.ts`, `src/lib/emailTemplates/invoices.test.ts` (extend/update existing assertions)

- [ ] **Step 1:** Values: `invoicePrint.tenant` ar `المستثمر` / en `Investor`; `receipts.tenant` ar `المستثمر` / en `Investor`.
- [ ] **Step 2:** `emailTemplates/invoices.ts`: `["المستأجر", tenantName]` → `["المستثمر", tenantName]`; `["Tenant", tenantName]` → `["Investor", tenantName]`.
- [ ] **Step 3:** `grep -rn "المستأجر\|المستاجر\|\"Tenant\"" src/lib/invoice* src/lib/payment* src/lib/emailTemplates/invoices.ts src/lib/invoiceDocument.ts src/lib/paymentDocument.ts src/lib/paymentReceiptPdf.ts` → no hits remain in document builders.
- [ ] **Step 4: Tests lane** — invoice HTML and receipt HTML contain `المستثمر` (ar) / `Investor` (en) and not `المستأجر` / `Tenant` as the party label; update any existing snapshot/assertion that expected the old word.

### Task 12: Portal KPI cards — flags, total overdue, auto width (Slice D)

**Files:**
- Modify: `src/lib/cardRegistry.ts`, `src/hooks/usePortalData.ts:188-218`, `src/routes/portal.index.tsx`, `src/i18n/locales/{ar,en}/contractBuilder.ts` (card labels), locale file holding `portal.dashboard.overdueCount` (add `portal.dashboard.totalOverdue`, `portalHome.totalOverdueHint`)
- Create: `src/components/portal/PortalKpiCards.tsx` (keeps `portal.index.tsx` focused)
- Test (Tests lane): `src/routes/portal.index.test.tsx`, `src/components/portal/PortalKpiCards.test.tsx`, `src/routes/admin.settings.cards.test.tsx`

**Interfaces:** Canonical card id is `portal.totalOverdue` (spec updated to match). Produces `usePortalInvoiceSummary` → `{ overdueCount: number; overdueTotal: number; nextDue: string | null }`; `kpiGridClass(count: number): string`.

- [ ] **Step 1: Registry** — append after `portal.leaseConcessions`:

```ts
  { id: "portal.insurance", page: "portal", labelKey: "settings.cards.portal.insurance" },
  { id: "portal.nextDue", page: "portal", labelKey: "settings.cards.portal.nextDue" },
  { id: "portal.overdueInvoices", page: "portal", labelKey: "settings.cards.portal.overdueInvoices" },
  { id: "portal.totalOverdue", page: "portal", labelKey: "settings.cards.portal.totalOverdue" },
```

Labels: `insurance` `بطاقة التأمين المدفوع` / `Insurance paid card`; `nextDue` `بطاقة الاستحقاق القادم` / `Next due card`; `overdueInvoices` `بطاقة الفواتير المتأخرة` / `Overdue invoices card`; `totalOverdue` `بطاقة إجمالي المتأخر` / `Total overdue card`.

- [ ] **Step 2: Summary hook** — return `overdueTotal: roundToFils(overdueRows.reduce((sum, row) => sum + Number(row.balance), 0))` where `overdueRows = data.filter((invoice) => invoice.state === "overdue")`; reuse `overdueRows.length` for `overdueCount`. Replace the "No `outstanding` total" comment with one explaining `overdueTotal` is read by the Total-overdue card and counts only `overdue` invoices (same set as the count card).

- [ ] **Step 3: `PortalKpiCards.tsx`**:

```tsx
/**
 * يختار صنف الشبكة بحسب عدد البطاقات الظاهرة لتملأ عرض الصفحة.
 *
 * Full literal class names — Tailwind only generates classes it can see.
 */
export function kpiGridClass(count: number): string {
  switch (count) {
    case 1: return "grid gap-5 grid-cols-1";
    case 2: return "grid gap-5 grid-cols-1 md:grid-cols-2";
    case 3: return "grid gap-5 grid-cols-1 md:grid-cols-3";
    default: return "grid gap-5 grid-cols-1 md:grid-cols-2 xl:grid-cols-4";
  }
}
```

Component `PortalKpiCards({ insurancePaid, nextDue, overdueCount, overdueTotal })` reads `useCardVisibility()`; while `!flags.isReady` renders the 4-placeholder skeleton with `kpiGridClass(4)`; otherwise builds the list of visible cards in the fixed order insurance → next due → overdue invoices → total overdue (each gated by `flags.isCardVisible(id)`), returns `null` when none are visible, else `<section className={kpiGridClass(cards.length)}>`. The Total-overdue card: `label={t("portal.dashboard.totalOverdue")}` (`إجمالي المبالغ المتأخرة` / `Total overdue amount`), `value={formatKwd(overdueTotal, locale)}`, `hint={t("portalHome.totalOverdueHint")}` (`مجموع أرصدة الفواتير المتأخرة` / `Sum of overdue invoice balances`), icon `CreditCard`, `bgClass="bg-gradient-to-br from-rose-500 via-rose-600 to-red-700 shadow-rose-500/25"`. Move the existing three `VibrantKpiCard` blocks (and the comment about the replaced outstanding card) into this component unchanged.

- [ ] **Step 4: `portal.index.tsx`** — replace the `<section className="grid gap-5 md:grid-cols-3">…</section>` with `<PortalKpiCards … />`; change the loading skeleton to `kpiGridClass(4)` with four placeholders.

- [ ] **Step 5: Tests lane** — all flags visible → 4 cards + `xl:grid-cols-4`; hide two → 2 cards + `md:grid-cols-2`; hide all → no section; flags not ready → skeleton, no card values; total card shows `formatKwd` of the sum of overdue balances only (a `due` row with balance is excluded); settings page lists the four new toggles.

### Task 13: Tighter header/footer bands and raised signatures on page 5 (Slice C, added by the owner 2026-09-29)

**Files:**
- Modify: `src/lib/contractBuilder/html.ts` (`contractBuilderCss` only)
- Test: `src/lib/contractBuilder/html.pdf.test.ts` (existing five-page test must still run and pass), `html.test.ts` (update only if an assertion depends on the changed CSS)

**Owner request:** "decrease the header and footer margins height" and "raise the names and signature layout in the last page (5th), it is very low, right on the footer".

- [ ] **Step 1: Shrink the bands** (each page's top and bottom chrome), in `contractBuilderCss`:
  - `.contract-sheet.doc-page` padding `6mm 10mm 8mm` → `3mm 10mm 4mm`.
  - `.contract-header img` height `85px` → `60px` (width `120px` → `90px`, keep `object-fit: contain`); `.contract-header` `padding-bottom: 4px` → `2px`, `margin-bottom: 6px` → `4px`.
  - `.contract-company` font-size `31px` → `26px` (the letterhead line sets the band height next to the logo).
  - `.contract-footer-band` `padding-top: 8px` → `4px`, font-size `14px` → `13px`.
  - Keep `@page { margin: 8mm }` and `min-height: 274mm` unchanged (the comments explain why), so the page box and pagination are untouched.
  - Update the neighbouring comments to state the new sizes' reason (owner asked for thinner bands, 2026-09-29).
- [ ] **Step 2: Raise the signatures.** `.contract-signatures`: replace `margin-top: auto` with a fixed `margin-top: 28px` (keep `padding-top: 16px` → set to `0`, the margin now carries the gap), and add `margin-bottom: auto` so the spare height of page 5 sits **below** the signatures, above the footer. Rewrite its comment: the owner wants the names/signatures directly after the last clause with room to sign, not pinned to the footer (supersedes the earlier "foot of page 5" choice). Give each `.signature-block > div:last-child` (the "signature" line) `min-height: 36px` so there is physical room to sign.
- [ ] **Step 3: Gate.** Run the five-page PDF test with Chromium (`CHROMIUM_PATH=…`) — it must run (not skip) and pass for both locales at the content limits. If any page overflows because the bands shrank less than the fonts need, do not grow the fonts; report it.
- [ ] **Step 4: Visual check.** Render the Arabic fixture PDF (the test's content-limit fixture) to PNG for pages 1 and 5 and report where the header, first line, last line, signatures and footer sit (mm from top), before vs after.

---

## Execution order and gates

1. Slice M (Tasks 1–3) → Tests lane immediately writes the three SQL suites (Tasks 1–3 Step 2) → `bun run test:db` fresh build + those three suites executed and green (not merely the migrations installing) → Task 4 by orchestrator → commit.
2. Slices A–D in parallel worktrees cut from that commit; orchestrator reviews each diff, runs `clean-code-guard`, commits in order M, A, B, C, D on `feat/admin-batch-sep29`.
3. Tests lane (agy `gemini-3.8-flash-high`) writes the tests listed per task; `test-guard`; full `bun run lint && bun run typecheck && bun run test && bun run test:sql` on the assembled branch; `html.pdf` run with `CHROMIUM_PATH`.
4. `requesting-code-review`; PR; Codex/CodeRabbit rounds.
5. Prod: `pg_dump`; pre-check for Task 2 Step 1; apply 239–241 from the Dokploy checkout after merge is **not** possible before merge — so apply from a chunked transfer with per-chunk md5 (memory: migration-transfer-chunk-md5) **before** merging; `notify pgrst, 'reload schema'`; verify RPCs, the 0 remaining `Roof_Apartment` units, the seeded `WEEKLY-OVERDUE-REPORT` row; merge; verify deployed bundle and `/portal`, `/admin/settings/notifications`, `/admin/settings/lists` live; **only then**, with the report still **inactive**: run it once via run-now (`runReportScheduleRecord` does not check `is_active`) and confirm the email and PDF arrive; restore `next_run_at` to the `7-DAYS-REPORT` row's current `next_run_at` (the run moved it to now + 7 days); then `update report_schedules set is_active = true where code = 'WEEKLY-OVERDUE-REPORT' and jsonb_array_length(recipients) > 0`. If `7-DAYS-REPORT` is missing or has no valid recipients, leave the report inactive and tell the owner which recipients to add.

---

## Debate log

### Round 1 — Codex `gpt-6-astra` effort medium, read-only relay (enforced sandbox; tree verified unchanged)

| # | Finding (sev) | Verdict | Reason / change |
|---|---|---|---|
| 1 | Active seed runs through old builder before deploy (P1) | accept | Seed is always inactive; orchestrator activates after deploy + run-now check (Task 3, execution step 5). |
| 2 | `tenant_categories` is enum-backed but not rejected (P2) | accept | Verified migration 04:118; added to the RPC's reject list + test (d). TS catalogue metadata fix is out of scope. |
| 3 | Concurrent/stale writes can re-orphan values (P2) | partial | Documented as known limitation in Task 1; no FK redesign — owner scale is 1–2 admins and the orphan fallback is visible and repairable. |
| 4 | Direct table updates bypass cascade (P2) | partial | Added `option_list_items_guard_value` trigger: `value` changes only via the RPC (GUC). Bound-value lock stays UI-only: a DB rename of a bound value still cascades data; only the floor lock falls back to "unlocked", which `resolveUnitTypeBinding` already treats as safe. |
| 5 | Rename + metadata are two transactions (P2) | accept | Metadata first, rename second; partial-success toast, refetch, retry re-runs only the rename (Task 7 Step 4). |
| 6 | Seed picks wrong weekly schedule (P2) | accept | Selects `code = '7-DAYS-REPORT'` only; test with a competing weekly row. |
| 7 | Missing references `gmail_messages.category`, `deposits.bank_name` (P2) | accept | Verified migration 62 and DepositFormDialog; added to map, dialog labels and invalidation roots (bank value-vs-label check kept as an implementer gate). |
| 8 | Chips use read permission for edit (P2) | accept | Edit gated on `NOTIFICATIONS_UPDATE`; templates load for workflow managers too. |
| 9 | Anti-drift test proves nothing about pairing (P2) | partial | Replaced with per-sender-file pairing both directions. Negative-control meta-tests rejected: testing the test is out of scope; the two-direction check already fails on a swap. |
| 10 | No shared schema sanitizer; `refineSecondParty` discards output (P2) | accept | Verified `schema.ts:189,268`; sentinels stripped in `v()` and at `buildContractHtml` entry instead. |
| 11 | Wrapping `unitList` bolds fixed copy (P2) | accept | Verified `units.ts:89`; bold per unit label / PACI / plot inside `formatUnitList`. |
| 12 | Slice A edits D's `invoices.ts` (P2) | accept | Key moved to `workflows.usedBy` in `notificationChannel.ts`; shared files listed with integration owner. |
| 13 | Migration gate before its tests exist (P2) | accept | SQL suites written and run right after slice M, before commit. |
| 14 | `portal.totalDue` vs `portal.totalOverdue` (P2) | accept | Canonical `portal.totalOverdue`; spec corrected. |

### Round 2 — Codex `gpt-6-astra` effort medium, read-only relay (tree verified unchanged)

| # | Finding (sev) | Verdict | Reason / change |
|---|---|---|---|
| 1 | Transaction-local GUC expires before the repair update; the fresh build fails (P1) | accept | Verified: `set_config(..., true)` is transaction-local and the runner autocommits. Repair moved into one `DO` block; proof is a green `bun run test:db`. |
| 2 | SQL gate asserts a TS constant Slice B hasn't changed yet (P2) | accept | The SQL test asserts DB state only; a binding↔migration consistency test moves to Task 7. |
| 3 | Metadata-first vs retry-only-rename contradict; audit write after the commit (P2) | accept | Reversed to rename → metadata, with the phase derived from `originalValue`; refetch after a metadata failure; spec order now matches; tests cover cancel/duplicate/partial. Supersedes R1 #5. |
| 4 | Pairing test passes when the selected template changes (P2) | accept | Test now extracts only template-selection expressions, fails on unknown codes, and must be shown failing once on a mutated sender. |
| 5 | `manual_payment_reasons` → `invoices.manual_payment_reason` not covered (P2) | accept | Verified migration 108. That column also stores payment-method values, so its renames are refused rather than cascaded; test (g). |
| 6 | Run-now overwrites the copied next run and races cron (P2) | accept | Verify while inactive, restore `next_run_at` from `7-DAYS-REPORT`, then activate; stays inactive when there's no source row or no valid recipients. |
