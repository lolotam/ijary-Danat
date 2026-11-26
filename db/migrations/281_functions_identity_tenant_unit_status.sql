-- 281_functions_identity_tenant_unit_status.sql
-- T033: function audit — tenant lifecycle & unit status helpers.
-- Split from 279_functions_identity.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

------------------------------------------------------------
-- 5. Tenant lifecycle & unit status helpers (company-scoped)
------------------------------------------------------------

/**
 * يعطّل بوابة المستأجر عند عدم وجود عقد نشط له داخل الشركة.
 */
create or replace function public.deactivate_portal_users_without_active_contract()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _tenant uuid := coalesce(old.tenant_id, new.tenant_id);
  _company uuid := coalesce(public.current_company_id(), old.company_id, new.company_id);
begin
  if _tenant is not null and _company is not null and not exists (
    select 1 from public.contracts c
     where c.tenant_id = _tenant
       and c.company_id = _company
       and c.state = 'active'
  ) then
    update public.tenants
       set tenant_portal_enabled = false
     where id = _tenant
       and company_id = _company
       and tenant_portal_enabled;
  end if;
  return coalesce(new, old);
end;
$$;

/**
 * يحسب دورة حياة المستأجر من عقوده ضمن شركته.
 */
create or replace function public.compute_tenant_lifecycle(_tenant uuid, _current public.tenant_lifecycle)
returns public.tenant_lifecycle
language sql
stable
security definer
set search_path = public
as $$
  select case
    when _current = 'blocked' then 'blocked'::public.tenant_lifecycle
    when exists (
      select 1 from public.contracts c
       where c.tenant_id = _tenant
         and c.state = 'active'
         and (
           coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '') not in ('authenticated', 'company_service')
           or c.company_id = public.current_company_id()
         )
    ) then 'active'::public.tenant_lifecycle
    when exists (
      select 1 from public.contracts c
       where c.tenant_id = _tenant
         and c.state <> 'draft'
         and (
           coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '') not in ('authenticated', 'company_service')
           or c.company_id = public.current_company_id()
         )
    ) then 'contract_ended'::public.tenant_lifecycle
    else 'inactive'::public.tenant_lifecycle
  end;
$$;

/**
 * يزامن حالة دورة حياة المستأجر داخل شركته.
 */
create or replace function public.sync_tenant_lifecycle_for(_tenant uuid)
returns public.tenant_lifecycle
language plpgsql
security definer
set search_path = public
as $$
declare
  _company uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  _next public.tenant_lifecycle;
begin
  if _tenant is null then return null; end if;
  if v_eff_role in ('authenticated', 'company_service') and _company is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select public.compute_tenant_lifecycle(t.id, t.lifecycle)
    into _next
    from public.tenants t
   where t.id = _tenant
     and (_company is null or t.company_id = _company);
  if _next is null then return null; end if;

  update public.tenants
     set lifecycle = _next
   where id = _tenant
     and (_company is null or company_id = _company)
     and lifecycle is distinct from _next;
  return _next;
end;
$$;

/**
 * مشغّل يحدّث دورة حياة المستأجر عند تغيّر عقوده.
 */
create or replace function public.tg_contract_sync_tenant_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id then
    perform public.sync_tenant_lifecycle_for(old.tenant_id);
  end if;
  if tg_op = 'DELETE' then
    perform public.sync_tenant_lifecycle_for(old.tenant_id);
  else
    perform public.sync_tenant_lifecycle_for(new.tenant_id);
  end if;
  return coalesce(new, old);
end;
$$;

/**
 * يضبط دورة الحياة الأولية عند إدراج مستأجر جديد.
 */
create or replace function public.tg_tenant_default_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.lifecycle := public.compute_tenant_lifecycle(new.id, new.lifecycle);
  return new;
end;
$$;

/**
 * يوحّد حقول الاسم التجاري للمستأجر قبل الحفظ.
 */
create or replace function public.tg_tenant_commercial_name_compat()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.commercial_name_ar is null and new.commercial_name_en is null
       and nullif(btrim(new.commercial_name), '') is not null then
      new.commercial_name_ar := btrim(new.commercial_name);
    end if;
  else
    if new.commercial_name is distinct from old.commercial_name
       and new.commercial_name_ar is not distinct from old.commercial_name_ar
       and new.commercial_name_en is not distinct from old.commercial_name_en then
      new.commercial_name_ar := nullif(btrim(new.commercial_name), '');
    end if;
  end if;
  new.commercial_name_ar := nullif(btrim(new.commercial_name_ar), '');
  new.commercial_name_en := nullif(btrim(new.commercial_name_en), '');
  new.commercial_name := coalesce(new.commercial_name_ar, new.commercial_name_en);
  return new;
end;
$$;

/**
 * يحظر أو يرفع الحظر عن مستأجر داخل الشركة الحالية.
 */
create or replace function public.set_tenant_blocked(_tenant uuid, _blocked boolean)
returns public.tenant_lifecycle
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  _next public.tenant_lifecycle;
begin
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'tenants.update') then
    raise exception 'Not authorized to change tenant lifecycle' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  if _blocked then
    update public.tenants
       set lifecycle = 'blocked'
     where id = _tenant
       and (v_company_id is null or company_id = v_company_id)
     returning lifecycle into _next;
    return _next;
  end if;

  update public.tenants
     set lifecycle = 'inactive'
   where id = _tenant
     and (v_company_id is null or company_id = v_company_id)
     and lifecycle = 'blocked';
  return public.sync_tenant_lifecycle_for(_tenant);
end;
$$;

/**
 * يتحقق مما إذا كانت الوحدة مرتبطة بعقد نشط غير مؤرشف ضمن شركتها.
 */
create or replace function public.unit_has_active_contract(_unit uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.contract_units cu
      join public.contracts c
        on c.id = cu.contract_id
       and c.company_id = cu.company_id
     where cu.unit_id = _unit
       and c.state = 'active'
       and c.archived_at is null
       and (
         coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '') not in ('authenticated', 'company_service')
         or cu.company_id = public.current_company_id()
       )
  );
$$;

/**
 * يحسب الحالة المشتقة للوحدة بناءً على عقودها النشطة.
 */
create or replace function public.compute_unit_status(_unit uuid, _current public.unit_status)
returns public.unit_status
language sql
stable
security invoker
set search_path = public
as $$
  select case
    when public.unit_has_active_contract(_unit) then 'occupied'::public.unit_status
    when _current in ('under_maintenance', 'archived') then _current
    else 'vacant'::public.unit_status
  end;
$$;

/**
 * يزامن حالة وحدة واحدة مع عقودها ضمن الشركة.
 */
create or replace function public.sync_unit_status_for(_unit uuid)
returns public.unit_status
language plpgsql
security definer
set search_path = public
as $$
declare
  _company uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  _current public.unit_status;
  _next public.unit_status;
begin
  if _unit is null then return null; end if;
  if v_eff_role in ('authenticated', 'company_service') and _company is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select status into _current
    from public.units
   where id = _unit
     and (_company is null or company_id = _company)
   for update;
  if not found then return null; end if;

  _next := public.compute_unit_status(_unit, _current);
  update public.units
     set status = _next
   where id = _unit
     and (_company is null or company_id = _company)
     and status is distinct from _next;
  return _next;
end;
$$;

/**
 * يزامن حالات مجموعة وحدات بترتيب ثابت لتفادي التوقف المتبادل.
 */
create or replace function public.sync_unit_status_many(_units uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _company uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  _unit uuid;
begin
  if v_eff_role in ('authenticated', 'company_service') and _company is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  for _unit in
    select distinct x from unnest(_units) as t(x) where x is not null order by 1
  loop
    perform 1 from public.units
     where id = _unit and (_company is null or company_id = _company)
     for update;
  end loop;
  for _unit in
    select distinct x from unnest(_units) as t(x) where x is not null order by 1
  loop
    perform public.sync_unit_status_for(_unit);
  end loop;
end;
$$;

/**
 * مشغّل يزامن حالات الوحدات عند تغيير حالة العقد أو أرشفته.
 */
create or replace function public.tg_contract_sync_unit_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _company uuid := coalesce(public.current_company_id(), new.company_id);
begin
  perform public.sync_unit_status_many(
    array(
      select cu.unit_id
        from public.contract_units cu
       where cu.contract_id = new.id
         and cu.company_id = _company
    )
  );
  return new;
end;
$$;

revoke execute on function public.tg_contract_sync_unit_status() from public, anon;

/**
 * يفرض اشتقاق حالة الوحدة تلقائياً قبل الحفظ.
 */
create or replace function public.tg_unit_enforce_derived_status()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.status in ('available', 'reserved') then
    new.status := 'vacant';
  end if;
  if public.unit_has_active_contract(new.id) then
    if new.status <> 'occupied' then
      raise exception
        'Unit % has an active contract, so its status is maintained automatically and stays occupied.',
        coalesce(new.code, new.id::text)
        using errcode = 'check_violation';
    end if;
  elsif new.status = 'occupied' then
    new.status := 'vacant';
  end if;
  return new;
end;
$$;
