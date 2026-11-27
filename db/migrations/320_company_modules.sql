-- 320_company_modules.sql (T107)
--
-- ينشئ جدول `company_modules` لتفعيل وإيقاف أقسام اللوحة لكل شركة على حدة،
-- ويضيف دالتي `module_enabled(_key)` و`get_my_modules()`، ويربط `has_permission`
-- بربط كل رمز صلاحية بقسمه عبر `permission_section(_code)` بحيث تُمنع صلاحيات
-- القسم المقفل عن جميع الأدوار بما فيها `admin`.
--
-- Per spec.md User Story 5, data-model.md `company_modules`, and research.md R10:
--   - `company_modules` stores per-company overrides with forced RLS: company
--     staff (and `company_service`) may SELECT their own company's rows, while
--     only `service_role` (platform super admin) writes.
--   - Missing rows fall back to `DEFAULT_MODULE_ENABLED` from `src/company/modules.ts`:
--     all 17 keys default to `true` except `landing_page` and `maintenance` (`false`).
--   - `permission_section(_code)` is an IMMUTABLE SQL mirror of `PERMISSION_SECTION`
--     in `src/company/modules.ts` (avoiding an extra unscoped table in `public` and
--     verified against the TS map in `src/db/modules/moduleGate.sqltest.ts`).
--   - `has_permission` checks `module_enabled(permission_section(_code))` before
--     any role or custom-role grant, including the `admin` short-circuit.
--
-- Rollback:
--   re-apply `public.has_permission` from migration 279;
--   drop function if exists public.get_my_modules();
--   drop function if exists public.module_enabled(text);
--   drop function if exists public.permission_section(text);
--   drop table if exists public.company_modules;

------------------------------------------------------------
-- 1. company_modules table & RLS
------------------------------------------------------------

create table if not exists public.company_modules (
  company_id uuid not null references public.companies(id) on delete cascade,
  module_key text not null
    check (module_key in (
      'invoices',
      'tenants',
      'properties',
      'units',
      'contracts',
      'payments',
      'deposits',
      'expenses',
      'electricity',
      'maintenance',
      'employees',
      'inbox',
      'reports',
      'audit',
      'online_payments',
      'whatsapp',
      'landing_page'
    )),
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (company_id, module_key)
);

drop trigger if exists set_updated_at on public.company_modules;
create trigger set_updated_at
  before update on public.company_modules
  for each row execute function public.tg_set_updated_at();

alter table public.company_modules enable row level security;
alter table public.company_modules force row level security;

revoke all on public.company_modules from public, anon, authenticated, company_service;
grant select on public.company_modules to authenticated, company_service;
grant all on public.company_modules to service_role;

drop policy if exists company_modules_select_own on public.company_modules;
create policy company_modules_select_own
  on public.company_modules
  for select
  to authenticated, company_service
  using (
    company_id = (select public.current_company_id())
    and (
      (select auth.role()) = 'company_service'
      or (select public.is_staff((select auth.uid())))
    )
  );

drop policy if exists company_modules_service_role_all on public.company_modules;
create policy company_modules_service_role_all
  on public.company_modules
  for all
  to service_role
  using (true)
  with check (true);

insert into public.company_modules (company_id, module_key, enabled)
select c.id, m.module_key, m.module_key not in ('landing_page', 'maintenance')
  from public.companies c
  cross join (
    values
      ('invoices'),
      ('tenants'),
      ('properties'),
      ('units'),
      ('contracts'),
      ('payments'),
      ('deposits'),
      ('expenses'),
      ('electricity'),
      ('maintenance'),
      ('employees'),
      ('inbox'),
      ('reports'),
      ('audit'),
      ('online_payments'),
      ('whatsapp'),
      ('landing_page')
  ) as m(module_key)
on conflict (company_id, module_key) do nothing;

------------------------------------------------------------
-- 2. Permission-to-section mapping & module_enabled helper
------------------------------------------------------------

/**
 * يرجع مفتاح القسم المرتبط برمز الصلاحية، أو `null` للصلاحيات الدائمة غير المرتبطة بقسم.
 *
 * Mirrors `PERMISSION_SECTION` in `src/company/modules.ts` as an immutable SQL
 * function so `has_permission` can gate section permissions without adding an
 * unscoped lookup table in `public`.
 */
create or replace function public.permission_section(_code text)
returns text
language sql
immutable
as $$
  select case _code
    when 'invoices.create' then 'invoices'
    when 'invoices.read' then 'invoices'
    when 'invoices.update' then 'invoices'
    when 'invoices.delete' then 'invoices'
    when 'invoices.export' then 'invoices'
    when 'invoices.write_off' then 'invoices'
    when 'invoices.dispute' then 'invoices'

    when 'tenants.create' then 'tenants'
    when 'tenants.read' then 'tenants'
    when 'tenants.update' then 'tenants'
    when 'tenants.delete' then 'tenants'
    when 'tenants.export' then 'tenants'

    when 'properties.create' then 'properties'
    when 'properties.read' then 'properties'
    when 'properties.update' then 'properties'
    when 'properties.delete' then 'properties'
    when 'properties.export' then 'properties'
    when 'buildings.create' then 'properties'
    when 'buildings.read' then 'properties'
    when 'buildings.update' then 'properties'
    when 'buildings.delete' then 'properties'
    when 'buildings.export' then 'properties'

    when 'units.create' then 'units'
    when 'units.read' then 'units'
    when 'units.update' then 'units'
    when 'units.delete' then 'units'
    when 'units.export' then 'units'

    when 'contracts.create' then 'contracts'
    when 'contracts.read' then 'contracts'
    when 'contracts.update' then 'contracts'
    when 'contracts.delete' then 'contracts'
    when 'contracts.export' then 'contracts'
    when 'contracts.close_out' then 'contracts'
    when 'contracts.restore' then 'contracts'
    when 'insurance.create' then 'contracts'
    when 'insurance.read' then 'contracts'
    when 'insurance.update' then 'contracts'
    when 'insurance.delete' then 'contracts'
    when 'insurance.export' then 'contracts'

    when 'payments.create' then 'payments'
    when 'payments.read' then 'payments'
    when 'payments.update' then 'payments'
    when 'payments.delete' then 'payments'
    when 'payments.export' then 'payments'
    when 'payments.reverse' then 'payments'
    when 'refunds.create' then 'payments'
    when 'refunds.read' then 'payments'
    when 'refunds.update' then 'payments'
    when 'refunds.delete' then 'payments'
    when 'refunds.export' then 'payments'
    when 'refunds.reverse' then 'payments'
    when 'refunds.void' then 'payments'
    when 'partial_payments.create' then 'payments'
    when 'partial_payments.read' then 'payments'
    when 'partial_payments.update' then 'payments'
    when 'partial_payments.delete' then 'payments'
    when 'partial_payments.export' then 'payments'
    when 'receipts.create' then 'payments'
    when 'receipts.read' then 'payments'
    when 'receipts.update' then 'payments'
    when 'receipts.delete' then 'payments'
    when 'receipts.export' then 'payments'

    when 'deposits.create' then 'deposits'
    when 'deposits.read' then 'deposits'
    when 'deposits.update' then 'deposits'
    when 'deposits.delete' then 'deposits'
    when 'deposits.export' then 'deposits'

    when 'expenses.create' then 'expenses'
    when 'expenses.read' then 'expenses'
    when 'expenses.update' then 'expenses'
    when 'expenses.delete' then 'expenses'
    when 'expenses.export' then 'expenses'
    when 'expenses.categories' then 'expenses'

    when 'electricity.create' then 'electricity'
    when 'electricity.read' then 'electricity'
    when 'electricity.update' then 'electricity'
    when 'electricity.delete' then 'electricity'
    when 'electricity.export' then 'electricity'
    when 'electricity.tariffs' then 'electricity'

    when 'maintenance.create' then 'maintenance'
    when 'maintenance.read' then 'maintenance'
    when 'maintenance.update' then 'maintenance'
    when 'maintenance.delete' then 'maintenance'
    when 'maintenance.export' then 'maintenance'

    when 'employees.create' then 'employees'
    when 'employees.read' then 'employees'
    when 'employees.update' then 'employees'
    when 'employees.delete' then 'employees'
    when 'employees.export' then 'employees'
    when 'salaries.create' then 'employees'
    when 'salaries.read' then 'employees'
    when 'salaries.update' then 'employees'
    when 'salaries.delete' then 'employees'
    when 'salaries.export' then 'employees'

    when 'inbox.manage' then 'inbox'

    when 'reports.create' then 'reports'
    when 'reports.read' then 'reports'
    when 'reports.update' then 'reports'
    when 'reports.delete' then 'reports'
    when 'reports.export' then 'reports'

    when 'audit.create' then 'audit'
    when 'audit.read' then 'audit'
    when 'audit.update' then 'audit'
    when 'audit.delete' then 'audit'
    when 'audit.export' then 'audit'

    when 'payment_links.create' then 'online_payments'
    when 'payment_links.read' then 'online_payments'
    when 'payment_links.update' then 'online_payments'
    when 'payment_links.delete' then 'online_payments'
    when 'payment_links.export' then 'online_payments'

    else null
  end;
$$;

/**
 * يتحقق مما إذا كان القسم المطلوب مفعّلاً للشركة الحالية، ويفشل مغلقاً عند غياب السياق.
 *
 * Uses `security definer` so callers without direct `company_modules` SELECT
 * access (e.g., `has_permission` evaluation) still resolve the company's flag,
 * while failing closed when `current_company_id()` is null or `_key` is unknown.
 */
create or replace function public.module_enabled(_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when (select public.current_company_id()) is null then false
    when _key is null or _key not in (
      'invoices', 'tenants', 'properties', 'units', 'contracts',
      'payments', 'deposits', 'expenses', 'electricity', 'maintenance',
      'employees', 'inbox', 'reports', 'audit', 'online_payments',
      'whatsapp', 'landing_page'
    ) then false
    else coalesce(
      (
        select cm.enabled
          from public.company_modules cm
         where cm.company_id = (select public.current_company_id())
           and cm.module_key = _key
      ),
      _key not in ('landing_page', 'maintenance')
    )
  end;
$$;

revoke all on function public.module_enabled(text) from public, anon;
grant execute on function public.module_enabled(text) to authenticated, company_service, service_role;

/**
 * يرجع حالة جميع الأقسام السبعة عشر للشركة الحالية مع تطبيق القيم الافتراضية.
 */
create or replace function public.get_my_modules()
returns table (module_key text, enabled boolean)
language sql
stable
security invoker
set search_path = public
as $$
  select
    k.module_key,
    public.module_enabled(k.module_key) as enabled
  from unnest(array[
    'invoices',
    'tenants',
    'properties',
    'units',
    'contracts',
    'payments',
    'deposits',
    'expenses',
    'electricity',
    'maintenance',
    'employees',
    'inbox',
    'reports',
    'audit',
    'online_payments',
    'whatsapp',
    'landing_page'
  ]::text[]) as k(module_key)
  where (select public.current_company_id()) is not null;
$$;

revoke all on function public.get_my_modules() from public, anon;
grant execute on function public.get_my_modules() to authenticated, company_service, service_role;

------------------------------------------------------------
-- 3. Gate has_permission by section status
------------------------------------------------------------

/**
 * يتحقق من امتلاك المستخدم للصلاحية المطلوبة ضمن الشركة الحالية عبر الأدوار القياسية أو المخصصة،
 * مع رفض صلاحيات أي قسم مقفل لجميع الأدوار بما فيها `admin`.
 */
create or replace function public.has_permission(_user_id uuid, _code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (
    (select public.permission_section(_code)) is null
    or (select public.module_enabled((select public.permission_section(_code))))
  )
  and exists (
    select 1
      from public.profiles p
     where p.id = _user_id
       and p.is_active
       and p.company_id = (select public.current_company_id())
  ) and coalesce(
    (select public.has_role(_user_id, 'admin'::public.app_role))
    or exists (
      select 1
        from public.user_roles ur
        join public.role_permissions rp
          on rp.company_id = ur.company_id
         and rp.role = ur.role
       where ur.user_id = _user_id
         and ur.company_id = (select public.current_company_id())
         and rp.permission_code = _code
    )
    or exists (
      select 1
        from public.user_custom_roles ucr
        join public.custom_roles cr
          on cr.id = ucr.custom_role_id
         and cr.company_id = ucr.company_id
        join public.custom_role_permissions crp
          on crp.custom_role_id = cr.id
         and crp.company_id = cr.company_id
       where ucr.user_id = _user_id
         and ucr.company_id = (select public.current_company_id())
         and cr.is_active = true
         and crp.permission_code = _code
    ),
    false
  );
$$;
