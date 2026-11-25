-- 231_session_lifetime_by_role.sql
--
-- Staff sessions end 6 hours after sign-in; tenant portal sessions last
-- 6 months. Before this, no session ever ended: GOTRUE_JWT_EXP is 3600 and
-- neither GOTRUE_SESSIONS_TIMEBOX nor _INACTIVITY_TIMEOUT is set, so a refresh
-- token was good forever.
--
-- Why a trigger and not GoTrue config: the timebox settings are global, and one
-- value cannot give an admin 6 hours and a tenant 6 months. GoTrue (v2.189)
-- does honour a per-row `auth.sessions.not_after` — RefreshTokenGrant runs
-- Session.CheckValidity and refuses with "Session Expired" once now() passes
-- it — but never sets that column itself. So the database sets it at insert.
--
-- The limit bites at the first refresh after not_after. GoTrue neither clamps
-- an access token's `exp` to not_after nor checks not_after on ordinary
-- requests, so with JWT_EXP=3600 a staff session actually ends between 6h and
-- 7h. Lowering GOTRUE_JWT_EXP narrows that window; it is a Dokploy env change,
-- not part of this migration.
--
-- auth.sessions is created by GoTrue's own migrations, which the SQL test image
-- never runs, so the trigger is attached only where the table exists. The role
-- rule lives in session_lifetime_for() so the suite can still test it.

/**
 * يحدد مدة صلاحية جلسة الدخول حسب دور المستخدم: ٦ ساعات للموظفين و٦ أشهر للمستأجرين.
 *
 * Reads user_roles directly rather than is_staff(): is_staff also requires an
 * active profile, and a deactivated staff account must not fall through to the
 * 6-month tenant window. Any non-tenant role wins, so an account holding both
 * gets the stricter box. An account with no role gets the staff box too —
 * nobody without a tenant role should hold a long-lived portal session.
 */
create or replace function public.session_lifetime_for(_user_id uuid)
returns interval
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case
    when exists (
      select 1 from public.user_roles ur
       where ur.user_id = _user_id and ur.role = 'tenant'
    ) and not exists (
      select 1 from public.user_roles ur
       where ur.user_id = _user_id and ur.role <> 'tenant'
    )
    then interval '6 months'
    else interval '6 hours'
  end;
$fn$;

revoke execute on function public.session_lifetime_for(uuid) from public, anon, authenticated;
grant execute on function public.session_lifetime_for(uuid) to service_role;

/**
 * يضبط موعد انتهاء الجلسة الجديدة عند إنشائها وفق دور صاحبها.
 *
 * SECURITY DEFINER because GoTrue inserts as supabase_auth_admin, which cannot
 * read public.user_roles. INSERT only: a refresh UPDATEs the row and must not
 * move the deadline. least() keeps any earlier deadline GoTrue itself set.
 */
create or replace function public.auth_sessions_set_not_after()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  deadline timestamptz :=
    coalesce(new.created_at, now()) + public.session_lifetime_for(new.user_id);
begin
  new.not_after := least(coalesce(new.not_after, deadline), deadline);
  return new;
end;
$fn$;

revoke execute on function public.auth_sessions_set_not_after() from public, anon, authenticated;

do $do$
begin
  if to_regclass('auth.sessions') is null then
    raise notice 'auth.sessions absent (no GoTrue here); session lifetime trigger not attached';
    return;
  end if;

  execute 'drop trigger if exists auth_sessions_set_not_after on auth.sessions';
  execute 'create trigger auth_sessions_set_not_after
             before insert on auth.sessions
             for each row execute function public.auth_sessions_set_not_after()';

  -- Sessions that already exist. Staff get one fresh 6-hour window from now
  -- rather than created_at + 6h, which would sign every admin out — mid-task —
  -- at their next refresh. Tenants keep their sign-in date + 6 months.
  execute $sql$
    update auth.sessions s
       set not_after = greatest(
             s.created_at + public.session_lifetime_for(s.user_id),
             now() + interval '6 hours')
     where s.not_after is null
  $sql$;
end;
$do$;
