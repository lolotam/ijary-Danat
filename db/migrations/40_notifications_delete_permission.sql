-- ============================================================
-- Migration 40: Permission-gated delete on notifications
--
-- The notification log only had a `for all` admin write policy, so deletion
-- was implicitly admin-only. This adds a dedicated DELETE policy governed by
-- the `notifications.delete` permission so the bulk-delete UI works for any
-- role that holds it (admins are already covered — has_permission returns
-- true for admin). Permissive policies OR together, so this coexists with
-- notifications_admin_write. The `delete` grant to `authenticated` already
-- exists (migration 07).
-- Idempotent.
-- ============================================================

drop policy if exists notifications_delete_perm on public.notifications;
create policy notifications_delete_perm on public.notifications
  for delete to authenticated
  using (public.has_permission(auth.uid(), 'notifications.delete'));
