-- 205_revoke_tenant_payments_tab.sql
--
-- إخفاء تبويب «مدفوعاتي» افتراضياً عن المستأجرين بسحب صلاحيته من دور المستأجر.
--
-- Every production tenant is on "inherit" (checked 2026-09-14: 57 null, 0
-- true, 0 false), so removing the role default hides the tab for all of them
-- while keeping the tri-state override (an admin can still force-show one
-- tenant) and the permission row (Settings → Roles can grant it back).
-- Data-only, idempotent. Runs after 46 under the harness's numeric order.

delete from public.role_permissions
 where role = 'tenant'::public.app_role
   and permission_code = 'portal.tab_payments';
