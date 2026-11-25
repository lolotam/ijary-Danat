-- 46_portal_tab_visibility.sql
-- Two-level visibility control for the six tenant portal tabs
-- (Dashboard, My Lease, My Invoices, My Payments, My Receipts, Profile):
--   1. permissions on the `tenant` role set the global default
--   2. nullable columns on public.tenants override that per tenant
-- Idempotent. Re-running preserves existing grants and overrides.

------------------------------------------------------------
-- Permission catalog
------------------------------------------------------------

-- Module stays 'portal' so the codes satisfy the
-- permissions_code_matches_parts check (code = module || '.' || action) and so
-- the roles screen groups them under the existing Tenant portal card.
insert into public.permissions (code, module, action, description_ar, description_en, is_system)
values
  ('portal.tab_dashboard', 'portal', 'tab_dashboard',
   'بوابة المستأجر: تبويب الرئيسية', 'Tenant portal: Dashboard tab', true),
  ('portal.tab_lease', 'portal', 'tab_lease',
   'بوابة المستأجر: تبويب عقدي', 'Tenant portal: My Lease tab', true),
  ('portal.tab_invoices', 'portal', 'tab_invoices',
   'بوابة المستأجر: تبويب فواتيري', 'Tenant portal: My Invoices tab', true),
  ('portal.tab_payments', 'portal', 'tab_payments',
   'بوابة المستأجر: تبويب مدفوعاتي', 'Tenant portal: My Payments tab', true),
  ('portal.tab_receipts', 'portal', 'tab_receipts',
   'بوابة المستأجر: تبويب إيصالاتي', 'Tenant portal: My Receipts tab', true),
  ('portal.tab_profile', 'portal', 'tab_profile',
   'بوابة المستأجر: تبويب الملف الشخصي', 'Tenant portal: Profile tab', true)
on conflict (code) do nothing;

------------------------------------------------------------
-- Default role mappings
------------------------------------------------------------

-- Load-bearing: migration 03 seeded the tenant role with only portal.read and
-- receipts.read. Without this grant every tenant would lose every tab the
-- moment this migration lands, because the resolver falls back to the role
-- default whenever the per-tenant override is null (which it is for all
-- existing rows).
insert into public.role_permissions (role, permission_code)
select 'tenant'::public.app_role, p.code
from public.permissions p
where p.module = 'portal' and p.action like 'tab\_%'
on conflict (role, permission_code) do nothing;

-- Cosmetic for admins (has_permission short-circuits on the admin role and the
-- roles matrix renders admin as always-checked), but mirrors migration 03 so
-- the table stays consistent.
insert into public.role_permissions (role, permission_code)
select 'admin'::public.app_role, p.code
from public.permissions p
where p.module = 'portal' and p.action like 'tab\_%'
on conflict (role, permission_code) do nothing;

------------------------------------------------------------
-- Per-tenant overrides
------------------------------------------------------------

-- Deliberately nullable with no default. Three distinct states:
--   null  -> follow the tenant role permission
--   true  -> always show this tab for this tenant
--   false -> always hide this tab for this tenant
-- A NOT NULL boolean could only express "force on" and would need a backfill
-- that guesses intent for every existing tenant.
alter table public.tenants
  add column if not exists portal_tab_dashboard boolean,
  add column if not exists portal_tab_lease     boolean,
  add column if not exists portal_tab_invoices  boolean,
  add column if not exists portal_tab_payments  boolean,
  add column if not exists portal_tab_receipts  boolean,
  add column if not exists portal_tab_profile   boolean;

comment on column public.tenants.portal_tab_dashboard is
  'Portal tab override: null = follow tenant role permission, true = force show, false = force hide.';
comment on column public.tenants.portal_tab_lease is
  'Portal tab override: null = follow tenant role permission, true = force show, false = force hide.';
comment on column public.tenants.portal_tab_invoices is
  'Portal tab override: null = follow tenant role permission, true = force show, false = force hide.';
comment on column public.tenants.portal_tab_payments is
  'Portal tab override: null = follow tenant role permission, true = force show, false = force hide.';
comment on column public.tenants.portal_tab_receipts is
  'Portal tab override: null = follow tenant role permission, true = force show, false = force hide.';
comment on column public.tenants.portal_tab_profile is
  'Portal tab override: null = follow tenant role permission, true = force show, false = force hide.';

-- No RLS changes. Tab visibility is presentation only; the underlying rows are
-- already tenant-isolated by invoices_select_allowed (migration 05),
-- units_/properties_/companies_select_tenant (migration 17) and the tenant
-- isolation hardening in migration 39. Hiding a tab is not a security boundary.
