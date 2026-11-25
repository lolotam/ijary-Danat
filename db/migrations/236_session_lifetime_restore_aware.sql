-- 236_session_lifetime_restore_aware.sql
--
-- 235 recomputed deadlines outright so a restore's delete-then-reinsert of
-- user_roles would land back on 6 months. That also let a later role change
-- revive a session whose deadline had already passed — a staff member timed
-- out at 6 hours, then made tenant-only, got 6 months again (Codex review of
-- #261).
--
-- Deadlines go back to shrink-only (least()), and the restore case is handled
-- where it arises: backup_restore() runs in session_replication_role =
-- replica and deletes every user_roles row before reinserting the archive, so
-- a DELETE in replica mode is skipped. The reinsert that follows re-boxes the
-- user from the restored roles. Cost: a restore that drops a tenant's role
-- outright leaves a roleless account on its old deadline — an account with no
-- role can reach nothing in the app.

/**
 * يقصّر موعد انتهاء الجلسات المفتوحة لمستخدم واحد وفق أدواره الحالية، تحت قفل المستخدم.
 *
 * Shrink-only: a role change can end a session sooner, never later.
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

  perform public.lock_session_lifetime(_user_id);

  update auth.sessions s
     set not_after = least(
           coalesce(s.not_after, 'infinity'::timestamptz),
           s.created_at + public.session_lifetime_for(_user_id))
   where s.user_id = _user_id;
end;
$fn$;

revoke execute on function public.rebox_user_sessions(uuid) from public, anon, authenticated;

/**
 * يعيد حساب مدة جلسات كل مستخدم تغيّرت أدواره، مع تجاوز الحذف المؤقت أثناء الاستعادة.
 */
create or replace function public.user_roles_shorten_sessions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.rebox_user_sessions(new.user_id);
  end if;
  if tg_op = 'UPDATE' and old.user_id is distinct from new.user_id then
    perform public.rebox_user_sessions(old.user_id);
  end if;
  -- A replica-mode DELETE is backup_restore() emptying the table before it
  -- reinserts the archive; the reinsert re-boxes from the restored roles.
  if tg_op = 'DELETE' and current_setting('session_replication_role') <> 'replica' then
    perform public.rebox_user_sessions(old.user_id);
  end if;
  return null;
end;
$fn$;

revoke execute on function public.user_roles_shorten_sessions() from public, anon, authenticated;
