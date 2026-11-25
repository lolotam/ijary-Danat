-- 233_session_lifetime_hardening.sql
--
-- Two gaps in 231/232, from Codex review of #261:
--
-- 1. backup_restore() sets session_replication_role = replica (146) while it
--    rewrites public tables, user_roles included. Ordinary triggers do not
--    fire in replica mode, so a restore that turns a signed-in tenant into
--    staff would leave the 6-month deadline. The role trigger is made
--    ENABLE ALWAYS so it fires during a restore too.
--
-- 2. Write skew: a sign-in (insert on auth.sessions) and a role grant (insert
--    on user_roles) for the same user, in concurrent transactions, could each
--    miss the other's uncommitted row. Both triggers now take the same
--    per-user transaction advisory lock first, and the sign-in trigger reads
--    roles only AFTER holding it. Under READ COMMITTED each statement in a
--    volatile plpgsql function takes a fresh snapshot, so the role lookup that
--    follows the lock sees whatever the other transaction committed.

/**
 * يقفل حساب مدة الجلسة لمستخدم واحد حتى نهاية المعاملة الحالية.
 *
 * The key is namespaced so it cannot collide with another feature's advisory
 * locks on the same user id.
 */
create or replace function public.lock_session_lifetime(_user_id uuid)
returns void
language sql
volatile
set search_path = public, pg_temp
as $fn$
  select pg_advisory_xact_lock(hashtextextended('session_lifetime:' || _user_id::text, 0));
$fn$;

revoke execute on function public.lock_session_lifetime(uuid) from public, anon, authenticated;

/**
 * يضبط موعد انتهاء الجلسة الجديدة عند إنشائها وفق دور صاحبها.
 *
 * Same rule as 231; the deadline is now computed after the lock, not in
 * DECLARE, so a role granted concurrently is seen.
 */
create or replace function public.auth_sessions_set_not_after()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  deadline timestamptz;
begin
  perform public.lock_session_lifetime(new.user_id);
  deadline := coalesce(new.created_at, now()) + public.session_lifetime_for(new.user_id);
  new.not_after := least(coalesce(new.not_after, deadline), deadline);
  return new;
end;
$fn$;

revoke execute on function public.auth_sessions_set_not_after() from public, anon, authenticated;

/**
 * يعيد حساب موعد انتهاء الجلسات المفتوحة لمستخدم تغيّرت أدواره.
 *
 * Same rule as 232, now under the per-user lock shared with sign-in.
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

  perform public.lock_session_lifetime(new.user_id);

  update auth.sessions s
     set not_after = least(
           coalesce(s.not_after, 'infinity'::timestamptz),
           s.created_at + public.session_lifetime_for(new.user_id))
   where s.user_id = new.user_id;

  return null;
end;
$fn$;

revoke execute on function public.user_roles_shorten_sessions() from public, anon, authenticated;

-- Fires in replica mode too, i.e. during backup_restore().
alter table public.user_roles enable always trigger user_roles_shorten_sessions;
