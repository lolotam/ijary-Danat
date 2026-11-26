-- T037: تدقيق دوال الإشعارات والتذكير والتقارير والملخصات والنسخ الاحتياطي والواتساب
-- Binds all definer functions to public.current_company_id(), converts pure triggers to
-- SECURITY INVOKER, accepts company_service where staff/permission checks apply, and removes
-- every oldest-company lookup (from companies ... limit 1).

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

/** يصدّر نسخة احتياطية كاملة لبيانات الشركة الحالية فقط مع البصمة الهيكلية. */
create or replace function public.backup_dump_all()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  _tables jsonb := '[]'::jsonb;
  _tbl text;
  _rows jsonb;
  _payload jsonb;
  _has_company_col boolean;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  for _tbl in select backup_table_names from public.backup_table_names() loop
    if _tbl = 'companies' then
      execute 'select coalesce(jsonb_agg(t), ''[]''::jsonb) from public.companies t where t.id = $1'
        into _rows using v_company_id;
    else
      select exists (
        select 1 from information_schema.columns c
         where c.table_schema = 'public' and c.table_name = _tbl and c.column_name = 'company_id'
      ) into _has_company_col;

      if _has_company_col then
        execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from public.%I t where t.company_id = $1', _tbl)
          into _rows using v_company_id;
      else
        _rows := '[]'::jsonb;
      end if;
    end if;
    _tables := _tables || jsonb_build_object('name', _tbl, 'rows', _rows);
  end loop;

  _payload := jsonb_build_object(
    'format_version', 1,
    'schema_fingerprint', public.backup_schema_fingerprint(),
    'captured_at', statement_timestamp(),
    'tables', _tables
  );

  if pg_column_size(_payload) > 268435456 then
    raise exception 'Backup payload exceeds 256MB ceiling';
  end if;
  return _payload;
end;
$$;

/** يستعيد بيانات النسخة الاحتياطية للشركة الحالية مع التحقق من المفاتيح المركبة وعزل الشركات الأخرى. */
create or replace function public.backup_restore(_payload jsonb, _actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  _table text;
  _tables_arr jsonb := _payload->'tables';
  _tbl_obj jsonb;
  _row_data jsonb;
  _manifest_count int;
  _inserted_count int;
  _deleted_count int;
  _skipped_count int;
  _nulled_count int;
  _cols text;
  _report_tables jsonb := '[]'::jsonb;
  _skipped_by_table jsonb := '{}'::jsonb;
  _orphan_logins int := 0;
  _fk_record record;
  _profiles_rows jsonb;
  _missing text;
  _extra text;
  _duplicate text;
  _report jsonb;
  _current_actor_profile public.profiles;
  _has_company_col boolean;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if (_payload->>'format_version') is distinct from '1' then
    raise exception 'Unsupported format_version %', _payload->>'format_version';
  end if;

  select string_agg(name, ', ') into _duplicate
    from (select obj->>'name' as name, count(*) as cnt from jsonb_array_elements(_tables_arr) obj group by obj->>'name') t
   where cnt > 1;
  if _duplicate is not null then
    raise exception 'Payload contains duplicate entries for tables: %', _duplicate;
  end if;

  select string_agg(e.table_name, ', ') into _missing
    from public.backup_table_names() e(table_name)
   where not exists (select 1 from jsonb_array_elements(_tables_arr) obj where obj->>'name' = e.table_name);
  if _missing is not null then
    raise exception 'Payload is missing tables: %', _missing;
  end if;

  select string_agg(obj->>'name', ', ') into _extra
    from jsonb_array_elements(_tables_arr) obj
   where not exists (select 1 from public.backup_table_names() e(table_name) where e.table_name = obj->>'name');
  if _extra is not null then
    raise exception 'Payload contains unexpected tables: %', _extra;
  end if;

  for _table in select backup_table_names from public.backup_table_names() order by backup_table_names loop
    execute format('lock table %I in access exclusive mode', _table);
  end loop;

  if (_payload->>'schema_fingerprint') is distinct from public.backup_schema_fingerprint() then
    raise exception 'Schema drift detected. The archive schema does not match the current database.';
  end if;

  set local session_replication_role = replica;

  if _actor is not null then
    select * into _current_actor_profile from public.profiles where id = _actor and company_id = v_company_id;
  end if;

  for _tbl_obj in select * from jsonb_array_elements(_tables_arr) loop
    _table := _tbl_obj->>'name';
    _manifest_count := jsonb_array_length(_tbl_obj->'rows');

    select exists (
      select 1 from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = _table and c.column_name = 'company_id'
    ) into _has_company_col;

    if _has_company_col
       and exists (select 1 from public.backup_table_names() where backup_table_names = _table)
       and not exists (select 1 from public.backup_protected_tables() where backup_protected_tables = _table)
    then
      _row_data := _tbl_obj->'rows';
      if exists (
        select 1 from jsonb_array_elements(_row_data) r
         where nullif(r->>'company_id', '') is distinct from v_company_id::text
      ) then
        raise exception 'CROSS_COMPANY_BACKUP_ROW in table %', _table using errcode = '42501';
      end if;

      execute format('delete from public.%I where company_id = $1', _table) using v_company_id;
      get diagnostics _deleted_count = ROW_COUNT;
      _skipped_count := 0;
      _nulled_count := 0;

      for _fk_record in (
        select a.attname as col_name, c.confdeltype, a.attnotnull
          from pg_constraint c
          join pg_attribute a on a.attnum = any(c.conkey) and a.attrelid = c.conrelid
         where c.conrelid = _table::regclass and c.confrelid = 'auth.users'::regclass and c.contype = 'f'
      ) loop
        declare
          _will_null int := 0;
          _will_skip int := 0;
        begin
          if _fk_record.confdeltype = 'n' and not _fk_record.attnotnull then
            select count(*) into _will_null from jsonb_array_elements(_row_data) r
             where (r->>_fk_record.col_name) is not null
               and not exists (select 1 from auth.users u where u.id::text = (r->>_fk_record.col_name));
            _nulled_count := _nulled_count + _will_null;
            _row_data := (
              select coalesce(jsonb_agg(
                case when (r->>_fk_record.col_name) is not null
                          and not exists (select 1 from auth.users u where u.id::text = (r->>_fk_record.col_name))
                     then jsonb_set(r, array[_fk_record.col_name], 'null'::jsonb) else r end
              ), '[]'::jsonb) from jsonb_array_elements(_row_data) r
            );
          else
            select count(*) into _will_skip from jsonb_array_elements(_row_data) r
             where (r->>_fk_record.col_name) is not null
               and not exists (select 1 from auth.users u where u.id::text = (r->>_fk_record.col_name));
            _skipped_count := _skipped_count + _will_skip;
            _row_data := (
              select coalesce(jsonb_agg(r), '[]'::jsonb) from jsonb_array_elements(_row_data) r
               where (r->>_fk_record.col_name) is null
                  or exists (select 1 from auth.users u where u.id::text = (r->>_fk_record.col_name))
            );
          end if;
        end;
      end loop;

      select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into _cols
        from information_schema.columns
       where table_schema = 'public' and table_name = _table and is_generated <> 'ALWAYS';

      _inserted_count := 0;
      if coalesce(_cols, '') <> '' and jsonb_array_length(_row_data) > 0 then
        execute format(
          'insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1)',
          _table, _cols, _cols, _table
        ) using _row_data;
        get diagnostics _inserted_count = ROW_COUNT;
      end if;

      if _inserted_count <> (_manifest_count - _skipped_count) then
        raise exception 'Restore mismatch for %: expected % rows, inserted %.',
          _table, (_manifest_count - _skipped_count), _inserted_count;
      end if;

      _report_tables := _report_tables || jsonb_build_object(
        'name', _table, 'deleted', _deleted_count, 'inserted', _inserted_count,
        'skipped', _skipped_count, 'nulled', _nulled_count);
      if _skipped_count > 0 then
        _skipped_by_table := jsonb_set(_skipped_by_table, array[_table], to_jsonb(_skipped_count));
      end if;
    end if;
  end loop;

  -- فحص اليتامى لجميع قيود المفاتيح الأجنبية البسيطة والمركبة ضمن نطاق الشركة الحالية.
  for _fk_record in (
    select c.conname,
           n1.nspname as child_schema, t1.relname as child_table,
           n2.nspname as parent_schema, t2.relname as parent_table,
           (select array_agg(a.attname order by ord) from unnest(c.conkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as child_cols,
           (select array_agg(a.attname order by ord) from unnest(c.confkey) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as parent_cols
      from pg_constraint c
      join pg_class t1 on c.conrelid = t1.oid join pg_namespace n1 on t1.relnamespace = n1.oid
      join pg_class t2 on c.confrelid = t2.oid join pg_namespace n2 on t2.relnamespace = n2.oid
     where c.contype = 'f' and n1.nspname = 'public'
       and exists (select 1 from pg_attribute ac where ac.attrelid = t1.oid and ac.attname = 'company_id' and not ac.attisdropped)
       and t1.relname in (select backup_table_names from public.backup_table_names()
                          except select backup_protected_tables from public.backup_protected_tables())
  ) loop
    declare
      _not_null_cond text;
      _join_cond text;
      _orphan_count int;
    begin
      select string_agg(format('c.%I is not null', cc), ' and '),
             string_agg(format('p.%I = c.%I', pc, cc), ' and ')
        into _not_null_cond, _join_cond
        from unnest(_fk_record.child_cols, _fk_record.parent_cols) as cols(cc, pc);

      execute format(
        'select count(*) from %I.%I c where c.company_id = $1 and (%s) and not exists (select 1 from %I.%I p where %s)',
        _fk_record.child_schema, _fk_record.child_table, _not_null_cond,
        _fk_record.parent_schema, _fk_record.parent_table, _join_cond
      ) into _orphan_count using v_company_id;

      if _orphan_count > 0 then
        raise exception 'Restore leaves % dangling references in constraint % on table %',
          _orphan_count, _fk_record.conname, _fk_record.child_table;
      end if;
    end;
  end loop;

  if _actor is not null then
    if _current_actor_profile.id is not null then
      delete from public.profiles where id = _actor and company_id = v_company_id;
      insert into public.profiles select _current_actor_profile.*;
    elsif not exists (select 1 from public.profiles where id = _actor) then
      insert into public.profiles (id, company_id, username, display_name, email)
      select id, v_company_id, raw_user_meta_data->>'username', raw_user_meta_data->>'name', email
        from auth.users where id = _actor;
    end if;
    if not exists (select 1 from public.user_roles where user_id = _actor and company_id = v_company_id and role = 'admin') then
      insert into public.user_roles (company_id, user_id, role) values (v_company_id, _actor, 'admin');
    end if;
  end if;

  select obj->'rows' into _profiles_rows from jsonb_array_elements(_tables_arr) obj where obj->>'name' = 'profiles';
  if coalesce(jsonb_array_length(_profiles_rows), 0) > 0 then
    select count(*) into _orphan_logins from auth.users u
     where not exists (select 1 from jsonb_array_elements(_profiles_rows) r where (r->>'id') = u.id::text);
  end if;

  _report := jsonb_build_object(
    'tables', _report_tables, 'skipped_by_table', _skipped_by_table,
    'orphan_logins', _orphan_logins, 'actor', _actor, 'restored_at', statement_timestamp());

  perform public.write_audit(
    'backup.restore', 'backup',
    case when (_payload->>'archive_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
         then (_payload->>'archive_id')::uuid else null end,
    null, _report, 'success', null);

  return _report;
end;
$$;

-- erase_all_data(): removed (T050). A company-panel "wipe everything" RPC is a
-- one-call data-loss path for any staff account; the platform owner suspends
-- companies instead and never deletes them from the UI.
drop function if exists public.erase_all_data();

/** يبني تقرير العقود المتأخرة بصيغة HTML ضمن نطاق الشركة الحالية فقط. */
create or replace function public.build_overdue_contracts_report_html(p_schedule_id uuid, p_as_of date default null)
returns table(html text, period_start date, period_end date)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_schedule public.report_schedules%rowtype;
  v_company public.companies%rowtype;
  v_end date := coalesce(p_as_of, current_date);
  v_start date;
  v_is_ar boolean;
  v_dir text;
  v_rows text := '';
  v_count integer := 0;
  v_total numeric(14,3) := 0;
  v_title text;
  v_company_name text;
  r record;
  c_on text := '#0b1c30'; c_muted text := '#434655'; c_outline text := '#c3c6d7';
  c_primary text := '#004ac6'; c_red text := '#EF4444'; c_bg text := '#f8f9ff';
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'reports.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select * into v_schedule from public.report_schedules where id = p_schedule_id and company_id = v_company_id;
  if not found then raise exception 'Report schedule not found'; end if;
  v_is_ar := v_schedule.locale = 'ar';
  v_dir := case when v_is_ar then 'rtl' else 'ltr' end;
  select * into v_company from public.companies where id = v_company_id;
  v_company_name := coalesce(
    case when v_is_ar then v_company.name_ar else coalesce(v_company.name_en, v_company.name_ar) end,
    case when v_is_ar then 'دانة المستقبل العقارية' else 'Danat Al Mustaqbal Real Estate' end);
  v_title := coalesce(case when v_is_ar then v_schedule.name_ar else v_schedule.name_en end, v_schedule.name_ar);

  v_start := case v_schedule.frequency
    when 'daily' then v_end
    when 'weekly' then v_end - 6
    when 'monthly' then date_trunc('month', v_end)::date
    when 'yearly' then date_trunc('year', v_end)::date
  end;

  for r in
    with per_contract as (
      select i.contract_id,
             count(distinct (i.period_year, i.period_month)) as months,
             min(i.period_year * 100 + i.period_month) as first_ym,
             max(i.period_year * 100 + i.period_month) as last_ym,
             sum(i.balance) as total
        from public.invoices i
        join public.contracts c on c.company_id = v_company_id and c.id = i.contract_id
       where i.company_id = v_company_id and i.state = 'overdue' and i.balance > 0 and c.archived_at is null
       group by i.contract_id
    )
    select c.code, public.tenant_display_name(t, true) as party, pc.months, pc.first_ym, pc.last_ym, pc.total
      from per_contract pc
      join public.contracts c on c.company_id = v_company_id and c.id = pc.contract_id
      join public.tenants t on t.company_id = v_company_id and t.id = c.tenant_id
     order by pc.total desc, c.code
  loop
    v_count := v_count + 1;
    v_total := v_total + r.total;
    v_rows := v_rows || '<tr>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';" dir="rtl">'
      || replace(replace(replace(coalesce(r.party, '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';font-family:monospace;" dir="ltr">'
      || replace(replace(replace(coalesce(r.code, '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';text-align:center;">' || r.months || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';">'
      || public.report_month_label(r.first_ym / 100, r.first_ym % 100, v_is_ar) || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';">'
      || public.report_month_label(r.last_ym / 100, r.last_ym % 100, v_is_ar) || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';color:' || c_red || ';font-weight:700;" dir="ltr">'
      || to_char(r.total, 'FM999,999,990.000') || ' KWD</td></tr>';
  end loop;

  html := '<!doctype html><html lang="' || v_schedule.locale::text || '" dir="' || v_dir || '"><head><meta charset="utf-8">'
    || '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    || '<body style="margin:0;padding:16px;background:' || c_bg || ';font-family:Cairo,Segoe UI,Arial,sans-serif;color:' || c_on || ';">'
    || '<div style="max-width:900px;margin:0 auto;background:#fff;border:1px solid ' || c_outline || ';border-radius:16px;padding:20px;">'
    || '<div style="font-size:20px;font-weight:700;color:' || c_primary || ';">'
    || replace(replace(replace(v_company_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</div>'
    || '<div style="font-size:16px;font-weight:600;color:' || c_muted || ';margin:6px 0 16px;">'
    || replace(replace(replace(v_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || ' · ' || v_start || ' / ' || v_end || '</div>'
    || case when v_count = 0
         then '<p style="color:' || c_muted || ';">' || case when v_is_ar then 'لا توجد عقود متأخرة' else 'No overdue contracts' end || '</p>'
         else '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;"><thead><tr style="background:#eff4ff;text-align:start;">'
           || case when v_is_ar
                then '<th style="padding:8px;">الاسم التجاري</th><th style="padding:8px;">رقم العقد</th><th style="padding:8px;">عدد الأشهر المتأخرة</th><th style="padding:8px;">من</th><th style="padding:8px;">إلى</th><th style="padding:8px;">إجمالي المتأخر</th>'
                else '<th style="padding:8px;">Commercial name</th><th style="padding:8px;">Contract</th><th style="padding:8px;">Overdue months</th><th style="padding:8px;">From</th><th style="padding:8px;">To</th><th style="padding:8px;">Total overdue</th>'
              end
           || '</tr></thead><tbody>' || v_rows || '</tbody><tfoot><tr style="font-weight:700;background:#fff5f5;"><td style="padding:8px;" colspan="5">'
           || case when v_is_ar then 'الإجمالي (' || v_count || ' عقد)' else 'Total (' || v_count || ' contracts)' end
           || '</td><td style="padding:8px;color:' || c_red || ';" dir="ltr">' || to_char(v_total, 'FM999,999,990.000') || ' KWD</td></tr></tfoot></table>'
       end
    || '</div></body></html>';
  period_start := v_start;
  period_end := v_end;
  return next;
end;
$$;

/** يبني التقرير الدوري المجدول بصيغة HTML من بيانات الشركة الحالية فقط. */
create or replace function public.build_scheduled_report_html(p_schedule_id uuid, p_as_of date default null)
returns table(html text, period_start date, period_end date)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_schedule public.report_schedules%rowtype;
  v_company public.companies%rowtype;
  v_start date;
  v_end date := coalesce(p_as_of, current_date);
  v_paid numeric(14,3) := 0; v_paid_count integer := 0;
  v_overdue numeric(14,3) := 0; v_overdue_count integer := 0;
  v_expenses numeric(14,3) := 0; v_net numeric(14,3) := 0;
  v_payment_rows text := ''; v_overdue_rows text := '';
  v_units_occupied integer := 0; v_units_available integer := 0; v_units_maintenance integer := 0; v_units_total integer := 0;
  v_tenants_active integer := 0; v_tenants_blocked integer := 0; v_tenants_ended integer := 0;
  v_pct_occupied integer := 0; v_pct_available integer := 0; v_pct_maintenance integer := 0;
  v_dir text; v_title text; v_company_name text; v_footer text; v_body text; v_is_ar boolean;
  v_net_hint text; v_paid_hint text; v_expenses_hint text; v_overdue_hint text; v_snapshot_title text; v_snapshot_body text;
  v_primary text := '#004ac6';
  c_bg text := '#f8f9ff'; c_card text := '#ffffff'; c_on text := '#0b1c30'; c_muted text := '#434655';
  c_outline text := '#c3c6d7'; c_blue text := '#2563EB'; c_red text := '#EF4444'; c_green text := '#10B981';
  c_teal text := '#0D9488'; c_amber text := '#F59E0B'; c_error text := '#ba1a1a'; c_error_bg text := '#ffdad6';
  c_surface_low text := '#eff4ff'; c_surface_gray text := '#F8FAFC'; c_purple text := '#8B5CF6'; c_orange text := '#F97316';
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'reports.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select * into v_schedule from public.report_schedules where id = p_schedule_id and company_id = v_company_id;
  if not found then raise exception 'Report schedule not found'; end if;
  v_is_ar := v_schedule.locale = 'ar';
  select * into v_company from public.companies where id = v_company_id;

  v_start := case v_schedule.frequency
    when 'daily' then v_end when 'weekly' then v_end - 6
    when 'monthly' then date_trunc('month', v_end)::date when 'yearly' then date_trunc('year', v_end)::date
  end;

  select coalesce(sum(p.amount), 0), count(*) into v_paid, v_paid_count
    from public.payments p
   where p.company_id = v_company_id and p.status = 'confirmed' and p.payment_date between v_start and v_end;

  select count(*), coalesce(sum(i.balance), 0) into v_overdue_count, v_overdue
    from public.invoices i
   where i.company_id = v_company_id and i.state = 'overdue' and i.balance > 0;

  if to_regclass('public.expenses') is not null then
    select coalesce(sum(e.amount), 0) into v_expenses
      from public.expenses e
     where e.company_id = v_company_id and e.expense_date between v_start and v_end;
  end if;
  v_net := v_paid - v_expenses;

  select coalesce(count(*) filter (where status in ('occupied', 'reserved')), 0),
         coalesce(count(*) filter (where status in ('available', 'vacant')), 0),
         coalesce(count(*) filter (where status = 'under_maintenance'), 0),
         coalesce(count(*), 0)
    into v_units_occupied, v_units_available, v_units_maintenance, v_units_total
    from public.units
   where company_id = v_company_id and status is distinct from 'archived';

  if v_units_total > 0 then
    v_pct_occupied := least(100, round((v_units_occupied::numeric / v_units_total) * 100)::integer);
    v_pct_available := least(100, round((v_units_available::numeric / v_units_total) * 100)::integer);
    v_pct_maintenance := least(100, round((v_units_maintenance::numeric / v_units_total) * 100)::integer);
  end if;

  select coalesce(count(*) filter (where lifecycle = 'active'), 0),
         coalesce(count(*) filter (where lifecycle = 'blocked'), 0),
         coalesce(count(*) filter (where lifecycle = 'contract_ended'), 0)
    into v_tenants_active, v_tenants_blocked, v_tenants_ended
    from public.tenants
   where company_id = v_company_id;

  select coalesce(string_agg(
    '<tr><td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_on || ';">'
    || replace(replace(replace(coalesce(public.tenant_display_name(t, v_is_ar), '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</td>'
    || '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_muted || ';">' || p.payment_date::text || '</td>'
    || '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;font-weight:700;color:' || c_green || ';">'
    || to_char(p.amount, 'FM999,999,990.000') || ' KWD</td></tr>', '' order by p.payment_date desc), '')
    into v_payment_rows
    from (select p.* from public.payments p
           where p.company_id = v_company_id and p.status = 'confirmed' and p.payment_date between v_start and v_end
           order by p.payment_date desc limit 40) p
    left join public.tenants t on t.company_id = v_company_id and t.id = p.tenant_id;

  select coalesce(string_agg(
    '<tr><td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_on || ';">'
    || replace(replace(replace(coalesce(public.tenant_display_name(t, v_is_ar), '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</td>'
    || '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_muted || ';">'
    || i.period_month::text || '/' || i.period_year::text || '</td>'
    || '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;font-weight:700;color:' || c_error || ';text-align:end;">'
    || to_char(i.balance, 'FM999,999,990.000') || '</td></tr>', '' order by i.due_date), '')
    into v_overdue_rows
    from (select i.* from public.invoices i
           where i.company_id = v_company_id and i.state = 'overdue' and i.balance > 0
           order by i.due_date limit 40) i
    left join public.tenants t on t.company_id = v_company_id and t.id = i.tenant_id;

  v_dir := case when v_is_ar then 'rtl' else 'ltr' end;
  v_title := case when v_is_ar then v_schedule.name_ar else coalesce(v_schedule.name_en, v_schedule.name_ar) end;
  v_company_name := coalesce(
    case when v_is_ar then v_company.name_ar else coalesce(v_company.name_en, v_company.name_ar) end,
    case when v_is_ar then 'دانة المستقبل العقارية' else 'Danat Al Mustaqbal Real Estate' end);
  v_footer := coalesce(
    case when v_is_ar then v_company.invoice_footer_ar else v_company.invoice_footer_en end,
    case when v_is_ar then 'هذه رسالة تلقائية من نظام إدارة الإيجارات — دانة المستقبل العقارية.'
         else 'Automated message from the rental management system — Danat Al Mustaqbal Real Estate.' end);
  v_primary := coalesce(nullif(v_company.brand_primary, ''), '#004ac6');
  if v_primary !~ '^#[0-9A-Fa-f]{3,8}$' then v_primary := '#004ac6'; end if;

  v_paid_hint := case when v_is_ar then v_paid_count::text || ' دفعة'
                      else v_paid_count::text || case when v_paid_count = 1 then ' payment' else ' payments' end end;
  v_expenses_hint := case when v_is_ar then 'مصروفات الفترة' else 'Period outgoings' end;
  v_net_hint := case when v_net >= 0 then case when v_is_ar then 'رصيد إيجابي' else 'Positive balance' end
                     else case when v_is_ar then 'رصيد سالب' else 'Negative balance' end end;
  v_overdue_hint := case when v_is_ar then v_overdue_count::text || ' فاتورة تتطلب متابعة'
                         else v_overdue_count::text || ' pending invoices require attention' end;
  v_snapshot_title := case when v_is_ar then 'ملخص الفترة' else 'Period snapshot' end;
  v_snapshot_body := case when v_is_ar
    then 'صافي التحصيل ' || to_char(v_net, 'FM999999990.000') || ' د.ك بعد خصم المصروفات، مع ' || v_overdue_count::text || ' فاتورة متأخرة للمتابعة.'
    else 'Net collection ' || to_char(v_net, 'FM999999990.000') || ' KWD after expenses, with ' || v_overdue_count::text || ' overdue invoices to follow up.' end;

  v_body := '<!DOCTYPE html><html lang="' || case when v_is_ar then 'ar' else 'en' end || '" dir="' || v_dir || '"><head><meta charset="utf-8"/>'
    || '<meta name="viewport" content="width=device-width, initial-scale=1.0"/><meta http-equiv="X-UA-Compatible" content="IE=edge"/>'
    || '<title>' || replace(replace(replace(v_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</title>'
    || '<style type="text/css">body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;}body{margin:0!important;padding:0!important;width:100%!important;background-color:' || c_bg || ';}.email-shell{width:100%;max-width:600px;}.stat-value{font-size:26px;line-height:32px;font-weight:700;}.label-caps{font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;}.card-shadow{box-shadow:0 4px 12px rgba(0,0,0,0.05);}@media only screen and (max-width:620px){.email-shell,.kpi-cell,.stack-col{width:100%!important;max-width:100%!important;display:block!important;box-sizing:border-box!important;}.kpi-spacer,.stack-spacer{display:none!important;}}</style>'
    || '</head><body style="margin:0;padding:0;background-color:' || c_bg || ';font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:' || c_on || ';">'
    || '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">' || replace(replace(replace(v_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || ' · ' || v_start || ' / ' || v_end || '</div>'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:' || c_bg || ';"><tr><td align="center" class="px-outer" style="padding:20px 16px;">'
    || '<table role="presentation" class="email-shell" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">'
    || '<tr><td style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:16px 16px 0 0;padding:18px 24px;"><div style="font-size:20px;line-height:28px;font-weight:700;color:' || v_primary || ';">' || replace(replace(replace(v_company_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</div></td></tr>'
    || '<tr><td class="px-inner" style="background-color:' || c_bg || ';padding:28px 8px 8px 8px;text-align:center;"><div class="display-title" style="font-size:28px;line-height:34px;font-weight:700;color:' || v_primary || ';">' || replace(replace(replace(v_company_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</div>'
    || '<div style="font-size:16px;line-height:24px;font-weight:600;color:' || c_muted || ';margin-top:8px;" dir="' || v_dir || '">' || replace(replace(replace(v_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || ' <span style="color:#737686;margin:0 8px;">|</span> ' || v_start || ' / ' || v_end || '</div></td></tr>'
    || '<tr><td style="padding:16px 0 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    || '<td class="kpi-cell" width="50%" valign="top" style="width:50%;padding:0 6px 12px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_blue || ';border-radius:12px;"><tr><td style="padding:18px 16px;color:#ffffff;"><div class="label-caps">Collected / التحصيل</div><div class="stat-value" style="margin-top:8px;">' || to_char(v_paid, 'FM999999990.000') || ' KWD</div><div style="font-size:13px;opacity:0.85;margin-top:6px;">' || v_paid_hint || '</div></td></tr></table></td>'
    || '<td class="kpi-spacer" width="12" style="width:12px;">&nbsp;</td>'
    || '<td class="kpi-cell" width="50%" valign="top" style="width:50%;padding:0 0 12px 6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_red || ';border-radius:12px;"><tr><td style="padding:18px 16px;color:#ffffff;"><div class="label-caps">Expenses / المصروفات</div><div class="stat-value" style="margin-top:8px;">' || to_char(v_expenses, 'FM999999990.000') || ' KWD</div><div style="font-size:13px;opacity:0.85;margin-top:6px;">' || v_expenses_hint || '</div></td></tr></table></td>'
    || '</tr></table></td></tr>'
    || '<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    || '<td class="kpi-cell" width="50%" valign="top" style="width:50%;padding:0 6px 12px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_green || ';border-radius:12px;"><tr><td style="padding:18px 16px;color:#ffffff;"><div class="label-caps">Net / الصافي</div><div class="stat-value" style="margin-top:8px;">' || to_char(v_net, 'FM999999990.000') || ' KWD</div><div style="font-size:13px;opacity:0.85;margin-top:6px;">' || v_net_hint || '</div></td></tr></table></td>'
    || '<td class="kpi-spacer" width="12" style="width:12px;">&nbsp;</td>'
    || '<td class="kpi-cell" width="50%" valign="top" style="width:50%;padding:0 0 12px 6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_teal || ';border-radius:12px;"><tr><td style="padding:18px 16px;color:#ffffff;"><div class="label-caps">' || case when v_is_ar then 'الإيداعات' else 'Deposits' end || '</div><div class="stat-value" style="margin-top:8px;">—</div><div style="font-size:13px;opacity:0.85;margin-top:6px;">' || case when v_is_ar then 'سجل فقط — وحدة الإيداعات' else 'Ledger only — Deposits module' end || '</div></td></tr></table></td>'
    || '</tr></table></td></tr>'
    || '<tr><td style="padding:4px 0 20px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_amber || ';border-radius:12px;"><tr><td style="padding:18px 16px;color:#ffffff;"><div class="label-caps">Overdue / المتأخرات</div><div class="stat-value" style="margin-top:6px;">' || to_char(v_overdue, 'FM999999990.000') || ' KWD</div><div style="font-size:13px;opacity:0.9;margin-top:4px;">' || v_overdue_hint || '</div></td></tr></table></td></tr>'
    || '<tr><td style="padding:8px 0;"><div class="section-title" style="font-size:18px;font-weight:600;color:' || c_on || ';margin:0 0 12px 0;">✓ Successful Payments / المدفوعات الناجحة</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:12px;overflow:hidden;"><tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr style="background-color:' || c_surface_low || ';"><th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;color:' || c_muted || ';text-align:start;border-bottom:1px solid ' || c_outline || ';">Tenant / المستأجر</th><th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;color:' || c_muted || ';text-align:start;border-bottom:1px solid ' || c_outline || ';">Date</th><th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;color:' || c_muted || ';text-align:start;border-bottom:1px solid ' || c_outline || ';">Amount</th></tr>'
    || coalesce(nullif(v_payment_rows, ''), '<tr><td colspan="3" style="padding:16px;font-size:14px;color:' || c_muted || ';text-align:center;">—</td></tr>') || '</table></td></tr></table></td></tr>'
    || '<tr><td style="padding:20px 0 8px 0;"><div class="section-title" style="font-size:18px;font-weight:600;color:' || c_on || ';margin:0 0 12px 0;">⏱ Delayed Cases / حالات التأخير</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:12px;overflow:hidden;"><tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr style="background-color:' || c_error_bg || ';"><th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;color:#93000a;text-align:start;border-bottom:1px solid ' || c_outline || ';">Tenant / المستأجر</th><th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;color:#93000a;text-align:start;border-bottom:1px solid ' || c_outline || ';">Period</th><th align="right" style="padding:12px 16px;font-size:11px;font-weight:700;color:#93000a;text-align:end;border-bottom:1px solid ' || c_outline || ';">Balance</th></tr>'
    || coalesce(nullif(v_overdue_rows, ''), '<tr><td colspan="3" style="padding:16px;font-size:14px;color:' || c_muted || ';text-align:center;">—</td></tr>') || '</table></td></tr></table></td></tr>'
    || '<tr><td style="padding:24px 0 8px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    || '<td class="stack-col" width="50%" valign="top" style="width:50%;padding:0 6px 0 0;"><div class="section-title" style="font-size:18px;font-weight:600;color:' || c_on || ';margin:0 0 12px 0;">Property Status / حالة العقارات</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:12px;"><tr><td style="padding:16px;">'
    || '<table width="100%" style="margin-bottom:14px;"><tr><td style="font-size:14px;color:' || c_muted || ';">Occupied / مشغول</td><td align="right" style="font-size:14px;font-weight:700;">' || v_units_occupied || '</td></tr><tr><td colspan="2" style="padding-top:6px;"><table width="100%" style="background-color:#e5eeff;border-radius:999px;height:8px;"><tr><td width="' || greatest(v_pct_occupied, 1) || '%" style="background-color:' || c_blue || ';height:8px;border-radius:999px;">&nbsp;</td><td>&nbsp;</td></tr></table></td></tr></table>'
    || '<table width="100%" style="margin-bottom:14px;"><tr><td style="font-size:14px;color:' || c_muted || ';">Available / متاح</td><td align="right" style="font-size:14px;font-weight:700;">' || v_units_available || '</td></tr><tr><td colspan="2" style="padding-top:6px;"><table width="100%" style="background-color:#e5eeff;border-radius:999px;height:8px;"><tr><td width="' || greatest(v_pct_available, 1) || '%" style="background-color:#6cf8bb;height:8px;border-radius:999px;">&nbsp;</td><td>&nbsp;</td></tr></table></td></tr></table>'
    || '<table width="100%"><tr><td style="font-size:14px;color:' || c_muted || ';">Maintenance / صيانة</td><td align="right" style="font-size:14px;font-weight:700;">' || v_units_maintenance || '</td></tr><tr><td colspan="2" style="padding-top:6px;"><table width="100%" style="background-color:#e5eeff;border-radius:999px;height:8px;"><tr><td width="' || greatest(v_pct_maintenance, 1) || '%" style="background-color:' || c_orange || ';height:8px;border-radius:999px;">&nbsp;</td><td>&nbsp;</td></tr></table></td></tr></table>'
    || '</td></tr></table></td><td class="stack-spacer" width="12" style="width:12px;">&nbsp;</td>'
    || '<td class="stack-col" width="50%" valign="top" style="width:50%;padding:0 0 0 6px;"><div class="section-title" style="font-size:18px;font-weight:600;color:' || c_on || ';margin:0 0 12px 0;">Tenant Status / حالة المستأجرين</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:12px;"><tr><td style="padding:12px;">'
    || '<table width="100%" style="background-color:' || c_surface_gray || ';border-radius:8px;margin-bottom:8px;"><tr><td style="padding:12px 14px;font-size:14px;">Active / نشط</td><td align="right" style="padding:12px 14px;font-size:20px;font-weight:700;color:' || v_primary || ';">' || v_tenants_active || '</td></tr></table>'
    || '<table width="100%" style="background-color:' || c_surface_gray || ';border-radius:8px;margin-bottom:8px;"><tr><td style="padding:12px 14px;font-size:14px;">Blocked / محظور</td><td align="right" style="padding:12px 14px;font-size:20px;font-weight:700;color:' || c_error || ';">' || v_tenants_blocked || '</td></tr></table>'
    || '<table width="100%" style="background-color:' || c_surface_gray || ';border-radius:8px;"><tr><td style="padding:12px 14px;font-size:14px;">Contract Ended</td><td align="right" style="padding:12px 14px;font-size:20px;font-weight:700;color:' || c_muted || ';">' || v_tenants_ended || '</td></tr></table>'
    || '</td></tr></table></td></tr></table></td></tr>'
    || '<tr><td style="padding:20px 0 8px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_purple || ';border-radius:12px;"><tr><td style="padding:18px 16px;color:#ffffff;"><div style="font-size:16px;font-weight:600;">' || v_snapshot_title || '</div><div style="font-size:13px;opacity:0.9;margin-top:6px;">' || replace(replace(replace(v_snapshot_body, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</div></td></tr></table></td></tr>'
    || '<tr><td style="padding:32px 8px 8px 8px;text-align:center;border-top:1px solid ' || c_outline || ';margin-top:16px;"><div style="font-size:11px;font-weight:700;color:' || c_muted || ';">' || replace(replace(replace(v_company_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</div><div style="font-size:12px;color:#737686;margin-top:10px;">' || replace(replace(replace(v_footer, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</div></td></tr>'
    || '</table></td></tr></table></body></html>';

  html := v_body;
  period_start := v_start;
  period_end := v_end;
  return next;
end;
$$;

/** يحسب ملخص الميزانية والتدفقات المالية والفئات والأشهر ضمن نطاق الشركة الحالية. */
create or replace function public.get_budget_summary(
  p_from date,
  p_to date,
  p_property_id uuid default null,
  p_building_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_collections numeric(14,3);
  v_expenses numeric(14,3);
  v_refunds numeric(14,3);
  v_insurance numeric(14,3);
  v_categories jsonb;
  v_months jsonb;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if p_to < p_from then raise exception 'Invalid date range'; end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'reports.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select coalesce(sum(p.amount), 0) into v_collections
    from public.payments p
    left join public.units u on u.company_id = v_company_id and u.id = p.unit_id
   where p.company_id = v_company_id and p.status = 'confirmed' and p.reversed_by_payment_id is null
     and p.payment_date between p_from and p_to
     and (p_property_id is null or u.property_id = p_property_id)
     and (p_building_id is null or u.building_id = p_building_id);

  select coalesce(sum(e.amount), 0) into v_expenses
    from public.expenses e
    left join public.units u on u.company_id = v_company_id and u.id = e.unit_id
   where e.company_id = v_company_id and e.status = 'approved' and e.expense_date between p_from and p_to
     and (p_property_id is null or e.property_id = p_property_id or u.property_id = p_property_id)
     and (p_building_id is null or e.building_id = p_building_id or u.building_id = p_building_id);

  select coalesce(sum(r.amount), 0) into v_refunds
    from public.refunds r
    left join public.units u on u.company_id = v_company_id and u.id = r.unit_id
   where r.company_id = v_company_id and r.status = 'posted' and r.reversal_of_id is null
     and r.refund_date between p_from and p_to
     and (p_property_id is null or u.property_id = p_property_id)
     and (p_building_id is null or r.building_id = p_building_id or u.building_id = p_building_id);

  select coalesce(sum(ins.amount), 0) into v_insurance
    from public.insurance_payments ins
    left join public.units u on u.company_id = v_company_id and u.id = ins.unit_id
   where ins.company_id = v_company_id and ins.collected_date between p_from and p_to
     and (p_property_id is null or u.property_id = p_property_id)
     and (p_building_id is null or ins.building_id = p_building_id or u.building_id = p_building_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'category_id', x.category_id, 'code', x.code, 'name_ar', x.name_ar, 'name_en', x.name_en, 'amount', x.amount
  ) order by x.amount desc), '[]'::jsonb)
    into v_categories
    from (
      select e.category_id, coalesce(c.code, 'uncategorized') code,
             coalesce(c.name_ar, 'غير مصنف') name_ar, coalesce(c.name_en, 'Uncategorized') name_en,
             sum(e.amount)::numeric(14,3) amount
        from public.expenses e
        left join public.expense_categories c on c.company_id = v_company_id and c.id = e.category_id
        left join public.units u on u.company_id = v_company_id and u.id = e.unit_id
       where e.company_id = v_company_id and e.status = 'approved' and e.expense_date between p_from and p_to
         and (p_property_id is null or e.property_id = p_property_id or u.property_id = p_property_id)
         and (p_building_id is null or e.building_id = p_building_id or u.building_id = p_building_id)
       group by e.category_id, c.code, c.name_ar, c.name_en
    ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
    'month', to_char(m.month_start, 'YYYY-MM'), 'collections', coalesce(p.total, 0), 'expenses', coalesce(e.total, 0)
  ) order by m.month_start), '[]'::jsonb)
    into v_months
    from generate_series(date_trunc('month', p_from)::date, date_trunc('month', p_to)::date, interval '1 month') m(month_start)
    left join lateral (
      select sum(pm.amount)::numeric(14,3) total from public.payments pm
        left join public.units u on u.company_id = v_company_id and u.id = pm.unit_id
       where pm.company_id = v_company_id and pm.status = 'confirmed' and pm.reversed_by_payment_id is null
         and pm.payment_date >= m.month_start and pm.payment_date < m.month_start + interval '1 month'
         and pm.payment_date between p_from and p_to
         and (p_property_id is null or u.property_id = p_property_id)
         and (p_building_id is null or u.building_id = p_building_id)
    ) p on true
    left join lateral (
      select sum(ex.amount)::numeric(14,3) total from public.expenses ex
        left join public.units u on u.company_id = v_company_id and u.id = ex.unit_id
       where ex.company_id = v_company_id and ex.status = 'approved'
         and ex.expense_date >= m.month_start and ex.expense_date < m.month_start + interval '1 month'
         and ex.expense_date between p_from and p_to
         and (p_property_id is null or ex.property_id = p_property_id or u.property_id = p_property_id)
         and (p_building_id is null or ex.building_id = p_building_id or u.building_id = p_building_id)
    ) e on true;

  return jsonb_build_object(
    'collections', v_collections, 'deposits', 0::numeric(14,3), 'expenses', v_expenses,
    'refunds', v_refunds, 'insurance_collected', v_insurance,
    'net', v_collections - v_expenses - v_refunds, 'categories', v_categories, 'months', v_months);
end;
$$;

/** يحسب مؤشرات العقود للشركة الحالية مع دعم تصفية الأرشفة والحالة والمستأجر. */
create or replace function public.get_contracts_summary(
  p_search text default null,
  p_state text default null,
  p_tenant_id uuid default null,
  p_archive_mode text default 'current'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_total bigint; v_active bigint; v_expiring bigint; v_ended bigint;
  v_next_expiry date; v_monthly numeric(14,3); v_archived bigint; v_current bigint;
  v_mode text := coalesce(nullif(trim(p_archive_mode), ''), 'current');
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'contracts.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_mode not in ('current', 'archived', 'all') then
    raise exception 'p_archive_mode must be current, archived, or all';
  end if;

  select count(*),
         count(*) filter (where f.state = 'active'),
         count(*) filter (where f.state = 'active' and f.end_date between current_date and current_date + 60),
         count(*) filter (where f.state in ('expired', 'terminated')),
         min(f.end_date) filter (where f.state = 'active' and f.end_date >= current_date),
         coalesce(sum(f.monthly_amount) filter (where f.state = 'active'), 0)
    into v_total, v_active, v_expiring, v_ended, v_next_expiry, v_monthly
    from (
      select c.* from public.contracts c
       where c.company_id = v_company_id
         and (v_mode = 'all'
           or (v_mode = 'archived' and public.contract_is_ended(c.archived_at, c.state))
           or (v_mode = 'current' and not public.contract_is_ended(c.archived_at, c.state)))
         and (p_state is null or c.state::text = p_state)
         and (p_tenant_id is null or c.tenant_id = p_tenant_id)
         and (p_search is null or c.code ilike '%' || p_search || '%')
    ) f;

  select count(*) filter (where public.contract_is_ended(c.archived_at, c.state)),
         count(*) filter (where not public.contract_is_ended(c.archived_at, c.state))
    into v_archived, v_current
    from public.contracts c
   where c.company_id = v_company_id
     and (p_state is null or c.state::text = p_state)
     and (p_tenant_id is null or c.tenant_id = p_tenant_id)
     and (p_search is null or c.code ilike '%' || p_search || '%');

  return jsonb_build_object(
    'total', v_total, 'active', v_active, 'expiring_60d', v_expiring, 'ended', v_ended,
    'next_expiry', v_next_expiry, 'monthly_amount', v_monthly, 'annual_amount', v_monthly * 12,
    'archived_count', v_archived, 'current_count', v_current);
end;
$$;

/** يحسب إجمالي الإيداعات البنكية للشركة الحالية وفق مرشحات الفترة والبنك والحالة. */
create or replace function public.get_deposit_total(
  p_from date default null,
  p_to date default null,
  p_bank text default null,
  p_status text default null,
  p_search text default null
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_total numeric(14,3);
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'deposits.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select coalesce(sum(d.amount), 0) into v_total
    from public.deposits d
   where d.company_id = v_company_id
     and (p_from is null or d.deposit_date >= p_from)
     and (p_to is null or d.deposit_date <= p_to)
     and (p_bank is null or d.bank_name = p_bank)
     and (p_status is null or d.status = p_status)
     and (p_search is null or d.code ilike '%' || p_search || '%'
       or d.bank_name ilike '%' || p_search || '%' or coalesce(d.note, '') ilike '%' || p_search || '%');
  return v_total;
end;
$$;

/** يحسب ملخص بطاقات الإيداعات البنكية للشركة الحالية. */
create or replace function public.get_deposits_summary(
  p_search text default null,
  p_bank text default null,
  p_status text default null,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_total numeric(14,3); v_count bigint;
  v_confirmed numeric(14,3); v_confirmed_count bigint;
  v_pending numeric(14,3); v_pending_count bigint;
  v_month numeric(14,3); v_month_count bigint;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'deposits.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select coalesce(sum(f.amount), 0), count(*),
         coalesce(sum(f.amount) filter (where f.status = 'confirmed'), 0), count(*) filter (where f.status = 'confirmed'),
         coalesce(sum(f.amount) filter (where f.status = 'pending'), 0), count(*) filter (where f.status = 'pending')
    into v_total, v_count, v_confirmed, v_confirmed_count, v_pending, v_pending_count
    from (
      select d.* from public.deposits d
       where d.company_id = v_company_id
         and (p_from is null or d.deposit_date >= p_from)
         and (p_to is null or d.deposit_date <= p_to)
         and (p_bank is null or d.bank_name = p_bank)
         and (p_status is null or d.status = p_status)
         and (p_search is null or d.code ilike '%' || p_search || '%'
           or d.bank_name ilike '%' || p_search || '%' or coalesce(d.note, '') ilike '%' || p_search || '%')
    ) f;

  select coalesce(sum(d.amount), 0), count(*) into v_month, v_month_count
    from public.deposits d
   where d.company_id = v_company_id
     and d.deposit_date >= date_trunc('month', current_date)::date
     and d.deposit_date < (date_trunc('month', current_date) + interval '1 month')::date;

  return jsonb_build_object(
    'total', jsonb_build_object('amount', v_total, 'count', v_count),
    'confirmed', jsonb_build_object('amount', v_confirmed, 'count', v_confirmed_count),
    'pending', jsonb_build_object('amount', v_pending, 'count', v_pending_count),
    'this_month', jsonb_build_object('amount', v_month, 'count', v_month_count));
end;
$$;

/** يحسب ملخص بطاقات المصروفات للشركة الحالية. */
create or replace function public.get_expenses_summary(
  p_search text default null,
  p_class text default null,
  p_category_id uuid default null,
  p_property_id uuid default null,
  p_status text default null,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_total numeric(14,3); v_count bigint;
  v_approved numeric(14,3); v_approved_count bigint;
  v_pending numeric(14,3); v_pending_count bigint;
  v_month numeric(14,3); v_month_count bigint;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'expenses.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select coalesce(sum(f.amount), 0), count(*),
         coalesce(sum(f.amount) filter (where f.status = 'approved'), 0), count(*) filter (where f.status = 'approved'),
         coalesce(sum(f.amount) filter (where f.status = 'pending'), 0), count(*) filter (where f.status = 'pending')
    into v_total, v_count, v_approved, v_approved_count, v_pending, v_pending_count
    from (
      select e.* from public.expenses e
       where e.company_id = v_company_id
         and (p_class is null or e.class::text = p_class)
         and (p_category_id is null or e.category_id = p_category_id)
         and (p_property_id is null or e.property_id = p_property_id)
         and (p_status is null or e.status::text = p_status)
         and (p_from is null or e.expense_date >= p_from)
         and (p_to is null or e.expense_date <= p_to)
         and (p_search is null or e.code ilike '%' || p_search || '%'
           or coalesce(e.payee, '') ilike '%' || p_search || '%'
           or coalesce(e.cost_center, '') ilike '%' || p_search || '%'
           or coalesce(e.note, '') ilike '%' || p_search || '%')
    ) f;

  select coalesce(sum(e.amount), 0), count(*) into v_month, v_month_count
    from public.expenses e
   where e.company_id = v_company_id
     and e.expense_date >= date_trunc('month', current_date)::date
     and e.expense_date < (date_trunc('month', current_date) + interval '1 month')::date;

  return jsonb_build_object(
    'total', jsonb_build_object('amount', v_total, 'count', v_count),
    'approved', jsonb_build_object('amount', v_approved, 'count', v_approved_count),
    'pending', jsonb_build_object('amount', v_pending, 'count', v_pending_count),
    'this_month', jsonb_build_object('amount', v_month, 'count', v_month_count));
end;
$$;

/** يحسب الملخص الشهري للفواتير ضمن سنة محددة للشركة الحالية. */
create or replace function public.get_invoice_month_summary(p_year integer, p_property_id uuid default null)
returns table(month integer, count bigint, total numeric, paid numeric, outstanding numeric, overdue bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'invoices.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  with rent as (
    select ii.invoice_id, u.property_id, ii.amount
      from public.invoice_items ii
      join public.units u on u.company_id = v_company_id and u.id = ii.unit_id
     where ii.company_id = v_company_id and not ii.is_extra_charge and not ii.is_concession
  ),
  shares as (
    select i.id, i.period_month, i.total, i.paid, i.balance, i.state,
           (p_property_id is null or exists (select 1 from rent r where r.invoice_id = i.id and r.property_id = p_property_id)) as touches,
           case when p_property_id is null then 1::numeric
                else coalesce((select sum(r.amount) from rent r where r.invoice_id = i.id and r.property_id = p_property_id)
                              / nullif((select sum(r.amount) from rent r where r.invoice_id = i.id), 0), 0)
           end as share
      from public.invoices i
     where i.company_id = v_company_id and i.period_year = p_year
  )
  select m.month, count(s.id) filter (where s.touches),
         round(coalesce(sum(s.total * s.share), 0), 3),
         round(coalesce(sum(s.paid * s.share), 0), 3),
         round(coalesce(sum(s.balance * s.share), 0), 3),
         count(s.id) filter (where s.touches and s.state = 'overdue')
    from generate_series(1, 12) as m(month)
    left join shares s on s.period_month = m.month
   group by m.month
   order by m.month;
end;
$$;

/** يحسب ملخص المدفوعات والجزئيات والتأمين والمستردات للشركة الحالية. */
create or replace function public.get_payments_summary(
  p_search text default null,
  p_method text default null,
  p_status text default null,
  p_tenant_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_full_total numeric(14,3); v_full_count bigint;
  v_partial_total numeric(14,3); v_partial_count bigint;
  v_insurance_total numeric(14,3); v_insurance_count bigint;
  v_refund_total numeric(14,3); v_refund_count bigint;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'payments.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select coalesce(sum(p.amount), 0), count(*) into v_full_total, v_full_count
    from public.payments p
   where p.company_id = v_company_id and p.status = 'confirmed' and p.reversed_by_payment_id is null
     and (p_method is null or p.method::text = p_method)
     and (p_status is null or p.status::text = p_status)
     and (p_tenant_id is null or p.tenant_id = p_tenant_id)
     and (p_search is null or p.code ilike '%' || p_search || '%'
       or coalesce(p.reference, '') ilike '%' || p_search || '%'
       or exists (select 1 from public.tenants t where t.company_id = v_company_id and t.id = p.tenant_id
                     and (t.code ilike '%' || p_search || '%' or t.name ilike '%' || p_search || '%')));

  select coalesce(sum(x.amount), 0), count(*) into v_partial_total, v_partial_count
    from public.partial_payments x
   where x.company_id = v_company_id and (p_tenant_id is null or x.tenant_id = p_tenant_id);

  select coalesce(sum(x.amount), 0), count(*) into v_insurance_total, v_insurance_count
    from public.insurance_payments x
   where x.company_id = v_company_id and (p_tenant_id is null or x.tenant_id = p_tenant_id);

  select coalesce(sum(x.amount), 0), count(*) into v_refund_total, v_refund_count
    from public.refunds x
   where x.company_id = v_company_id and x.status = 'posted' and x.reversal_of_id is null
     and (p_tenant_id is null or x.tenant_id = p_tenant_id);

  return jsonb_build_object(
    'full', jsonb_build_object('total', v_full_total, 'count', v_full_count),
    'partial', jsonb_build_object('total', v_partial_total, 'count', v_partial_count),
    'insurance', jsonb_build_object('total', v_insurance_total, 'count', v_insurance_count),
    'refunds', jsonb_build_object('total', v_refund_total, 'count', v_refund_count),
    'net', v_full_total - v_refund_total);
end;
$$;

/** يحسب إجمالي الإيجار الشهري لكل عقار للشركة الحالية ضمن الفترة المحددة. */
create or replace function public.get_property_monthly_rent_totals(
  p_period_start date default (date_trunc('month', current_date))::date
)
returns table(property_id uuid, monthly_total numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_period date := coalesce(p_period_start, date_trunc('month', current_date)::date);
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'properties.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  select u.property_id, round(sum(upa.monthly_amount), 3)
    from public.contracts c
    cross join lateral public.contract_unit_period_amounts(c.id, v_period) upa
    join public.units u on u.company_id = v_company_id and u.id = upa.unit_id
   where c.company_id = v_company_id and c.state = 'active' and c.archived_at is null
     and v_period >= date_trunc('month', c.start_date)::date
     and v_period <= date_trunc('month', c.end_date)::date
     and not public.period_in_free_months(c.id, v_period)
   group by u.property_id;
end;
$$;

/** يحسب مؤشرات المستأجرين والمتأخرات الخاصة بهم ضمن نطاق الشركة الحالية. */
create or replace function public.get_tenants_summary(
  p_search text default null,
  p_category text default null,
  p_lifecycle text default null,
  p_archive_mode text default 'current'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_total bigint; v_active bigint; v_blocked bigint;
  v_arrears numeric(14,3); v_arrears_tenants bigint;
  v_archived bigint; v_current bigint;
  v_mode text := coalesce(nullif(trim(p_archive_mode), ''), 'current');
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'tenants.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_mode not in ('current', 'archived', 'all') then
    raise exception 'p_archive_mode must be current, archived, or all';
  end if;

  select count(*), count(*) filter (where t.lifecycle = 'active'),
         count(*) filter (where t.lifecycle in ('blocked', 'inactive'))
    into v_total, v_active, v_blocked
    from public.tenants t
   where t.company_id = v_company_id
     and (v_mode = 'all' or (v_mode = 'archived' and t.archived_at is not null) or (v_mode = 'current' and t.archived_at is null))
     and (p_category is null or t.category::text = p_category)
     and (p_lifecycle is null or t.lifecycle::text = p_lifecycle)
     and (p_search is null or t.code ilike '%' || p_search || '%' or t.name ilike '%' || p_search || '%'
       or coalesce(t.mobile, '') ilike '%' || p_search || '%' or coalesce(t.email, '') ilike '%' || p_search || '%');

  select count(*) filter (where t.archived_at is not null), count(*) filter (where t.archived_at is null)
    into v_archived, v_current
    from public.tenants t
   where t.company_id = v_company_id
     and (p_category is null or t.category::text = p_category)
     and (p_lifecycle is null or t.lifecycle::text = p_lifecycle)
     and (p_search is null or t.code ilike '%' || p_search || '%' or t.name ilike '%' || p_search || '%'
       or coalesce(t.mobile, '') ilike '%' || p_search || '%' or coalesce(t.email, '') ilike '%' || p_search || '%');

  select coalesce(sum(i.balance), 0), count(distinct i.tenant_id)
    into v_arrears, v_arrears_tenants
    from public.invoices i
    join public.tenants t on t.company_id = v_company_id and t.id = i.tenant_id
   where i.company_id = v_company_id and i.state = 'overdue' and i.balance > 0
     and (v_mode = 'all' or (v_mode = 'archived' and t.archived_at is not null) or (v_mode = 'current' and t.archived_at is null))
     and (p_category is null or t.category::text = p_category)
     and (p_lifecycle is null or t.lifecycle::text = p_lifecycle)
     and (p_search is null or t.code ilike '%' || p_search || '%' or t.name ilike '%' || p_search || '%'
       or coalesce(t.mobile, '') ilike '%' || p_search || '%' or coalesce(t.email, '') ilike '%' || p_search || '%');

  return jsonb_build_object(
    'total', v_total, 'active', v_active, 'blocked_inactive', v_blocked,
    'arrears', jsonb_build_object('amount', v_arrears, 'tenants', v_arrears_tenants),
    'archived_count', v_archived, 'current_count', v_current);
end;
$$;

/** يحسب مؤشرات الوحدات العقارية وإمكاناتها الإيجارية ضمن نطاق الشركة الحالية. */
create or replace function public.get_units_summary(
  p_search text default null,
  p_property_id uuid default null,
  p_building_id uuid default null,
  p_status text default null,
  p_type text default null,
  p_meter text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_total bigint; v_occupied bigint; v_vacant bigint; v_maintenance bigint; v_rent numeric(14,3);
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'units.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select count(*),
         count(*) filter (where u.status = 'occupied'),
         count(*) filter (where u.status = 'vacant'),
         count(*) filter (where u.status = 'under_maintenance'),
         coalesce(sum(coalesce(u.default_rent, 0)), 0)
    into v_total, v_occupied, v_vacant, v_maintenance, v_rent
    from public.units u
   where u.company_id = v_company_id
     and (p_property_id is null or u.property_id = p_property_id)
     and (p_building_id is null or u.building_id = p_building_id)
     and (p_status is null or u.status::text = p_status)
     and (p_type is null or u.type = p_type)
     and (p_meter is null or u.electricity_meter_ownership::text = p_meter)
     and (p_search is null or u.code ilike '%' || p_search || '%' or u.name ilike '%' || p_search || '%');

  return jsonb_build_object(
    'total', v_total, 'occupied', v_occupied, 'vacant', v_vacant,
    'under_maintenance', v_maintenance, 'rent_potential', v_rent);
end;
$$;

revoke all on function public.purge_log(text, integer) from public, anon, authenticated;
revoke all on function public.purge_expired_logs() from public, anon, authenticated;
revoke all on function public.claim_cron_run(text, integer) from public, anon, authenticated;
revoke all on function public.record_cron_run(text, text, integer, text) from public, anon, authenticated;
revoke all on function public.ingest_whatsapp_messages(jsonb) from public, anon, authenticated;
revoke all on function public.backup_dump_all() from public, anon, authenticated;
revoke all on function public.backup_restore(jsonb, uuid) from public, anon, authenticated;

grant execute on function public.purge_log(text, integer) to company_service, service_role;
grant execute on function public.purge_expired_logs() to company_service, service_role;
grant execute on function public.claim_cron_run(text, integer) to company_service, service_role;
grant execute on function public.record_cron_run(text, text, integer, text) to company_service, service_role;
grant execute on function public.ingest_whatsapp_messages(jsonb) to company_service, service_role;
grant execute on function public.backup_dump_all() to company_service, service_role;
grant execute on function public.backup_restore(jsonb, uuid) to company_service, service_role;

revoke all on function public.set_log_retention(text, integer) from public, anon;
revoke all on function public.identify_contract_expiry_reminders(date) from public, anon;
revoke all on function public.whatsapp_session_health() from public, anon;
revoke all on function public.build_overdue_contracts_report_html(uuid, date) from public, anon;
revoke all on function public.build_scheduled_report_html(uuid, date) from public, anon;
revoke all on function public.get_budget_summary(date, date, uuid, uuid) from public, anon;
revoke all on function public.get_contracts_summary(text, text, uuid, text) from public, anon;
revoke all on function public.get_deposit_total(date, date, text, text, text) from public, anon;
revoke all on function public.get_deposits_summary(text, text, text, date, date) from public, anon;
revoke all on function public.get_expenses_summary(text, text, uuid, uuid, text, date, date) from public, anon;
revoke all on function public.get_invoice_month_summary(integer, uuid) from public, anon;
revoke all on function public.get_payments_summary(text, text, text, uuid) from public, anon;
revoke all on function public.get_property_monthly_rent_totals(date) from public, anon;
revoke all on function public.get_tenants_summary(text, text, text, text) from public, anon;
revoke all on function public.get_units_summary(text, uuid, uuid, text, text, text) from public, anon;

grant execute on function public.set_log_retention(text, integer) to authenticated, company_service, service_role;
grant execute on function public.identify_contract_expiry_reminders(date) to authenticated, company_service, service_role;
grant execute on function public.whatsapp_session_health() to authenticated, company_service, service_role;
grant execute on function public.build_overdue_contracts_report_html(uuid, date) to authenticated, company_service, service_role;
grant execute on function public.build_scheduled_report_html(uuid, date) to authenticated, company_service, service_role;
grant execute on function public.get_budget_summary(date, date, uuid, uuid) to authenticated, company_service, service_role;
grant execute on function public.get_contracts_summary(text, text, uuid, text) to authenticated, company_service, service_role;
grant execute on function public.get_deposit_total(date, date, text, text, text) to authenticated, company_service, service_role;
grant execute on function public.get_deposits_summary(text, text, text, date, date) to authenticated, company_service, service_role;
grant execute on function public.get_expenses_summary(text, text, uuid, uuid, text, date, date) to authenticated, company_service, service_role;
grant execute on function public.get_invoice_month_summary(integer, uuid) to authenticated, company_service, service_role;
grant execute on function public.get_payments_summary(text, text, text, uuid) to authenticated, company_service, service_role;
grant execute on function public.get_property_monthly_rent_totals(date) to authenticated, company_service, service_role;
grant execute on function public.get_tenants_summary(text, text, text, text) to authenticated, company_service, service_role;
grant execute on function public.get_units_summary(text, uuid, uuid, text, text, text) to authenticated, company_service, service_role;
