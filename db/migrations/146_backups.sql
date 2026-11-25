-- 146_backups.sql
-- Create backups metadata table, private storage bucket, company switches,
-- and the functions to dump and restore snapshots.

-- 1. Table
create table if not exists public.backups (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  storage_path text not null unique,
  sha256 text not null,
  size_bytes bigint not null,
  table_count int not null,
  row_count bigint not null,
  kind text not null,
  period_key text,
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create unique index if not exists backups_kind_period_key_idx 
  on public.backups (kind, period_key) 
  where period_key is not null;

comment on index public.backups_kind_period_key_idx is 'The loser of a (kind, period_key) race must delete the object it already uploaded to avoid leaking the storage object.';

revoke all on public.backups from anon, authenticated;
grant select on public.backups to authenticated;
grant all on public.backups to service_role;

alter table public.backups enable row level security;

drop policy if exists backups_select_admin on public.backups;
create policy backups_select_admin on public.backups
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

drop policy if exists backups_service_all on public.backups;
create policy backups_service_all on public.backups
  for all to service_role
  using (true)
  with check (true);

-- 2. Storage Bucket
--
-- Warning: Supabase Storage keeps content type in POSIX extended attributes.
-- Copy this bucket only with `rsync -aX` or `tar --xattrs` (like bucket 109).
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do update set public = false;

drop policy if exists backups_service_all on storage.objects;
create policy backups_service_all on storage.objects
  for all to service_role
  using (bucket_id = 'backups')
  with check (bucket_id = 'backups');

-- 3. Company Columns
-- The backup is global. The switches live here assuming a single-company deployment,
-- and the job reads the oldest row.
alter table public.companies
  add column if not exists backup_daily_enabled boolean not null default false,
  add column if not exists backup_weekly_enabled boolean not null default false;

do $fn$
begin
  if not exists (
    select 1 from pg_constraint 
    where conname = 'companies_backup_exclusive'
  ) then
    alter table public.companies 
      add constraint companies_backup_exclusive 
      check (not (backup_daily_enabled and backup_weekly_enabled));
  end if;
end $fn$;

comment on column public.companies.backup_daily_enabled is 'The backup is global; these switches live here assuming a single-company deployment.';
comment on column public.companies.backup_weekly_enabled is 'The backup is global; these switches live here assuming a single-company deployment.';

/**
 * يمنع غير المسؤولين من تعديل مفتاحَي النسخ الاحتياطي على جدول الشركات.
 *
 * The two switches ride on `companies`, which is writable by anyone holding
 * `company.update` — a permission a custom role can be granted. Turning off
 * someone's recovery schedule is not a company-settings-level action, so the
 * table's own policy is not a sufficient gate and this trigger is the real one.
 *
 * A null `auth.uid()` is allowed through deliberately: that is the service-key
 * path used by the cron job and the server functions, and both already check
 * for the admin role themselves before they get here.
 */
create or replace function public.companies_backup_settings_protect()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if (new.backup_daily_enabled is distinct from old.backup_daily_enabled) or
     (new.backup_weekly_enabled is distinct from old.backup_weekly_enabled) then
    if auth.uid() is not null and not public.has_role(auth.uid(), 'admin') then
      raise exception 'Forbidden: Only administrators can modify backup settings';
    end if;
  end if;
  return new;
end;
$fn$;

-- A trigger function fires through the trigger, not through an EXECUTE grant,
-- so revoking costs nothing and keeps it off the anon-executable catalogue that
-- src/db/anonExecute.sqltest.ts enforces. Every SECURITY DEFINER in this schema
-- has to justify its reachability; this one is reachable only from the trigger.
revoke execute on function public.companies_backup_settings_protect() from public, anon, authenticated;

drop trigger if exists companies_backup_settings_protect_trigger on public.companies;
create trigger companies_backup_settings_protect_trigger
  before update on public.companies
  for each row
  execute function public.companies_backup_settings_protect();

comment on function public.companies_backup_settings_protect() is 'يحمي إعدادات النسخ الاحتياطي من التعديل بواسطة غير المسؤولين. Allowed when auth.uid() is null (the service-key path) because cron jobs and server functions gate on admin themselves.';

-- 4. Seed cron_jobs
insert into public.cron_jobs (key, kind, name_ar, name_en, description_ar, description_en)
values
  ('backup', 'scheduled',
   'النسخ الاحتياطي', 'Database backup',
   'يأخذ لقطة كاملة لقاعدة البيانات ويحفظها كملف أرشيف.',
   'Takes a full snapshot of the database and saves it as an archive.')
on conflict (key) do update
  set kind = excluded.kind,
      name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      description_ar = excluded.description_ar,
      description_en = excluded.description_en;

update public.cron_jobs
  set is_active = true,
      recipient_targets = array['admin']::text[]
  where key = 'backup';

-- 5. Functions

/**
 * يعيد قائمة الجداول المستثناة من النسخ الاحتياطي بالكامل.
 *
 * `backups` itself is excluded so restoring does not wipe the archive index.
 * Marked stable so it executes within the calling statement's snapshot.
 */
create or replace function public.backup_excluded_tables()
returns setof text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  values ('backups');
$fn$;
revoke execute on function public.backup_excluded_tables() from public, anon, authenticated;
grant execute on function public.backup_excluded_tables() to service_role;

/**
 * يعيد قائمة الجداول المحمية التي تنسخ ولكن لا تحذف عند الاستعادة.
 *
 * `audit_logs` must survive a restore, or evidence of the restore itself is lost.
 * Marked stable so it executes within the calling statement's snapshot.
 */
create or replace function public.backup_protected_tables()
returns setof text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  values ('audit_logs');
$fn$;
revoke execute on function public.backup_protected_tables() from public, anon, authenticated;
grant execute on function public.backup_protected_tables() to service_role;

/**
 * يعيد أسماء جميع الجداول الأساسية المشمولة في النسخ الاحتياطي.
 *
 * Marked stable so it executes within the calling statement's snapshot.
 */
create or replace function public.backup_table_names()
returns setof text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select table_name::text
  from information_schema.tables
  where table_schema = 'public'
    and table_type = 'BASE TABLE'
    and table_name not in (select backup_excluded_tables from public.backup_excluded_tables())
  order by table_name;
$fn$;
revoke execute on function public.backup_table_names() from public, anon, authenticated;
grant execute on function public.backup_table_names() to service_role;

/**
 * يولد بصمة فريدة لهيكل قاعدة البيانات لمقارنتها قبل الاستعادة.
 *
 * Deterministic hash over exact catalog definitions of included tables, avoiding drift.
 * Uses format_type() instead of information_schema.data_type for exact precision.
 * Includes constraints via pg_get_constraintdef().
 *
 * md5, not pgcrypto's digest(): pgcrypto is installed in the `extensions`
 * schema here, and this function pins `search_path` to public + pg_temp, so
 * `digest` is simply not resolvable and the migration failed to apply at all.
 * Qualifying it as extensions.digest would work but ties a core feature to
 * where an extension happens to live. md5 is in pg_catalog, resolvable under
 * any search_path, and strong enough for the job: this fingerprint detects
 * accidental schema drift between an archive and the database, it is not
 * defending against someone crafting a collision.
 *
 * Marked stable so it executes within the calling statement's snapshot.
 */
create or replace function public.backup_schema_fingerprint()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select md5(
    coalesce(
      (
        select string_agg(
          format('%I|cols=%s|cons=%s', 
            t.table_name,
            (
              select string_agg(
                format('%I:%s:nn=%s:id=%s:gen=%s',
                  a.attname,
                  format_type(a.atttypid, a.atttypmod),
                  a.attnotnull,
                  a.attidentity,
                  a.attgenerated
                ),
                ',' order by a.attname
              )
              from pg_attribute a
              join pg_class c on a.attrelid = c.oid
              join pg_namespace n on c.relnamespace = n.oid
              where n.nspname = 'public' and c.relname = t.table_name
                and a.attnum > 0 and not a.attisdropped
            ),
            coalesce(
              (
                select string_agg(
                  format('%I:%s', con.conname, pg_get_constraintdef(con.oid)),
                  ',' order by con.conname
                )
                from pg_constraint con
                join pg_class c on con.conrelid = c.oid
                join pg_namespace n on c.relnamespace = n.oid
                where n.nspname = 'public' and c.relname = t.table_name
              ),
              ''
            )
          ),
          ';' order by t.table_name
        )
        from public.backup_table_names() t(table_name)
      ),
      ''
    )
  );
$fn$;
revoke execute on function public.backup_schema_fingerprint() from public, anon, authenticated;
grant execute on function public.backup_schema_fingerprint() to service_role;

/**
 * يأخذ لقطة كاملة لبيانات الجداول.
 *
 * ONE call, ONE snapshot. Evaluates all tables inside one transaction snapshot.
 * Must be STABLE: under READ COMMITTED, every statement takes a fresh snapshot.
 * A VOLATILE function's internal queries are separate statements, which would
 * take a new snapshot per table and break cross-table consistency. STABLE pins
 * all internal queries to the calling statement's snapshot.
 */
create or replace function public.backup_dump_all()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  _tables jsonb := '[]'::jsonb;
  _tbl text;
  _rows jsonb;
  _payload jsonb;
begin
  for _tbl in select backup_table_names from public.backup_table_names() loop
    execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from %I t', _tbl) into _rows;
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
$fn$;
revoke execute on function public.backup_dump_all() from public, anon, authenticated;
grant execute on function public.backup_dump_all() to service_role;

/**
 * يستعيد اللقطة عبر استبدال البيانات مع فحص البصمة ومعالجة المفاتيح الأجنبية.
 *
 * 1. Checks version and schema fingerprint.
 * 2. Locks all tables alphabetically to prevent deadlocks.
 * 3. Skips missing auth.users targets (or nulls them) instead of dropping rows.
 */
create or replace function public.backup_restore(_payload jsonb, _actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
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
begin
  if (_payload->>'format_version') is distinct from '1' then
    raise exception 'Unsupported format_version %', _payload->>'format_version';
  end if;

  select string_agg(name, ', ') into _duplicate
  from (
    select obj->>'name' as name, count(*) as cnt
    from jsonb_array_elements(_tables_arr) obj
    group by obj->>'name'
  ) t
  where cnt > 1;

  if _duplicate is not null then
    raise exception 'Payload contains duplicate entries for tables: %', _duplicate;
  end if;

  -- `e(table_name)`, not a bare `e`: aliasing a set-returning function renames
  -- its single output column to the alias, so `e.backup_table_names` does not
  -- exist and every call raised 42703 before this was caught. The column alias
  -- has to be given explicitly.
  select string_agg(e.table_name, ', ') into _missing
  from public.backup_table_names() e(table_name)
  where not exists (
    select 1 from jsonb_array_elements(_tables_arr) obj where obj->>'name' = e.table_name
  );

  if _missing is not null then
    raise exception 'Payload is missing tables: %', _missing;
  end if;

  select string_agg(obj->>'name', ', ') into _extra
  from jsonb_array_elements(_tables_arr) obj
  where not exists (
    select 1 from public.backup_table_names() e(table_name) where e.table_name = obj->>'name'
  );

  if _extra is not null then
    raise exception 'Payload contains unexpected tables: %', _extra;
  end if;

  -- Lock tables to prevent deadlocks and concurrent schema modifications.
  -- Ordinary application transactions can still deadlock against the restore.
  -- The caller surfaces the SQLSTATE 40P01 rather than retrying blindly.
  for _table in select backup_table_names from public.backup_table_names() order by backup_table_names loop
    execute format('lock table %I in access exclusive mode', _table);
  end loop;

  if (_payload->>'schema_fingerprint') is distinct from public.backup_schema_fingerprint() then
    raise exception 'Schema drift detected. The archive schema does not match the current database.';
  end if;

  set local session_replication_role = replica;

  if _actor is not null then
    select * into _current_actor_profile from public.profiles where id = _actor;
  end if;

  for _tbl_obj in select * from jsonb_array_elements(_tables_arr) loop
    _table := _tbl_obj->>'name';
    _manifest_count := jsonb_array_length(_tbl_obj->'rows');

    if exists (select 1 from public.backup_table_names() where backup_table_names = _table)
       and not exists (select 1 from public.backup_protected_tables() where backup_protected_tables = _table)
    then
      execute format('delete from %I', _table);
      get diagnostics _deleted_count = ROW_COUNT;

      _skipped_count := 0;
      _nulled_count := 0;
      _row_data := _tbl_obj->'rows';

      for _fk_record in (
        select a.attname as col_name,
               c.confdeltype,
               a.attnotnull
        from pg_constraint c
        join pg_attribute a on a.attnum = any(c.conkey) and a.attrelid = c.conrelid
        where c.conrelid = _table::regclass
          and c.confrelid = 'auth.users'::regclass
          and c.contype = 'f'
      ) loop
        declare
          _will_null int := 0;
          _will_skip int := 0;
        begin
          if _fk_record.confdeltype = 'n' and not _fk_record.attnotnull then
            select count(*) into _will_null
            from jsonb_array_elements(_row_data) r
            where (r->>_fk_record.col_name) is not null
              and not exists (select 1 from auth.users u where u.id::text = (r->>_fk_record.col_name));
            
            _nulled_count := _nulled_count + _will_null;
            
            _row_data := (
              select coalesce(jsonb_agg(
                case
                  when (r->>_fk_record.col_name) is not null
                   and not exists (select 1 from auth.users u where u.id::text = (r->>_fk_record.col_name))
                  then jsonb_set(r, array[_fk_record.col_name], 'null'::jsonb)
                  else r
                end
              ), '[]'::jsonb)
              from jsonb_array_elements(_row_data) r
            );
          else
            select count(*) into _will_skip
            from jsonb_array_elements(_row_data) r
            where (r->>_fk_record.col_name) is not null
              and not exists (select 1 from auth.users u where u.id::text = (r->>_fk_record.col_name));
            
            _skipped_count := _skipped_count + _will_skip;
            
            _row_data := (
              select coalesce(jsonb_agg(r), '[]'::jsonb)
              from jsonb_array_elements(_row_data) r
              where (r->>_fk_record.col_name) is null
                 or exists (select 1 from auth.users u where u.id::text = (r->>_fk_record.col_name))
            );
          end if;
        end;
      end loop;

      select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into _cols
      from information_schema.columns
      where table_schema = 'public'
        and table_name = _table
        and is_generated <> 'ALWAYS';
        
      -- ROW_COUNT, not jsonb_array_length: the check below is only worth running
      -- if it observes what the database actually accepted. Counting the payload
      -- we are about to send compares two numbers we just computed ourselves, so
      -- it would still pass if every insert silently landed nothing — which is
      -- precisely the failure it exists to catch.
      _inserted_count := 0;
      if coalesce(_cols, '') <> '' and jsonb_array_length(_row_data) > 0 then
        execute format(
          'insert into %I (%s) select %s from jsonb_populate_recordset(null::%I, $1)',
          _table, _cols, _cols, _table
        ) using _row_data;
        get diagnostics _inserted_count = ROW_COUNT;
      end if;

      if _inserted_count <> (_manifest_count - _skipped_count) then
        raise exception 'Restore mismatch for %: expected % rows, inserted %.',
          _table, (_manifest_count - _skipped_count), _inserted_count;
      end if;

      _report_tables := _report_tables || jsonb_build_object(
        'name', _table,
        'deleted', _deleted_count,
        'inserted', _inserted_count,
        'skipped', _skipped_count,
        'nulled', _nulled_count
      );

      if _skipped_count > 0 then
        _skipped_by_table := jsonb_set(_skipped_by_table, array[_table], to_jsonb(_skipped_count));
      end if;
    end if;
  end loop;

  -- Generic orphan check for all FKs on restored tables
  for _fk_record in (
    select 
      c.conname,
      n1.nspname as child_schema,
      t1.relname as child_table,
      n2.nspname as parent_schema,
      t2.relname as parent_table,
      (select array_agg(a.attname order by ord) from unnest(c.conkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as child_cols,
      (select array_agg(a.attname order by ord) from unnest(c.confkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as parent_cols
    from pg_constraint c
    join pg_class t1 on c.conrelid = t1.oid
    join pg_namespace n1 on t1.relnamespace = n1.oid
    join pg_class t2 on c.confrelid = t2.oid
    join pg_namespace n2 on t2.relnamespace = n2.oid
    where c.contype = 'f'
      and n1.nspname = 'public'
      and t1.relname in (
        select backup_table_names from public.backup_table_names()
        except
        select backup_protected_tables from public.backup_protected_tables()
      )
  ) loop
    if array_length(_fk_record.child_cols, 1) > 1 then
      raise exception 'Composite foreign keys are not supported by the orphan check: %', _fk_record.conname;
    end if;

    declare
      _child_col text := _fk_record.child_cols[1];
      _parent_col text := _fk_record.parent_cols[1];
      _orphan_count int;
    begin
      execute format(
        'select count(*) from %I.%I c where c.%I is not null and not exists (select 1 from %I.%I p where p.%I = c.%I)',
        _fk_record.child_schema, _fk_record.child_table, _child_col,
        _fk_record.parent_schema, _fk_record.parent_table, _parent_col, _child_col
      ) into _orphan_count;

      if _orphan_count > 0 then
        raise exception 'Restore leaves % dangling references in constraint % on table %', 
          _orphan_count, _fk_record.conname, _fk_record.child_table;
      end if;
    end;
  end loop;

  if _actor is not null then
    if _current_actor_profile.id is not null then
      delete from public.profiles where id = _actor;
      insert into public.profiles select _current_actor_profile.*;
    else
      if not exists (select 1 from public.profiles where id = _actor) then
        insert into public.profiles (id, username, display_name, email)
        select id, raw_user_meta_data->>'username', raw_user_meta_data->>'name', email
        from auth.users where id = _actor;
      end if;
    end if;
    if not exists (select 1 from public.user_roles where user_id = _actor and role = 'admin') then
      insert into public.user_roles (user_id, role) values (_actor, 'admin');
    end if;
  end if;

  select obj->'rows' into _profiles_rows
  from jsonb_array_elements(_tables_arr) obj
  where obj->>'name' = 'profiles';
  
  if coalesce(jsonb_array_length(_profiles_rows), 0) > 0 then
    select count(*) into _orphan_logins
    from auth.users u
    where not exists (
      select 1
      from jsonb_array_elements(_profiles_rows) r
      where (r->>'id') = u.id::text
    );
  end if;

  -- `actor` صريح داخل التقرير، لأن write_audit يقرأ auth.uid() وهي فارغة هنا.
  --
  -- write_audit derives actor_id from auth.uid(), which is NULL on this path:
  -- the restore is always invoked with the service key, so the session carries
  -- no end-user JWT. Leaving it at that would file the audit row for the single
  -- most destructive operation in the product with no record of who ran it. The
  -- caller's uuid is right here in `_actor`, so it goes into the report — which
  -- is also what write_audit stores as `after`.
  _report := jsonb_build_object(
    'tables', _report_tables,
    'skipped_by_table', _skipped_by_table,
    'orphan_logins', _orphan_logins,
    'actor', _actor,
    'restored_at', statement_timestamp()
  );

  perform public.write_audit(
    'backup.restore',
    'backup',
    (case when (_payload->>'archive_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then (_payload->>'archive_id')::uuid else null end),
    null,
    _report,
    'success',
    null
  );

  return _report;
end;
$fn$;
revoke execute on function public.backup_restore(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.backup_restore(jsonb, uuid) to service_role;

