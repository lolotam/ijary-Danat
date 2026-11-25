-- 235_session_lifetime_recompute.sql
--
-- 232–234 re-boxed sessions with least(), so a deadline could only shrink.
-- backup_restore() deletes every user_roles row and reinserts the archive in
-- replica mode, and the trigger fires ALWAYS (233): the DELETE left each
-- tenant momentarily roleless (6 hours) and the reinsert could not undo it, so
-- every restore cut every tenant session to 6 hours (Codex review of #261).
--
-- The deadline is now a pure function of the session's sign-in time and the
-- roles the user holds right now: created_at + session_lifetime_for(user).
-- Any sequence of role changes therefore ends at the right value, including a
-- delete-then-reinsert. Measuring from created_at still means a role change
-- never grants a fresh window.

/**
 * يعيد حساب موعد انتهاء الجلسات المفتوحة لمستخدم واحد، تحت قفل المستخدم.
 *
 * Recomputes rather than shortens; see the header for why.
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
     set not_after = s.created_at + public.session_lifetime_for(_user_id)
   where s.user_id = _user_id;
end;
$fn$;

revoke execute on function public.rebox_user_sessions(uuid) from public, anon, authenticated;
