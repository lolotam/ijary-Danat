-- 323_company_limits.sql (T126)
--
-- يضيف جداول حدود الشركة (`company_limits`) واستهلاك واتساب الشهري (`company_usage_monthly`)
-- واستهلاك التخزين (`company_storage_usage`)، مع مشغّلات الإنفاذ على الوحدات والموظفين
-- والتخزين ودوال حجز حصة واتساب وإعادة حساب التخزين.
--
-- Per spec.md User Story 7, data-model.md (`company_limits`, `company_usage_monthly`,
-- `company_storage_usage`), and research.md R11:
--   - `company_limits` stores optional per-company ceilings (`null` = unlimited).
--     Company staff and `company_service` may SELECT their own row; only
--     `service_role` writes.
--   - Lowering a limit never deletes existing rows; it only refuses new additions
--     with `LIMIT_UNITS`, `LIMIT_STAFF`, or `LIMIT_STORAGE` (or `false` from
--     `consume_whatsapp_quota()`).
--   - Existing `storage.objects` RLS policies (migration 304) are left untouched;
--     storage enforcement runs via `BEFORE INSERT` trigger and `storage_within_limit()`.
--
-- Rollback:
--   drop trigger if exists company_storage_usage_sync on storage.objects;
--   drop trigger if exists company_storage_limit_insert on storage.objects;
--   drop trigger if exists company_staff_limit_profile on public.profiles;
--   drop trigger if exists company_staff_limit_user_role on public.user_roles;
--   drop trigger if exists company_units_limit_insert on public.units;
--   drop function if exists public.tg_sync_company_storage_usage();
--   drop function if exists public.tg_enforce_storage_limit();
--   drop function if exists public.rebuild_company_storage_usage();
--   drop function if exists public.storage_within_limit(bigint);
--   drop function if exists public.storage_object_bytes(jsonb);
--   drop function if exists public.storage_company_id(text);
--   drop function if exists public.consume_whatsapp_quota();
--   drop function if exists public.tg_enforce_staff_limit_on_profile();
--   drop function if exists public.tg_enforce_staff_limit_on_user_role();
--   drop function if exists public.enforce_staff_limit(uuid, uuid, boolean);
--   drop function if exists public.tg_enforce_unit_limit();
--   drop table if exists public.company_storage_usage;
--   drop table if exists public.company_usage_monthly;
--   drop table if exists public.company_limits;

------------------------------------------------------------
-- 1. Tables & RLS
------------------------------------------------------------

create table if not exists public.company_limits (
  company_id             uuid primary key references public.companies(id) on delete cascade,
  max_units              int check (max_units is null or max_units >= 0),
  max_staff_users        int check (max_staff_users is null or max_staff_users >= 0),
  max_whatsapp_per_month int check (max_whatsapp_per_month is null or max_whatsapp_per_month >= 0),
  max_storage_bytes      bigint check (max_storage_bytes is null or max_storage_bytes >= 0),
  updated_by             uuid references auth.users(id) on delete set null,
  updated_at             timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.company_limits;
create trigger set_updated_at
  before update on public.company_limits
  for each row execute function public.tg_set_updated_at();

alter table public.company_limits enable row level security;
alter table public.company_limits force row level security;

revoke all on public.company_limits from public, anon, authenticated, company_service, service_role;
grant select on public.company_limits to authenticated, company_service;
grant all on public.company_limits to service_role;

drop policy if exists company_limits_select_own on public.company_limits;
create policy company_limits_select_own
  on public.company_limits
  for select
  to authenticated, company_service
  using (
    company_id = (select public.current_company_id())
    and (
      (select auth.role()) = 'company_service'
      or (select public.is_staff((select auth.uid())))
    )
  );

drop policy if exists company_limits_service_role_all on public.company_limits;
create policy company_limits_service_role_all
  on public.company_limits
  for all
  to service_role
  using (true)
  with check (true);

create table if not exists public.company_usage_monthly (
  company_id    uuid not null references public.companies(id) on delete cascade,
  month         date not null,
  whatsapp_sent int not null default 0 check (whatsapp_sent >= 0),
  primary key (company_id, month)
);

alter table public.company_usage_monthly enable row level security;
alter table public.company_usage_monthly force row level security;

revoke all on public.company_usage_monthly from public, anon, authenticated, company_service, service_role;
grant select on public.company_usage_monthly to authenticated, company_service;
grant all on public.company_usage_monthly to service_role;

drop policy if exists company_usage_monthly_select_own on public.company_usage_monthly;
create policy company_usage_monthly_select_own
  on public.company_usage_monthly
  for select
  to authenticated, company_service
  using (
    company_id = (select public.current_company_id())
    and (
      (select auth.role()) = 'company_service'
      or (select public.is_staff((select auth.uid())))
    )
  );

drop policy if exists company_usage_monthly_service_role_all on public.company_usage_monthly;
create policy company_usage_monthly_service_role_all
  on public.company_usage_monthly
  for all
  to service_role
  using (true)
  with check (true);

create table if not exists public.company_storage_usage (
  company_id uuid primary key references public.companies(id) on delete cascade,
  bytes      bigint not null default 0 check (bytes >= 0),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at on public.company_storage_usage;
create trigger set_updated_at
  before update on public.company_storage_usage
  for each row execute function public.tg_set_updated_at();

alter table public.company_storage_usage enable row level security;
alter table public.company_storage_usage force row level security;

revoke all on public.company_storage_usage from public, anon, authenticated, company_service, service_role;
grant select on public.company_storage_usage to authenticated, company_service;
grant all on public.company_storage_usage to service_role;

drop policy if exists company_storage_usage_select_own on public.company_storage_usage;
create policy company_storage_usage_select_own
  on public.company_storage_usage
  for select
  to authenticated, company_service
  using (
    company_id = (select public.current_company_id())
    and (
      (select auth.role()) = 'company_service'
      or (select public.is_staff((select auth.uid())))
    )
  );

drop policy if exists company_storage_usage_service_role_all on public.company_storage_usage;
create policy company_storage_usage_service_role_all
  on public.company_storage_usage
  for all
  to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 2. Units limit trigger (LIMIT_UNITS)
------------------------------------------------------------

/**
 * يمنع إدراج وحدة جديدة عند بلوغ الحد الأقصى للوحدات المحدد للشركة.
 *
 * Advisory-locked per company so concurrent direct inserts or bulk imports
 * serialize cleanly against `max_units`.
 */
create or replace function public.tg_enforce_unit_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := coalesce(new.company_id, public.current_company_id());
  v_max_units  int;
  v_count      int;
begin
  if v_company_id is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('company_limits_units:' || v_company_id::text));

  select cl.max_units
    into v_max_units
    from public.company_limits cl
   where cl.company_id = v_company_id;

  if v_max_units is not null then
    select count(*)::int
      into v_count
      from public.units u
     where u.company_id = v_company_id;

    if v_count >= v_max_units then
      raise exception 'LIMIT_UNITS' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.tg_enforce_unit_limit() from public, anon;

drop trigger if exists company_units_limit_insert on public.units;
create trigger company_units_limit_insert
  before insert on public.units
  for each row execute function public.tg_enforce_unit_limit();

------------------------------------------------------------
-- 3. Staff limit triggers (LIMIT_STAFF)
------------------------------------------------------------

/**
 * يتحقق من عدم تجاوز الحد الأقصى لحسابات الموظفين النشطين عند إضافة موظف أو تفعيله.
 *
 * Excludes `_user_id` from the existing count so granting a second staff role
 * to an already-active staff member does not double-count that person.
 */
create or replace function public.enforce_staff_limit(
  _company_id uuid,
  _user_id uuid,
  _require_active_profile boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := coalesce(_company_id, public.current_company_id());
  v_max_staff  int;
  v_count      int;
begin
  if v_company_id is null or _user_id is null then
    return;
  end if;

  if _require_active_profile then
    if not exists (
      select 1
        from public.profiles p
       where p.id = _user_id
         and p.company_id = v_company_id
         and p.is_active
    ) then
      return;
    end if;
  else
    if not exists (
      select 1
        from public.user_roles ur
       where ur.user_id = _user_id
         and ur.company_id = v_company_id
         and ur.role in ('admin', 'accountant', 'collector', 'readonly')
    ) then
      return;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('company_limits_staff:' || v_company_id::text));

  select cl.max_staff_users
    into v_max_staff
    from public.company_limits cl
   where cl.company_id = v_company_id;

  if v_max_staff is not null then
    select count(distinct p.id)::int
      into v_count
      from public.profiles p
     where p.company_id = v_company_id
       and p.is_active
       and p.id <> _user_id
       and exists (
         select 1
           from public.user_roles ur
          where ur.user_id = p.id
            and ur.company_id = v_company_id
            and ur.role in ('admin', 'accountant', 'collector', 'readonly')
       );

    if v_count >= v_max_staff then
      raise exception 'LIMIT_STAFF' using errcode = 'P0001';
    end if;
  end if;
end;
$$;

revoke all on function public.enforce_staff_limit(uuid, uuid, boolean)
  from public, anon, authenticated, company_service;

/**
 * يفرض حد الموظفين عند منح دور موظف لمستخدم يملك ملفاً نشطاً في الشركة.
 */
create or replace function public.tg_enforce_staff_limit_on_user_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := coalesce(new.company_id, public.current_company_id());
begin
  if new.role in ('admin', 'accountant', 'collector', 'readonly') and (
    tg_op = 'INSERT'
    or old.role not in ('admin', 'accountant', 'collector', 'readonly')
    or old.company_id is distinct from new.company_id
    or old.user_id is distinct from new.user_id
  ) then
    perform public.enforce_staff_limit(v_company_id, new.user_id, true);
  end if;

  return new;
end;
$$;

revoke execute on function public.tg_enforce_staff_limit_on_user_role() from public, anon;

drop trigger if exists company_staff_limit_user_role on public.user_roles;
create trigger company_staff_limit_user_role
  before insert or update of role, company_id, user_id on public.user_roles
  for each row execute function public.tg_enforce_staff_limit_on_user_role();

/**
 * يفرض حد الموظفين عند إنشاء أو تفعيل ملف مستخدم يحمل دور موظف في الشركة.
 */
create or replace function public.tg_enforce_staff_limit_on_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := coalesce(new.company_id, public.current_company_id());
begin
  if new.is_active and (
    tg_op = 'INSERT'
    or not old.is_active
    or old.company_id is distinct from new.company_id
  ) then
    perform public.enforce_staff_limit(v_company_id, new.id, false);
  end if;

  return new;
end;
$$;

revoke execute on function public.tg_enforce_staff_limit_on_profile() from public, anon;

drop trigger if exists company_staff_limit_profile on public.profiles;
create trigger company_staff_limit_profile
  before insert or update of is_active, company_id on public.profiles
  for each row execute function public.tg_enforce_staff_limit_on_profile();

------------------------------------------------------------
-- 4. WhatsApp monthly quota (consume_whatsapp_quota)
------------------------------------------------------------

/**
 * يحجز رسالة واتساب واحدة من الحصة الشهرية للشركة الحالية ذرياً، أو يرجع false عند بلوغ الحد.
 *
 * Uses `Asia/Kuwait` for the calendar month boundary so monthly resets align
 * with company business time.
 */
create or replace function public.consume_whatsapp_quota()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_month      date := date_trunc('month', now() at time zone 'Asia/Kuwait')::date;
  v_max        int;
  v_sent       int := 0;
begin
  if v_company_id is null then
    return false;
  end if;

  perform pg_advisory_xact_lock(
    hashtext('company_limits_whatsapp:' || v_company_id::text || ':' || v_month::text)
  );

  select cl.max_whatsapp_per_month
    into v_max
    from public.company_limits cl
   where cl.company_id = v_company_id;

  if v_max is not null then
    select coalesce(u.whatsapp_sent, 0)
      into v_sent
      from public.company_usage_monthly u
     where u.company_id = v_company_id
       and u.month = v_month;

    if coalesce(v_sent, 0) >= v_max then
      return false;
    end if;
  end if;

  insert into public.company_usage_monthly (company_id, month, whatsapp_sent)
  values (v_company_id, v_month, 1)
  on conflict (company_id, month)
  do update set whatsapp_sent = public.company_usage_monthly.whatsapp_sent + 1;

  return true;
end;
$$;

revoke all on function public.consume_whatsapp_quota() from public, anon, authenticated;
grant execute on function public.consume_whatsapp_quota() to company_service;

------------------------------------------------------------
-- 5. Storage usage tracking & enforcement
------------------------------------------------------------

/**
 * يستخرج معرّف الشركة من مسار كائن التخزين إذا طابق الصيغة `companies/<uuid>/...`.
 */
create or replace function public.storage_company_id(_object_name text)
returns uuid
language sql
immutable
as $$
  select case
    when _object_name is not null
     and split_part(_object_name, '/', 1) = 'companies'
     and split_part(_object_name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(_object_name, '/', 2)::uuid
    else null
  end;
$$;

/**
 * يستخرج حجم كائن التخزين بالبايت من حقل `metadata->>'size'` بأمان.
 */
create or replace function public.storage_object_bytes(_metadata jsonb)
returns bigint
language sql
immutable
as $$
  select case
    when _metadata is not null and (_metadata->>'size') ~ '^[0-9]+$'
    then (_metadata->>'size')::bigint
    else 0::bigint
  end;
$$;

/**
 * يتحقق مما إذا كانت مساحة التخزين الحالية مع الحجم المضاف ضمن الحد المسموح للشركة الحالية.
 */
create or replace function public.storage_within_limit(_added_bytes bigint default 0)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id    uuid := public.current_company_id();
  v_max_bytes     bigint;
  v_current_bytes bigint := 0;
begin
  if v_company_id is null then
    return false;
  end if;

  select cl.max_storage_bytes
    into v_max_bytes
    from public.company_limits cl
   where cl.company_id = v_company_id;

  if v_max_bytes is null then
    return true;
  end if;

  select coalesce(su.bytes, 0)
    into v_current_bytes
    from public.company_storage_usage su
   where su.company_id = v_company_id;

  return (coalesce(v_current_bytes, 0) + greatest(coalesce(_added_bytes, 0), 0)) <= v_max_bytes;
end;
$$;

revoke all on function public.storage_within_limit(bigint) from public, anon;
grant execute on function public.storage_within_limit(bigint)
  to authenticated, company_service, service_role;

/**
 * يعيد حساب إجمالي مساحة التخزين المستخدمة للشركة الحالية من `storage.objects`.
 */
create or replace function public.rebuild_company_storage_usage()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_total      bigint := 0;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('company_limits_storage:' || v_company_id::text));

  select coalesce(sum(public.storage_object_bytes(o.metadata)), 0)::bigint
    into v_total
    from storage.objects o
   where public.storage_company_id(o.name) = v_company_id;

  insert into public.company_storage_usage (company_id, bytes, updated_at)
  values (v_company_id, v_total, now())
  on conflict (company_id)
  do update set bytes = excluded.bytes, updated_at = now();

  return v_total;
end;
$$;

revoke all on function public.rebuild_company_storage_usage() from public, anon, authenticated;
grant execute on function public.rebuild_company_storage_usage() to company_service;

/**
 * يمنع إدراج كائن تخزين جديد إذا تجاوز حجمه مع الاستخدام الحالي حد التخزين للشركة.
 */
create or replace function public.tg_enforce_storage_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id    uuid := public.storage_company_id(new.name);
  v_max_bytes     bigint;
  v_current_bytes bigint := 0;
  v_added_bytes   bigint := public.storage_object_bytes(new.metadata);
begin
  if v_company_id is null then
    if public.current_company_id() is null then
      return new;
    end if;
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('company_limits_storage:' || v_company_id::text));

  select cl.max_storage_bytes
    into v_max_bytes
    from public.company_limits cl
   where cl.company_id = v_company_id;

  if v_max_bytes is not null then
    select coalesce(su.bytes, 0)
      into v_current_bytes
      from public.company_storage_usage su
     where su.company_id = v_company_id;

    if (coalesce(v_current_bytes, 0) + v_added_bytes) > v_max_bytes then
      raise exception 'LIMIT_STORAGE' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.tg_enforce_storage_limit() from public, anon;

drop trigger if exists company_storage_limit_insert on storage.objects;
create trigger company_storage_limit_insert
  before insert on storage.objects
  for each row execute function public.tg_enforce_storage_limit();

/**
 * يحدّث عدّاد `company_storage_usage` عند إضافة أو تعديل أو حذف كائنات التخزين للشركة.
 */
create or replace function public.tg_sync_company_storage_usage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_company uuid := case when tg_op in ('UPDATE', 'DELETE') then public.storage_company_id(old.name) else null end;
  v_new_company uuid := case when tg_op in ('INSERT', 'UPDATE') then public.storage_company_id(new.name) else null end;
  v_old_bytes   bigint := case when tg_op in ('UPDATE', 'DELETE') then public.storage_object_bytes(old.metadata) else 0 end;
  v_new_bytes   bigint := case when tg_op in ('INSERT', 'UPDATE') then public.storage_object_bytes(new.metadata) else 0 end;
begin
  if v_old_company is null and v_new_company is null then
    if public.current_company_id() is null then
      return null;
    end if;
    return null;
  end if;

  if v_old_company is not null and v_old_company is distinct from v_new_company and v_old_bytes > 0 then
    update public.company_storage_usage
       set bytes = greatest(0, bytes - v_old_bytes),
           updated_at = now()
     where company_id = v_old_company;
  end if;

  if v_new_company is not null and v_new_company is not distinct from v_old_company then
    if v_new_bytes <> v_old_bytes and exists (select 1 from public.companies c where c.id = v_new_company) then
      insert into public.company_storage_usage (company_id, bytes, updated_at)
      values (v_new_company, greatest(0, v_new_bytes - v_old_bytes), now())
      on conflict (company_id)
      do update set bytes = greatest(0, public.company_storage_usage.bytes + (v_new_bytes - v_old_bytes)),
                    updated_at = now();
    end if;
  elsif v_new_company is not null and exists (select 1 from public.companies c where c.id = v_new_company) then
    insert into public.company_storage_usage (company_id, bytes, updated_at)
    values (v_new_company, v_new_bytes, now())
    on conflict (company_id)
    do update set bytes = greatest(0, public.company_storage_usage.bytes + v_new_bytes),
                  updated_at = now();
  end if;

  return null;
end;
$$;

revoke execute on function public.tg_sync_company_storage_usage() from public, anon;

drop trigger if exists company_storage_usage_sync on storage.objects;
create trigger company_storage_usage_sync
  after insert or update of name, metadata or delete on storage.objects
  for each row execute function public.tg_sync_company_storage_usage();
