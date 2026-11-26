-- 299_functions_backup.sql
-- T037: function audit — backup dump and restore.
-- Split from 283_functions_notifications_reports.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

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


revoke all on function public.backup_dump_all() from public, anon, authenticated;
revoke all on function public.backup_restore(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.backup_dump_all() to company_service, service_role;
grant execute on function public.backup_restore(jsonb, uuid) to company_service, service_role;
