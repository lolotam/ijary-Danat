-- 237_session_lifetime_no_lock_in_restore.sql
--
-- Lock inversion (Codex review of #261): backup_restore() holds ACCESS
-- EXCLUSIVE on user_roles and reinserts rows in replica mode, where the ALWAYS
-- role trigger takes the per-user advisory lock. A sign-in for that user at
-- the same moment takes the advisory lock first, then blocks reading
-- user_roles — each side waiting on the other, a deadlock.
--
-- In replica mode the advisory lock is skipped. The restore's table lock
-- already serializes it against sign-in: the sign-in's user_roles read waits
-- for the restore to commit and then sees the restored roles.

/**
 * يقصّر موعد انتهاء الجلسات المفتوحة لمستخدم واحد وفق أدواره الحالية.
 *
 * Shrink-only (236). Takes the per-user lock except during a restore; see the
 * header for why.
 */
create or replace function public.rebox_user_sessions(_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if _user_id is null or to_regclass('auth.sessions') is null then
    return;
  end if;

  if current_setting('session_replication_role') <> 'replica' then
    perform public.lock_session_lifetime(_user_id);
  end if;

  update auth.sessions s
     set not_after = least(
           coalesce(s.not_after, 'infinity'::timestamptz),
           s.created_at + public.session_lifetime_for(_user_id))
   where s.user_id = _user_id;
end;
$fn$;

revoke execute on function public.rebox_user_sessions(uuid) from public, anon, authenticated;
