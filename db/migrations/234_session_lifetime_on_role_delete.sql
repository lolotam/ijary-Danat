-- 234_session_lifetime_on_role_delete.sql
--
-- 232/233 re-box a user's open sessions when a role row is inserted or
-- updated, but not when one is deleted (Codex review of #261). Revoking a
-- tenant's only role leaves a roleless account, which session_lifetime_for()
-- boxes at 6 hours, yet its session kept the 6-month deadline. The trigger now
-- also fires on DELETE, and on an UPDATE that moves a row between users it
-- re-boxes both of them.

/**
 * يعيد حساب موعد انتهاء الجلسات المفتوحة لمستخدم واحد، تحت قفل المستخدم.
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
 * يعيد حساب مدة جلسات كل مستخدم تغيّرت أدواره بإضافة أو تعديل أو حذف.
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
  if tg_op = 'DELETE'
     or (tg_op = 'UPDATE' and old.user_id is distinct from new.user_id) then
    perform public.rebox_user_sessions(old.user_id);
  end if;
  return null;
end;
$fn$;

revoke execute on function public.user_roles_shorten_sessions() from public, anon, authenticated;

drop trigger if exists user_roles_shorten_sessions on public.user_roles;
create trigger user_roles_shorten_sessions
  after insert or update of role, user_id or delete on public.user_roles
  for each row execute function public.user_roles_shorten_sessions();

-- Recreating the trigger resets it to ENABLE ORIGIN; restores run in replica
-- mode (233), so it must fire ALWAYS.
alter table public.user_roles enable always trigger user_roles_shorten_sessions;
