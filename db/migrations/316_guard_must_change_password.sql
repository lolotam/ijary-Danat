-- 316_guard_must_change_password.sql
--
-- يمنع المستخدم من مسح علامة `must_change_password` عن ملفه الشخصي بنفسه، حتى
-- لو كانت لديه صلاحية `users.update`. العلامة تُمسح فقط من دالة الخادم التي
-- تغيّر كلمة المرور (دور `company_service`)، ويستطيع مدير الشركة رفعها على
-- مستخدم آخر.
--
-- Migration 314 added `profiles.must_change_password`, the flag that forces a
-- first-sign-in password change (FR-032). The self-update guard from migration
-- 279 pinned only `tenant_id`, `company_id` and `is_active`, so a signed-in
-- user could clear their own flag with a direct PostgREST update and skip the
-- forced change. The flag now keeps its old value on any update a user makes
-- to their OWN row, whatever their permissions. It is cleared by the password
-- change server function, which runs as `company_service` where `auth.uid()`
-- is null, and staff with `users.update` can still set or clear it on someone
-- else's row (an admin forcing a reset).
--
-- The rest of the body is migration 279's definition, unchanged.
--
-- Rollback: re-apply the guard_profile_self_update body of migration 279.
--
-- Guarded by src/db/guardMustChangePassword.sqltest.ts.

/**
 * يمنع المستخدم غير المخوّل من تعديل حقول الربط والتعطيل في ملفه الشخصي،
 * ويمنع أي مستخدم من مسح علامة تغيير كلمة المرور عن نفسه.
 */
create or replace function public.guard_profile_self_update()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() = old.id and not public.has_permission(auth.uid(), 'users.update') then
    new.tenant_id  := old.tenant_id;
    new.company_id := old.company_id;
    new.is_active  := old.is_active;
  end if;
  if auth.uid() = old.id then
    new.must_change_password := old.must_change_password;
  end if;
  return new;
end;
$$;
