-- 232_session_lifetime_on_role_grant.sql
--
-- 231 stamps auth.sessions.not_after when a session is created, from the
-- roles held at that moment. A tenant who is signed in and is then granted a
-- staff role would keep the 6-month deadline while holding staff privileges
-- (Codex review of #261). This re-applies the lifetime to that user's open
-- sessions whenever a role row is inserted or changed.
--
-- The deadline is recomputed from the session's own created_at, never from
-- now(): granting a role must not hand anyone a fresh window. A session older
-- than the new lifetime therefore ends at its next refresh, and the person
-- signs in again with the new role. least() means this can only shorten.

/**
 * يعيد حساب موعد انتهاء الجلسات المفتوحة لمستخدم تغيّرت أدواره.
 *
 * SECURITY DEFINER because auth.sessions belongs to GoTrue and the role that
 * edits user_roles cannot write it. The table only exists where GoTrue has run;
 * the guard keeps role changes working in the SQL test image.
 */
create or replace function public.user_roles_shorten_sessions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if to_regclass('auth.sessions') is null then
    return null;
  end if;

  update auth.sessions s
     set not_after = least(
           coalesce(s.not_after, 'infinity'::timestamptz),
           s.created_at + public.session_lifetime_for(new.user_id))
   where s.user_id = new.user_id;

  return null;
end;
$fn$;

revoke execute on function public.user_roles_shorten_sessions() from public, anon, authenticated;

drop trigger if exists user_roles_shorten_sessions on public.user_roles;
create trigger user_roles_shorten_sessions
  after insert or update of role, user_id on public.user_roles
  for each row execute function public.user_roles_shorten_sessions();
