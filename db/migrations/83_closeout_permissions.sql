-- 83_closeout_permissions.sql
--
-- Seed the six special permission codes that gate Contract Close-out and the
-- related money corrections (refund reverse/void, invoice write-off/dispute).
--
-- These are SPECIAL codes on EXISTING modules, not a new `closeouts` module.
-- PERMISSION_MODULES is expanded against BASE_PERMISSION_ACTIONS in
-- src/lib/permissions.ts, so a new module would invent meaningless codes
-- (closeouts.export, closeouts.delete, …). Same reasoning as portal.tab_*
-- (migration 46 / SPECIAL_PERMISSION_CODES comment).
--
-- Role grants:
--   admin       — all six (matrix consistency; has_permission also short-circuits)
--   accountant  — invoices.write_off + invoices.dispute ONLY
--                 (mirrors the existing rule: record and correct, not delete;
--                  not refunds.reverse / refunds.void, not contract lifecycle)
--   everyone else — none
--
-- The TypeScript catalog in src/lib/permissions.ts MUST list the same six codes.
-- usePermissions().can() filters through isPermissionCode and silently drops
-- any code that exists only in SQL (live bug today for landing_page.*).

------------------------------------------------------------
-- Permission catalog
------------------------------------------------------------

insert into public.permissions (code, module, action, is_system)
values
  ('contracts.close_out', 'contracts', 'close_out', true),
  ('contracts.restore',   'contracts', 'restore',   true),
  ('refunds.reverse',     'refunds',   'reverse',   true),
  ('refunds.void',        'refunds',   'void',      true),
  ('invoices.write_off',  'invoices',  'write_off', true),
  ('invoices.dispute',    'invoices',  'dispute',   true)
on conflict (code) do nothing;

------------------------------------------------------------
-- Default role mappings
------------------------------------------------------------

insert into public.role_permissions (role, permission_code)
select 'admin'::public.app_role, p.code
from public.permissions p
where p.code in (
  'contracts.close_out',
  'contracts.restore',
  'refunds.reverse',
  'refunds.void',
  'invoices.write_off',
  'invoices.dispute'
)
on conflict (role, permission_code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'accountant'::public.app_role, p.code
from public.permissions p
where p.code in (
  'invoices.write_off',
  'invoices.dispute'
)
on conflict (role, permission_code) do nothing;
