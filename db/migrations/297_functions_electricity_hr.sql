-- 297_functions_electricity_hr.sql
-- T036: function audit — electricity charges and salaries.
-- Split from 282_functions_closeout_electricity_hr.sql (T052l) to keep each migration under 600 lines;
-- T052o: callable functions read the company from `public.current_company_id_strict()`,
-- which raises COMPANY_REQUIRED for an API role with no company. Trigger and internal
-- functions fall back to the row's own company_id; no API role can execute them. Idempotent.

-- يحسب مبلغ الكهرباء وفق التعرفة والشرائح ضمن نطاق شركة المستدعي.
CREATE OR REPLACE FUNCTION public.compute_electricity_amount(p_tariff_id uuid, p_consumption numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_tariff public.electricity_tariffs%rowtype;
  v_tier jsonb;
  v_from numeric;
  v_to numeric;
  v_price numeric;
  v_expected_from numeric := 0;
  v_amount numeric := 0;
  v_open_ended boolean := false;
begin
  if p_consumption is null or p_consumption < 0 then
    raise exception 'Consumption must be zero or positive';
  end if;

  select et.* into v_tariff
    from public.electricity_tariffs et
   where et.id = p_tariff_id
     and (v_caller_company is null or et.company_id = v_caller_company);
  if not found then raise exception 'Electricity tariff not found'; end if;

  if v_tariff.type = 'flat' then return round(v_tariff.unit_price, 3); end if;
  if v_tariff.type = 'per_unit' then return round(p_consumption * v_tariff.unit_price, 3); end if;
  if v_tariff.tiers is null or jsonb_typeof(v_tariff.tiers) <> 'array'
    or jsonb_array_length(v_tariff.tiers) = 0 then
    raise exception 'Tiered tariff requires a non-empty tiers array';
  end if;

  for v_tier in select value from jsonb_array_elements(v_tariff.tiers)
  loop
    if jsonb_typeof(v_tier) <> 'object'
      or jsonb_typeof(v_tier -> 'from_kwh') <> 'number'
      or jsonb_typeof(v_tier -> 'price_per_kwh') <> 'number'
      or not (v_tier ? 'to_kwh')
      or jsonb_typeof(v_tier -> 'to_kwh') not in ('number', 'null') then
      raise exception 'Each tariff tier requires numeric from_kwh and price_per_kwh and a numeric or null to_kwh';
    end if;

    v_from := (v_tier ->> 'from_kwh')::numeric;
    v_price := (v_tier ->> 'price_per_kwh')::numeric;
    v_to := case when jsonb_typeof(v_tier -> 'to_kwh') = 'null'
      then null else (v_tier ->> 'to_kwh')::numeric end;

    if v_open_ended or v_from <> v_expected_from then
      raise exception 'Tariff tiers must be ordered, contiguous, and start at zero';
    end if;
    if v_from < 0 or v_price < 0 or (v_to is not null and v_to <= v_from) then
      raise exception 'Tariff tier boundaries and prices are invalid';
    end if;

    if p_consumption > v_from then
      v_amount := v_amount + (
        case when v_to is null then p_consumption - v_from
          else greatest(0, least(p_consumption, v_to) - v_from) end
      ) * v_price;
    end if;

    if v_to is null then v_open_ended := true; else v_expected_from := v_to; end if;
  end loop;

  if not v_open_ended and p_consumption > v_expected_from then
    raise exception 'Tiered tariff does not cover the supplied consumption';
  end if;
  return round(v_amount, 3);
end;
$function$;

-- يولّد رسوم الكهرباء المسودة للفترة المحددة ضمن نطاق شركة المستدعي.
CREATE OR REPLACE FUNCTION public.generate_electricity_charges(
  p_period_year integer, p_period_month integer, p_unit_id uuid DEFAULT NULL::uuid
)
 RETURNS TABLE(charge_id uuid, code text, unit_id uuid, amount numeric, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_period_start date;
  v_period_end date;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'electricity.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if p_period_year < 2000 or p_period_year > 2200
    or p_period_month < 1 or p_period_month > 12 then
    raise exception 'Electricity charge period is invalid';
  end if;

  v_period_start := make_date(p_period_year, p_period_month, 1);
  v_period_end := (v_period_start + interval '1 month - 1 day')::date;

  return query
  with eligible as (
    select em.company_id, em.id as meter_id, em.unit_id, em.ownership, em.tariff_id,
      mr.id as reading_id, mr.consumption_kwh,
      case when em.ownership = 'tenant_owned' then c.tenant_id else null end as tenant_id,
      et.currency
    from public.electricity_meters em
    join public.meter_readings mr on mr.meter_id = em.id
      and mr.company_id = em.company_id
      and mr.period_year = p_period_year and mr.period_month = p_period_month
    join public.electricity_tariffs et on et.id = em.tariff_id
      and et.company_id = em.company_id and et.is_active
    left join lateral (
      select ct.tenant_id
        from public.contract_units cu
        join public.contracts ct on ct.id = cu.contract_id
       where cu.unit_id = em.unit_id
         and ct.company_id = em.company_id
         and ct.state = 'active'
         and ct.start_date <= v_period_end
         and ct.end_date >= v_period_start
       order by ct.start_date desc, ct.id
       limit 1
    ) c on true
    where em.is_active
      and (v_caller_company is null or em.company_id = v_caller_company)
      and (p_unit_id is null or em.unit_id = p_unit_id)
      and (em.ownership = 'company_owned' or c.tenant_id is not null)
  ), inserted as (
    insert into public.electricity_charges (
      company_id, meter_id, unit_id, tenant_id, reading_id, period_year, period_month,
      consumption_kwh, amount, currency, status
    )
    select e.company_id, e.meter_id, e.unit_id, e.tenant_id, e.reading_id,
      p_period_year, p_period_month, e.consumption_kwh,
      public.compute_electricity_amount(e.tariff_id, e.consumption_kwh),
      e.currency, 'draft'
    from eligible e
    on conflict (meter_id, period_year, period_month) do nothing
    returning electricity_charges.id, electricity_charges.code,
      electricity_charges.unit_id, electricity_charges.amount, electricity_charges.status
  )
  select inserted.id, inserted.code, inserted.unit_id,
    inserted.amount, inserted.status from inserted;
end;
$function$;

-- يحمي قراءات العدادات بعد اعتماد رسومها ويحذف المسودات المتأثرة ضمن الشركة.
CREATE OR REPLACE FUNCTION public.protect_charged_meter_reading()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_old_company uuid := coalesce(public.current_company_id(), old.company_id);
  v_new_company uuid := coalesce(public.current_company_id(), new.company_id);
begin
  if exists (
    select 1 from public.electricity_charges ec
     where ec.meter_id = old.meter_id and ec.company_id = v_old_company
       and ec.status <> 'draft'
       and (ec.period_year, ec.period_month) >= (old.period_year, old.period_month)
  ) then
    raise exception 'Reading cannot change after this or a following charge is finalized';
  end if;
  if tg_op = 'UPDATE'
    and (new.meter_id, new.period_year, new.period_month)
      is distinct from (old.meter_id, old.period_year, old.period_month)
    and exists (
      select 1 from public.electricity_charges ec
       where ec.meter_id = new.meter_id and ec.company_id = v_new_company
         and ec.status <> 'draft'
         and (ec.period_year, ec.period_month) >= (new.period_year, new.period_month)
    ) then
    raise exception 'Reading cannot move before a finalized charge';
  end if;
  if tg_op = 'DELETE' or (
    new.meter_id, new.period_year, new.period_month
  ) is distinct from (old.meter_id, old.period_year, old.period_month) then
    delete from public.electricity_charges ec
     where ec.meter_id = old.meter_id and ec.company_id = v_old_company
       and ec.period_year = old.period_year and ec.period_month = old.period_month
       and ec.status = 'draft';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

-- يحدّث مسودة رسم الكهرباء عند تغيّر القراءة ضمن الشركة.
CREATE OR REPLACE FUNCTION public.refresh_draft_charge_for_reading()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
begin
  update public.electricity_charges ec
     set reading_id = new.id,
         consumption_kwh = new.consumption_kwh,
         amount = public.compute_electricity_amount(em.tariff_id, new.consumption_kwh),
         currency = et.currency
    from public.electricity_meters em
    join public.electricity_tariffs et on et.id = em.tariff_id and et.company_id = v_company_id
   where ec.meter_id = new.meter_id
     and ec.company_id = v_company_id
     and ec.period_year = new.period_year
     and ec.period_month = new.period_month
     and ec.status = 'draft'
     and em.id = new.meter_id
     and em.company_id = v_company_id;
  return null;
end;
$function$;

-- يعيد احتساب القراءة اللاحقة للعداد بعد الإدراج أو التعديل أو الحذف ضمن الشركة.
CREATE OR REPLACE FUNCTION public.sync_following_meter_reading()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id, old.company_id);
  v_old_next uuid;
  v_new_next uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select mr.id into v_old_next
      from public.meter_readings mr
     where mr.meter_id = old.meter_id and mr.company_id = v_company_id
       and (mr.period_year, mr.period_month) > (old.period_year, old.period_month)
     order by mr.period_year, mr.period_month limit 1;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select mr.id into v_new_next
      from public.meter_readings mr
     where mr.meter_id = new.meter_id and mr.company_id = v_company_id
       and (mr.period_year, mr.period_month) > (new.period_year, new.period_month)
     order by mr.period_year, mr.period_month limit 1;
  end if;

  if v_old_next is not null then
    update public.meter_readings set reading = reading where id = v_old_next and company_id = v_company_id;
  end if;
  if v_new_next is not null and v_new_next is distinct from v_old_next then
    update public.meter_readings set reading = reading where id = v_new_next and company_id = v_company_id;
  end if;
  return null;
end;
$function$;

-- يتحقق من صحة إدراج رسم الكهرباء ويربطه بالشركة والوحدة والتعرفة.
CREATE OR REPLACE FUNCTION public.validate_electricity_charge_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
  v_meter public.electricity_meters%rowtype;
  v_reading public.meter_readings%rowtype;
  v_tariff public.electricity_tariffs%rowtype;
  v_tenant_id uuid;
  v_period_start date;
  v_period_end date;
begin
  if new.status <> 'draft' then
    raise exception 'Electricity charges must be created as drafts';
  end if;

  select em.* into v_meter
    from public.electricity_meters em
   where em.id = new.meter_id
     and em.company_id = v_company_id
     and em.is_active;
  if not found then raise exception 'Active electricity meter not found'; end if;

  select mr.* into v_reading
    from public.meter_readings mr
   where mr.id = new.reading_id
     and mr.meter_id = new.meter_id
     and mr.company_id = v_meter.company_id
     and mr.period_year = new.period_year
     and mr.period_month = new.period_month;
  if not found then raise exception 'Matching meter reading not found'; end if;

  select et.* into v_tariff
    from public.electricity_tariffs et
   where et.id = v_meter.tariff_id
     and et.company_id = v_meter.company_id
     and et.is_active;
  if not found then raise exception 'Active electricity tariff not found'; end if;

  v_period_start := make_date(new.period_year, new.period_month, 1);
  v_period_end := (v_period_start + interval '1 month - 1 day')::date;
  if v_meter.ownership = 'tenant_owned' then
    select c.tenant_id into v_tenant_id
      from public.contract_units cu
      join public.contracts c on c.id = cu.contract_id
     where cu.unit_id = v_meter.unit_id
       and c.company_id = v_meter.company_id
       and c.state = 'active'
       and c.start_date <= v_period_end and c.end_date >= v_period_start
     order by c.start_date desc, c.id limit 1;
    if v_tenant_id is null then
      raise exception 'Tenant-owned meter has no active contract for the charge period';
    end if;
  end if;

  new.company_id := v_meter.company_id;
  new.unit_id := v_meter.unit_id;
  new.tenant_id := v_tenant_id;
  new.consumption_kwh := v_reading.consumption_kwh;
  new.amount := public.compute_electricity_amount(v_meter.tariff_id, v_reading.consumption_kwh);
  new.currency := v_tariff.currency;
  return new;
end;
$function$;

-- يولّد مسيّر رواتب الشهر للموظفين النشطين ضمن نطاق الشركة ومفتاح التكرار المحدّث.
CREATE OR REPLACE FUNCTION public.generate_salaries_for_month(
  p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer
)
 RETURNS SETOF salaries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_year integer := coalesce(p_year, extract(year from current_date)::integer);
  v_month integer := coalesce(p_month, extract(month from current_date)::integer);
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'salaries.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_year < 2000 or v_year > 2200 then
    raise exception 'Target year is outside the supported range';
  end if;
  if v_month < 1 or v_month > 12 then
    raise exception 'Target month is outside the supported range';
  end if;

  return query
  insert into public.salaries (company_id, employee_id, year, month, amount)
  select e.company_id, e.id, v_year, v_month, e.salary
    from public.employees e
   where e.is_active
     and (v_caller_company is null or e.company_id = v_caller_company)
   order by e.code
  on conflict (company_id, employee_id, year, month) do nothing
  returning *;
end;
$function$;


REVOKE ALL ON FUNCTION public.protect_charged_meter_reading() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.refresh_draft_charge_for_reading() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_following_meter_reading() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.validate_electricity_charge_insert() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.compute_electricity_amount(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_electricity_amount(uuid, numeric) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.generate_electricity_charges(integer, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_electricity_charges(integer, integer, uuid) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.generate_salaries_for_month(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_salaries_for_month(integer, integer) TO authenticated, company_service, service_role;
