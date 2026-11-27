-- 321_revoke_user_sessions.sql
--
-- يُنهي جميع جلسات مستخدم GoTrue ورموز التحديث الخاصة به عند تغيير كلمة المرور أو
-- إعادة تعيينها.
--
-- `@supabase/supabase-js` `auth.admin.signOut(jwt)` requires a user JWT rather
-- than a user id: `confirmPasswordReset` has no caller session at all, and
-- `changeOwnPassword` must revoke stolen refresh tokens across every session.
-- Deleting `auth.refresh_tokens` and `auth.sessions` for `_user_id` is the
-- server-side global sign-out.
--
-- `to_regclass(...)` guards keep the migration safe in the SQL test image where
-- GoTrue has not created the `auth.sessions` / `auth.refresh_tokens` tables.
--
-- EXECUTE is granted to `service_role` alone: only `src/platform/authAdmin.server.ts`
-- may revoke another user's sessions.

/**
 * يحذف رموز التحديث وجلسات GoTrue لمستخدم محدد.
 */
create or replace function public.revoke_user_sessions(_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if _user_id is null then
    return;
  end if;

  if to_regclass('auth.refresh_tokens') is not null then
    execute 'delete from auth.refresh_tokens where user_id = $1::text' using _user_id;
  end if;

  if to_regclass('auth.sessions') is not null then
    execute 'delete from auth.sessions where user_id = $1' using _user_id;
  end if;
end;
$$;

revoke all on function public.revoke_user_sessions(uuid) from public;
revoke all on function public.revoke_user_sessions(uuid) from anon;
revoke all on function public.revoke_user_sessions(uuid) from authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;
