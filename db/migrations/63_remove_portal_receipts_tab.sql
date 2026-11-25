-- 63_remove_portal_receipts_tab.sql
--
-- The tenant portal's "My Receipts" section is removed at the owner's request:
-- it duplicated My Payments, where every row already carries Preview, Print and
-- Download (PDF) of the same payment receipt (components/portal/PaymentRowActions).
-- Verified before deleting the page — removing it costs the tenant nothing.
--
-- This migration cleans up what the page left behind. Migration 46 gave every
-- portal tab two switches, and with the page gone both would be controls that
-- change nothing:
--
--   * `portal.tab_receipts`          — the role-level permission
--   * `tenants.portal_tab_receipts`  — the per-tenant override
--
-- Leaving them would reproduce this codebase's most common defect shape: a
-- value an admin can set that nothing reads. The admin form would still offer
-- "My Receipts" as a toggle, and turning it on would do nothing observable.
--
-- Nothing financial is touched. `receipts` rows, `receipts.visible_to_tenant`
-- and the admin-side receipts screens are all untouched — only the tenant
-- portal's duplicate listing of them goes.

-- `role_permissions.permission_code` references `permissions(code)` ON DELETE
-- CASCADE (03_phase1_permissions_audit.sql), so deleting the permission takes
-- its role grants with it — no separate cleanup, and no orphan left behind.
delete from public.permissions where code = 'portal.tab_receipts';

alter table public.tenants drop column if exists portal_tab_receipts;
