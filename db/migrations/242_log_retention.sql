-- 242_log_retention.sql
--
-- Automatic retention for the two log tables an admin reads but never edits:
-- audit_logs (/admin/audit) and notifications (/admin/settings/notifications).
-- Spec: docs/specs/log-retention-and-audit-filters.md.
--
-- Off by default (null). Nothing is deleted until an admin picks a window in
-- the UI: audit_logs is deliberately preserved by erase_all_data (45) and by
-- restore (146), so losing it must be a conscious choice, not a side effect of
-- applying a migration.

------------------------------------------------------------
-- 1. Settings on companies (single-company deployment, like the backup switches)
------------------------------------------------------------

alter table public.companies
  add column if not exists audit_log_retention_days integer,
  add column if not exists notification_log_retention_days integer;

alter table public.companies drop constraint if exists companies_audit_log_retention_days_check;
alter table public.companies
  add constraint companies_audit_log_retention_days_check
  check (audit_log_retention_days is null or audit_log_retention_days in (7, 14, 21, 28));

alter table public.companies drop constraint if exists companies_notification_log_retention_days_check;
alter table public.companies
  add constraint companies_notification_log_retention_days_check
  check (notification_log_retention_days is null
         or notification_log_retention_days in (7, 14, 21, 28, 30));

comment on column public.companies.audit_log_retention_days is
  'Days of audit_logs kept by the log-retention job; null keeps everything. Change only through set_log_retention.';
comment on column public.companies.notification_log_retention_days is
  'Days of notifications kept by the log-retention job; null keeps everything. Change only through set_log_retention.';

------------------------------------------------------------
-- 2. Guard: the columns move only through set_log_retention
------------------------------------------------------------

/**
 * يمنع تغيير مدة الاحتفاظ بالسجلات بتحديث مباشر لجدول الشركات.
 *
 * companies is writable by anyone holding company.update, which is broader than
 * the admin-only right to shorten the audit trail. Without this guard such a
 * user could set the column through the generic company form and let the
 * nightly job do the deleting. Same GUC pattern as option_list_items (239).
 */
create or replace function public.companies_guard_log_retention()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if (new.audit_log_retention_days is distinct from old.audit_log_retention_days
      or new.notification_log_retention_days is distinct from old.notification_log_retention_days)
     and coalesce(current_setting('app.log_retention_update', true), '') <> 'on' then
    raise exception 'Change log retention through set_log_retention'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists companies_guard_log_retention on public.companies;
create trigger companies_guard_log_retention
  before update on public.companies
  for each row execute function public.companies_guard_log_retention();

------------------------------------------------------------
-- 3. Deletion core
------------------------------------------------------------

/**
 * يحذف من السجل المحدد كل ما هو أقدم من عدد الأيام المعطى، ويرجع عدد المحذوف.
 *
 * Internal: no grant. Called only from the two SECURITY DEFINER entry points
 * below, which do the permission checks. Queued notifications are never
 * deleted, whatever their age — they are work still to be done, not a log.
 * email_webhook_events.notification_id is `on delete set null` (156), so
 * delivery events outlive the notification they describe.
 */
create or replace function public.purge_log(p_log text, p_days integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_cutoff timestamptz := now() - make_interval(days => p_days);
  v_deleted integer := 0;
begin
  if p_days is null or p_days < 1 then
    raise exception 'Retention days must be positive' using errcode = '22023';
  end if;

  if p_log = 'audit' then
    delete from public.audit_logs where created_at < v_cutoff;
  elsif p_log = 'notifications' then
    delete from public.notifications
     where created_at < v_cutoff
       and state <> 'queued';
  else
    raise exception 'Unknown log %', p_log using errcode = '22023';
  end if;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

revoke all on function public.purge_log(text, integer) from public, anon, authenticated;

------------------------------------------------------------
-- 4. Admin entry point: save the window and apply it now
------------------------------------------------------------

/**
 * يحفظ مدة الاحتفاظ بسجل (التدقيق أو الإشعارات) ثم يحذف فوراً ما هو أقدم منها.
 *
 * p_days null switches retention off and deletes nothing. The audit trail is
 * admin-only: it is forensic evidence, and audit.read is a reading right, not
 * a right to destroy. Notifications need notifications.delete, the same right
 * the row-by-row delete button uses. Both the setting change and the purge are
 * audited, so the deletion itself is never what goes missing.
 */
create or replace function public.set_log_retention(p_log text, p_days integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_company_id uuid;
  v_before integer;
  v_deleted integer := 0;
begin
  if p_log = 'audit' then
    if not public.has_role(auth.uid(), 'admin') then
      raise exception 'Only an admin can change audit log retention' using errcode = '42501';
    end if;
    if p_days is not null and p_days not in (7, 14, 21, 28) then
      raise exception 'Audit retention must be 7, 14, 21 or 28 days' using errcode = '22023';
    end if;
  elsif p_log = 'notifications' then
    if not public.has_permission(auth.uid(), 'notifications.delete') then
      raise exception 'Missing permission notifications.delete' using errcode = '42501';
    end if;
    if p_days is not null and p_days not in (7, 14, 21, 28, 30) then
      raise exception 'Notification retention must be 7, 14, 21, 28 or 30 days' using errcode = '22023';
    end if;
  else
    raise exception 'Unknown log %', p_log using errcode = '22023';
  end if;

  select id,
         case when p_log = 'audit' then audit_log_retention_days
              else notification_log_retention_days end
    into v_company_id, v_before
    from public.companies
   order by created_at asc
   limit 1
   for update;
  if v_company_id is null then
    raise exception 'Company settings not found' using errcode = 'P0002';
  end if;

  perform set_config('app.log_retention_update', 'on', true);
  if p_log = 'audit' then
    update public.companies set audit_log_retention_days = p_days where id = v_company_id;
  else
    update public.companies set notification_log_retention_days = p_days where id = v_company_id;
  end if;
  perform set_config('app.log_retention_update', '', true);

  if p_days is not null then
    v_deleted := public.purge_log(p_log, p_days);
  end if;

  perform public.write_audit(
    'log_retention.update', 'company', v_company_id,
    jsonb_build_object('log', p_log, 'days', v_before),
    jsonb_build_object('log', p_log, 'days', p_days, 'deleted', v_deleted));

  return jsonb_build_object('log', p_log, 'days', p_days, 'deleted', v_deleted);
end;
$fn$;

revoke all on function public.set_log_retention(text, integer) from public, anon;
grant execute on function public.set_log_retention(text, integer) to authenticated, service_role;

------------------------------------------------------------
-- 5. Cron entry point
------------------------------------------------------------

/**
 * يطبّق إعدادي الاحتفاظ على السجلين — تستدعيها مهمة log-retention اليومية.
 *
 * Idempotent: a second run on the same day finds nothing older than the cutoff
 * beyond what arrived in between. A purge that deleted rows writes one audit
 * row; an empty one writes none, so a quiet night adds nothing to the log.
 */
create or replace function public.purge_expired_logs()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_audit_days integer;
  v_notification_days integer;
  v_audit integer := 0;
  v_notifications integer := 0;
begin
  select audit_log_retention_days, notification_log_retention_days
    into v_audit_days, v_notification_days
    from public.companies
   order by created_at asc
   limit 1;

  if v_audit_days is not null then
    v_audit := public.purge_log('audit', v_audit_days);
    if v_audit > 0 then
      perform public.write_audit(
        'log_retention.purge', 'audit_log', null, null,
        jsonb_build_object('log', 'audit', 'days', v_audit_days, 'deleted', v_audit));
    end if;
  end if;

  if v_notification_days is not null then
    v_notifications := public.purge_log('notifications', v_notification_days);
    if v_notifications > 0 then
      perform public.write_audit(
        'log_retention.purge', 'notification', null, null,
        jsonb_build_object('log', 'notifications', 'days', v_notification_days,
                           'deleted', v_notifications));
    end if;
  end if;

  return jsonb_build_object(
    'audit', jsonb_build_object('days', v_audit_days, 'deleted', v_audit),
    'notifications', jsonb_build_object('days', v_notification_days, 'deleted', v_notifications));
end;
$fn$;

revoke all on function public.purge_expired_logs() from public, anon, authenticated;
grant execute on function public.purge_expired_logs() to service_role;

------------------------------------------------------------
-- 6. Distinct values for the /admin/audit filter dropdowns
------------------------------------------------------------

/**
 * يرجع القيم الموجودة فعلاً في سجل التدقيق لتعبئة قوائم الفلاتر.
 *
 * SECURITY INVOKER on purpose: it reads through the caller's RLS, so a user
 * who cannot see audit_logs gets empty lists rather than a leak of who did
 * what. Actors are keyed by actor_id; the label is the most recent non-null one,
 * so a renamed user keeps one entry instead of two.
 */
create or replace function public.audit_log_filter_options()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object(
    'actors', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.actor_id, 'label', a.actor_label)
                       order by a.actor_label)
        from (
          select distinct on (actor_id) actor_id, actor_label
            from public.audit_logs
           where actor_id is not null
           order by actor_id, (actor_label is null), created_at desc
        ) a
    ), '[]'::jsonb),
    'roles', coalesce((
      select jsonb_agg(r.role order by r.role)
        from (select distinct role from public.audit_logs where role is not null) r
    ), '[]'::jsonb),
    'actions', coalesce((
      select jsonb_agg(x.action order by x.action)
        from (select distinct action from public.audit_logs) x
    ), '[]'::jsonb),
    'entity_types', coalesce((
      select jsonb_agg(e.entity_type order by e.entity_type)
        from (select distinct entity_type from public.audit_logs
               where entity_type is not null) e
    ), '[]'::jsonb)
  );
$fn$;

revoke all on function public.audit_log_filter_options() from public, anon;
grant execute on function public.audit_log_filter_options() to authenticated, service_role;

------------------------------------------------------------
-- 7. Register the scheduled job
------------------------------------------------------------

insert into public.cron_jobs (key, kind, name_ar, name_en, description_ar, description_en)
values
  ('log-retention', 'scheduled',
   'الحذف التلقائي للسجلات', 'Log retention',
   'يحذف يومياً سجلات التدقيق والإشعارات الأقدم من المدة المختارة.',
   'Deletes audit and notification log rows older than the chosen window, daily.')
on conflict (key) do update
  set kind = excluded.kind,
      name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      description_ar = excluded.description_ar,
      description_en = excluded.description_en;
