-- 298_functions_notifications_logs_cron.sql
-- T037: function audit — Gmail guard, log retention, cron, expiry reminders, WhatsApp.
-- Split from 283_functions_notifications_reports.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

/** يضمن عدم تغيير مزود رسائل Gmail بعد الإدخال. */
create or replace function public.tg_gmail_messages_provider_immutable()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.provider is distinct from old.provider then
    raise exception 'gmail_messages.provider is immutable (attempted % -> %)', old.provider, new.provider
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

/** يحذف سجلات التدقيق أو الإشعارات الأقدم من المدة المحددة للشركة الحالية فقط. */
create or replace function public.purge_log(p_log text, p_days integer)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_cutoff timestamptz := now() - make_interval(days => p_days);
  v_deleted integer := 0;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 then
    raise exception 'Retention days must be positive' using errcode = '22023';
  end if;

  if p_log = 'audit' then
    delete from public.audit_logs
     where company_id = v_company_id and created_at < v_cutoff;
  elsif p_log = 'notifications' then
    delete from public.notifications
     where company_id = v_company_id and created_at < v_cutoff and state <> 'queued';
  else
    raise exception 'Unknown log %', p_log using errcode = '22023';
  end if;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

/** ينفذ التنظيف الدوري لسجلات التدقيق والإشعارات وفق سياسة الاحتفاظ الخاصة بالشركة الحالية. */
create or replace function public.purge_expired_logs()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_audit_days integer;
  v_notification_days integer;
  v_audit integer := 0;
  v_notifications integer := 0;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select c.audit_log_retention_days, c.notification_log_retention_days
    into v_audit_days, v_notification_days
    from public.companies c
   where c.id = v_company_id;

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
        jsonb_build_object('log', 'notifications', 'days', v_notification_days, 'deleted', v_notifications));
    end if;
  end if;

  return jsonb_build_object(
    'audit', jsonb_build_object('days', v_audit_days, 'deleted', v_audit),
    'notifications', jsonb_build_object('days', v_notification_days, 'deleted', v_notifications));
end;
$$;

/** يحدّث مدة الاحتفاظ بالسجلات للشركة الحالية وينفذ الحذف الفوري للسجلات المنتهية. */
create or replace function public.set_log_retention(p_log text, p_days integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_before integer;
  v_deleted integer := 0;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  if p_log = 'audit' then
    if auth.role() = 'authenticated' then
      if not public.has_role(auth.uid(), 'admin') then
        raise exception 'Only an admin can change audit log retention' using errcode = '42501';
      end if;
    elsif auth.role() not in ('company_service', 'service_role') then
      raise exception 'Only an admin can change audit log retention' using errcode = '42501';
    end if;
    if p_days is not null and p_days not in (7, 14, 21, 28) then
      raise exception 'Audit retention must be 7, 14, 21 or 28 days' using errcode = '22023';
    end if;
  elsif p_log = 'notifications' then
    if auth.role() = 'authenticated' then
      if not public.has_permission(auth.uid(), 'notifications.delete') then
        raise exception 'Missing permission notifications.delete' using errcode = '42501';
      end if;
    elsif auth.role() not in ('company_service', 'service_role') then
      raise exception 'Missing permission notifications.delete' using errcode = '42501';
    end if;
    if p_days is not null and p_days not in (7, 14, 21, 28, 30) then
      raise exception 'Notification retention must be 7, 14, 21, 28 or 30 days' using errcode = '22023';
    end if;
  else
    raise exception 'Unknown log %', p_log using errcode = '22023';
  end if;

  select case when p_log = 'audit' then c.audit_log_retention_days else c.notification_log_retention_days end
    into v_before
    from public.companies c
   where c.id = v_company_id
   for update;
  if not found then
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
$$;

/** يحجز نافذة تنفيذ لمهمة مجدولة ضمن سجل المهام الخاص بالشركة الحالية لمنع التداخل. */
create or replace function public.claim_cron_run(p_key text, p_window_seconds integer default 60)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_claimed boolean;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  with claimed as (
    update public.cron_jobs
       set last_claimed_at = now()
     where company_id = v_company_id
       and key = p_key
       and (last_claimed_at is null or last_claimed_at < now() - make_interval(secs => p_window_seconds))
    returning 1
  )
  select exists (select 1 from claimed)
      or not exists (select 1 from public.cron_jobs where company_id = v_company_id and key = p_key)
    into v_claimed;

  return v_claimed;
end;
$$;

/** يسجّل نتيجة آخر تشغيل لمهمة مجدولة في سجل الشركة الحالية. */
create or replace function public.record_cron_run(
  _key text,
  _status text,
  _duration_ms integer default null,
  _error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  update public.cron_jobs
     set last_run_at = now(),
         last_status = _status,
         last_duration_ms = _duration_ms,
         last_error = _error
   where company_id = v_company_id
     and key = _key;
end;
$$;

/** يحدد العقود النشطة المستحقة لتنبيهات انتهاء العقد ضمن نطاق الشركة الحالية. */
create or replace function public.identify_contract_expiry_reminders(p_as_of date default null)
returns table(contract_id uuid, tenant_id uuid, days_until integer, milestone text, template_type text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_as_of date := coalesce(p_as_of, current_date);
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'notifications.create') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  select b.contract_id, b.tenant_id, b.days_until, b.milestone, 'contract_expiry'::text
    from (
      select c.id as contract_id,
             c.tenant_id,
             (c.end_date - v_as_of)::int as days_until,
             case
               when (c.end_date - v_as_of) < 0   then null
               when (c.end_date - v_as_of) <= 1  then '1d'
               when (c.end_date - v_as_of) <= 7  then '7d'
               when (c.end_date - v_as_of) <= 30 then '30d'
               when (c.end_date - v_as_of) <= 60 then '60d'
               when (c.end_date - v_as_of) <= 90 then '90d'
               when (c.end_date - v_as_of) <= 120 then '120d'
               when (c.end_date - v_as_of) <= 150 then '150d'
               when (c.end_date - v_as_of) <= 180 then '180d'
               else null
             end as milestone
        from public.contracts c
        join public.tenants t on t.company_id = v_company_id and t.id = c.tenant_id
       where c.company_id = v_company_id
         and c.state = 'active'
         and c.archived_at is null
    ) b
   where b.milestone is not null
   order by b.days_until, b.contract_id;
end;
$$;

/** يستقبل رسائل واتساب ويحدّث المحادثات وجهات الاتصال بمعرفات مركبة معزولة للشركة الحالية. */
create or replace function public.ingest_whatsapp_messages(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  r jsonb;
  inserted_id uuid;
  inserted_count integer := 0;
  v_sent_at timestamptz;
  v_from_me boolean;
  v_count_unread boolean;
  v_preview text;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_sent_at := coalesce((r->>'sent_at')::timestamptz, now());
    v_from_me := coalesce((r->>'from_me')::boolean, false);
    v_count_unread := coalesce((r->>'count_unread')::boolean, true) and not v_from_me;

    insert into public.whatsapp_messages
      (company_id, message_id, chat_number, direction, from_me, body, message_type,
       media_type, media_id, media_filename, sent_at, raw)
    values
      (v_company_id, r->>'message_id', r->>'chat_number', r->>'direction', v_from_me, r->>'body',
       coalesce(r->>'message_type', 'text'), r->>'media_type', r->>'media_id', r->>'media_filename',
       v_sent_at, r->'raw')
    on conflict (company_id, message_id) do nothing
    returning id into inserted_id;

    if inserted_id is null then
      continue;
    end if;
    inserted_count := inserted_count + 1;

    v_preview := coalesce(nullif(trim(r->>'body'), ''), '[' || coalesce(r->>'media_type', r->>'message_type', 'message') || ']');

    insert into public.whatsapp_chats
      (company_id, chat_number, display_name, last_message_preview, last_message_at, unread_count)
    values
      (v_company_id, r->>'chat_number', nullif(trim(r->>'push_name'), ''), v_preview, v_sent_at,
       case when v_count_unread then 1 else 0 end)
    on conflict (company_id, chat_number) do update
      set last_message_preview = case
            when excluded.last_message_at >= coalesce(whatsapp_chats.last_message_at, 'epoch'::timestamptz)
            then excluded.last_message_preview else whatsapp_chats.last_message_preview end,
          last_message_at = greatest(coalesce(whatsapp_chats.last_message_at, 'epoch'::timestamptz), excluded.last_message_at),
          display_name = coalesce(whatsapp_chats.display_name, excluded.display_name),
          unread_count = whatsapp_chats.unread_count + case when v_count_unread then 1 else 0 end,
          updated_at = now();

    insert into public.whatsapp_contacts (company_id, phone, name)
    values (v_company_id, r->>'chat_number', nullif(trim(r->>'push_name'), ''))
    on conflict (company_id, phone) do update
      set name = coalesce(whatsapp_contacts.name, excluded.name),
          updated_at = now();
  end loop;

  return inserted_count;
end;
$$;

/** يعرض ملخص صحة اتصال واتساب للجلسة الحالية للشركة مع التحقق من الصلاحية أو دور الخدمة. */
create or replace function public.whatsapp_session_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
begin
  if v_company_id is null then
    return null;
  end if;
  if auth.role() not in ('company_service', 'service_role')
     and not (select public.is_staff((select auth.uid()))) then
    return null;
  end if;

  return jsonb_build_object(
    'enabled', coalesce(
      (select pc.is_enabled from public.provider_configs pc
        where pc.company_id = v_company_id and pc.provider = 'evolution_api' limit 1), false),
    'paired', coalesce(
      (select ec.connected_number is not null or ec.connected_at is not null
         from public.evolution_connections ec where ec.company_id = v_company_id and ec.id = 1), false),
    'state', (select ec.last_connection_state from public.evolution_connections ec
               where ec.company_id = v_company_id and ec.id = 1),
    'settling', coalesce(
      (select ec.last_connection_state = 'connecting' and ec.disconnected_at > now() - interval '60 seconds'
         from public.evolution_connections ec where ec.company_id = v_company_id and ec.id = 1), false),
    'disconnected_at', (select ec.disconnected_at from public.evolution_connections ec
                         where ec.company_id = v_company_id and ec.id = 1),
    'parked_count', (select count(*)::int from public.notifications n
                      where n.company_id = v_company_id
                        and n.error_code in ('session_disconnected', 'instance_missing')
                        and n.state in ('failed', 'needs_review'))
  );
end;
$$;


revoke all on function public.purge_log(text, integer) from public, anon, authenticated;
revoke all on function public.purge_expired_logs() from public, anon, authenticated;
revoke all on function public.claim_cron_run(text, integer) from public, anon, authenticated;
revoke all on function public.record_cron_run(text, text, integer, text) from public, anon, authenticated;
revoke all on function public.ingest_whatsapp_messages(jsonb) from public, anon, authenticated;
grant execute on function public.purge_log(text, integer) to company_service, service_role;
grant execute on function public.purge_expired_logs() to company_service, service_role;
grant execute on function public.claim_cron_run(text, integer) to company_service, service_role;
grant execute on function public.record_cron_run(text, text, integer, text) to company_service, service_role;
grant execute on function public.ingest_whatsapp_messages(jsonb) to company_service, service_role;
revoke all on function public.set_log_retention(text, integer) from public, anon;
revoke all on function public.identify_contract_expiry_reminders(date) from public, anon;
revoke all on function public.whatsapp_session_health() from public, anon;
grant execute on function public.set_log_retention(text, integer) to authenticated, company_service, service_role;
grant execute on function public.identify_contract_expiry_reminders(date) to authenticated, company_service, service_role;
grant execute on function public.whatsapp_session_health() to authenticated, company_service, service_role;
