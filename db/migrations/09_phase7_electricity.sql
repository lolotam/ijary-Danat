do $$
begin
  create type public.tariff_types as enum ('flat', 'tiered', 'per_unit');
exception when duplicate_object then null;
end $$;

create sequence if not exists public.electricity_charge_code_seq start 1;

create or replace function public.next_electricity_charge_code()
returns text
language sql
security definer
set search_path = public
as $$ select 'ELEC-' || lpad(nextval('public.electricity_charge_code_seq')::text, 7, '0') $$;

revoke all on function public.next_electricity_charge_code() from public;
grant execute on function public.next_electricity_charge_code() to authenticated, service_role;

create table if not exists public.electricity_tariffs (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name_ar text not null,
  name_en text,
  type public.tariff_types not null default 'per_unit',
  unit_price numeric(14,3) not null default 0 check (unit_price >= 0),
  tiers jsonb check (tiers is null or jsonb_typeof(tiers) = 'array'),
  is_active boolean not null default true,
  currency text not null default 'KWD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.electricity_meters (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units(id) on delete cascade,
  meter_number text,
  ownership public.electricity_meter_ownership not null default 'company_owned',
  tariff_id uuid references public.electricity_tariffs(id) on delete set null,
  is_active boolean not null default true,
  installed_at date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.meter_readings (
  id uuid primary key default gen_random_uuid(),
  meter_id uuid not null references public.electricity_meters(id) on delete cascade,
  reading numeric(14,3) not null check (reading >= 0),
  previous_reading numeric(14,3) check (previous_reading is null or previous_reading >= 0),
  consumption_kwh numeric(14,3) not null default 0 check (consumption_kwh >= 0),
  reading_date date not null,
  period_year integer not null check (period_year between 2000 and 2200),
  period_month integer not null check (period_month between 1 and 12),
  read_by uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  unique (meter_id, period_year, period_month)
);

create table if not exists public.electricity_charges (
  id uuid primary key default gen_random_uuid(),
  code text unique not null default public.next_electricity_charge_code(),
  meter_id uuid not null references public.electricity_meters(id) on delete restrict,
  unit_id uuid not null references public.units(id) on delete restrict,
  tenant_id uuid references public.tenants(id) on delete set null,
  reading_id uuid references public.meter_readings(id) on delete set null,
  period_year integer not null check (period_year between 2000 and 2200),
  period_month integer not null check (period_month between 1 and 12),
  consumption_kwh numeric(14,3) not null default 0 check (consumption_kwh >= 0),
  amount numeric(14,3) not null default 0 check (amount >= 0),
  currency text not null default 'KWD',
  status text not null default 'draft' check (status in ('draft', 'issued', 'paid', 'cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (meter_id, period_year, period_month)
);

create unique index if not exists one_active_electricity_meter_per_unit
  on public.electricity_meters (unit_id) where is_active;
create index if not exists electricity_meters_unit_id_idx on public.electricity_meters (unit_id);
create index if not exists meter_readings_meter_id_idx on public.meter_readings (meter_id);
create index if not exists meter_readings_reading_date_idx on public.meter_readings (reading_date desc);
create index if not exists electricity_charges_unit_id_idx on public.electricity_charges (unit_id);
create index if not exists electricity_charges_tenant_id_idx on public.electricity_charges (tenant_id);
create index if not exists electricity_charges_status_idx on public.electricity_charges (status);
create index if not exists electricity_charges_period_idx
  on public.electricity_charges (period_year desc, period_month desc);

drop trigger if exists set_updated_at on public.electricity_tariffs;
create trigger set_updated_at before update on public.electricity_tariffs
for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.electricity_meters;
create trigger set_updated_at before update on public.electricity_meters
for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.electricity_charges;
create trigger set_updated_at before update on public.electricity_charges
for each row execute function public.tg_set_updated_at();

create or replace function public.compute_consumption()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_previous numeric(14,3);
  v_next numeric(14,3);
begin
  select mr.reading into v_previous
  from public.meter_readings mr
  where mr.meter_id = new.meter_id
    and mr.id <> new.id
    and (mr.period_year, mr.period_month) < (new.period_year, new.period_month)
  order by mr.period_year desc, mr.period_month desc
  limit 1;

  select mr.reading into v_next
  from public.meter_readings mr
  where mr.meter_id = new.meter_id
    and mr.id <> new.id
    and (mr.period_year, mr.period_month) > (new.period_year, new.period_month)
  order by mr.period_year, mr.period_month
  limit 1;

  if v_previous is not null and new.reading < v_previous then
    raise exception 'Meter reading cannot be lower than the previous reading';
  end if;
  if v_next is not null and new.reading > v_next then
    raise exception 'Meter reading cannot exceed the following reading';
  end if;

  new.previous_reading := v_previous;
  new.consumption_kwh := case when v_previous is null then 0 else new.reading - v_previous end;
  return new;
end;
$$;

revoke all on function public.compute_consumption() from public;

create or replace function public.sync_following_meter_reading()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_next uuid;
  v_new_next uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select mr.id into v_old_next
    from public.meter_readings mr
    where mr.meter_id = old.meter_id
      and (mr.period_year, mr.period_month) > (old.period_year, old.period_month)
    order by mr.period_year, mr.period_month
    limit 1;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select mr.id into v_new_next
    from public.meter_readings mr
    where mr.meter_id = new.meter_id
      and (mr.period_year, mr.period_month) > (new.period_year, new.period_month)
    order by mr.period_year, mr.period_month
    limit 1;
  end if;

  if v_old_next is not null then
    update public.meter_readings set reading = reading where id = v_old_next;
  end if;
  if v_new_next is not null and v_new_next is distinct from v_old_next then
    update public.meter_readings set reading = reading where id = v_new_next;
  end if;
  return null;
end;
$$;

revoke all on function public.sync_following_meter_reading() from public;

drop trigger if exists compute_consumption on public.meter_readings;
create trigger compute_consumption
before insert or update on public.meter_readings
for each row execute function public.compute_consumption();

drop trigger if exists sync_following_meter_reading on public.meter_readings;
create trigger sync_following_meter_reading
after insert or update of meter_id, reading, period_year, period_month or delete on public.meter_readings
for each row execute function public.sync_following_meter_reading();

grant usage, select on sequence public.electricity_charge_code_seq to authenticated, service_role;
grant select, insert, update, delete on public.electricity_tariffs to authenticated;
grant select, insert, update, delete on public.electricity_meters to authenticated;
grant select, insert, update, delete on public.meter_readings to authenticated;
grant select, insert, update, delete on public.electricity_charges to authenticated;
grant all on public.electricity_tariffs, public.electricity_meters,
  public.meter_readings, public.electricity_charges to service_role;

alter table public.electricity_tariffs enable row level security;
alter table public.electricity_meters enable row level security;
alter table public.meter_readings enable row level security;
alter table public.electricity_charges enable row level security;

drop policy if exists electricity_tariffs_staff_read on public.electricity_tariffs;
create policy electricity_tariffs_staff_read on public.electricity_tariffs
for select to authenticated using (public.is_staff(auth.uid()));
drop policy if exists electricity_tariffs_admin_write on public.electricity_tariffs;
create policy electricity_tariffs_admin_write on public.electricity_tariffs
for all to authenticated using (public.has_role(auth.uid(), 'admin'))
with check (public.has_role(auth.uid(), 'admin'));
drop policy if exists electricity_tariffs_service_role_all on public.electricity_tariffs;
create policy electricity_tariffs_service_role_all on public.electricity_tariffs
for all to service_role using (true) with check (true);

drop policy if exists electricity_meters_staff_read on public.electricity_meters;
create policy electricity_meters_staff_read on public.electricity_meters
for select to authenticated using (public.is_staff(auth.uid()));
drop policy if exists electricity_meters_admin_write on public.electricity_meters;
create policy electricity_meters_admin_write on public.electricity_meters
for all to authenticated using (public.has_role(auth.uid(), 'admin'))
with check (public.has_role(auth.uid(), 'admin'));
drop policy if exists electricity_meters_service_role_all on public.electricity_meters;
create policy electricity_meters_service_role_all on public.electricity_meters
for all to service_role using (true) with check (true);

drop policy if exists meter_readings_staff_read on public.meter_readings;
create policy meter_readings_staff_read on public.meter_readings
for select to authenticated using (public.is_staff(auth.uid()));
drop policy if exists meter_readings_insert_permitted on public.meter_readings;
create policy meter_readings_insert_permitted on public.meter_readings
for insert to authenticated with check (public.has_permission(auth.uid(), 'electricity.create'));
drop policy if exists meter_readings_update_permitted on public.meter_readings;
create policy meter_readings_update_permitted on public.meter_readings
for update to authenticated using (public.has_permission(auth.uid(), 'electricity.update'))
with check (public.has_permission(auth.uid(), 'electricity.update'));
drop policy if exists meter_readings_delete_permitted on public.meter_readings;
create policy meter_readings_delete_permitted on public.meter_readings
for delete to authenticated using (public.has_permission(auth.uid(), 'electricity.delete'));
drop policy if exists meter_readings_service_role_all on public.meter_readings;
create policy meter_readings_service_role_all on public.meter_readings
for all to service_role using (true) with check (true);

drop policy if exists electricity_charges_select_allowed on public.electricity_charges;
create policy electricity_charges_select_allowed on public.electricity_charges
for select to authenticated using (
  public.is_staff(auth.uid()) or (
    status = 'issued' and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.tenant_id = electricity_charges.tenant_id
    )
  )
);
drop policy if exists electricity_charges_insert_permitted on public.electricity_charges;
create policy electricity_charges_insert_permitted on public.electricity_charges
for insert to authenticated with check (public.has_permission(auth.uid(), 'electricity.create'));
drop policy if exists electricity_charges_update_permitted on public.electricity_charges;
create policy electricity_charges_update_permitted on public.electricity_charges
for update to authenticated using (public.has_permission(auth.uid(), 'electricity.update'))
with check (public.has_permission(auth.uid(), 'electricity.update'));
drop policy if exists electricity_charges_delete_permitted on public.electricity_charges;
create policy electricity_charges_delete_permitted on public.electricity_charges
for delete to authenticated using (public.has_permission(auth.uid(), 'electricity.delete'));
drop policy if exists electricity_charges_service_role_all on public.electricity_charges;
create policy electricity_charges_service_role_all on public.electricity_charges
for all to service_role using (true) with check (true);

insert into public.permissions (code, module, action, is_system)
select 'electricity.' || action, 'electricity', action, true
from (values ('create'), ('read'), ('update'), ('delete'), ('export')) as actions(action)
on conflict (code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'admin'::public.app_role, p.code
from public.permissions p where p.module = 'electricity'
on conflict (role, permission_code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'accountant'::public.app_role, p.code
from public.permissions p
where p.module = 'electricity' and p.action in ('create', 'read', 'update', 'export')
on conflict (role, permission_code) do nothing;

insert into public.electricity_tariffs (
  code, name_ar, name_en, type, unit_price, is_active, currency
) values (
  'DEFAULT-PER-KWH', 'التعرفة الافتراضية لكل كيلوواط ساعة',
  'Default per kWh tariff', 'per_unit', 0, true, 'KWD'
)
on conflict (code) do nothing;

create or replace function public.compute_electricity_amount(
  p_tariff_id uuid,
  p_consumption numeric
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
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
  from public.electricity_tariffs et where et.id = p_tariff_id;
  if not found then raise exception 'Electricity tariff not found'; end if;

  if v_tariff.type = 'flat' then
    return round(v_tariff.unit_price, 3);
  end if;
  if v_tariff.type = 'per_unit' then
    return round(p_consumption * v_tariff.unit_price, 3);
  end if;
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

    if v_to is null then
      v_open_ended := true;
    else
      v_expected_from := v_to;
    end if;
  end loop;

  if not v_open_ended and p_consumption > v_expected_from then
    raise exception 'Tiered tariff does not cover the supplied consumption';
  end if;
  return round(v_amount, 3);
end;
$$;

revoke all on function public.compute_electricity_amount(uuid, numeric) from public;
grant execute on function public.compute_electricity_amount(uuid, numeric) to authenticated, service_role;

create or replace function public.validate_electricity_charge_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
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

  select em.* into v_meter from public.electricity_meters em
  where em.id = new.meter_id and em.is_active;
  if not found then raise exception 'Active electricity meter not found'; end if;

  select mr.* into v_reading from public.meter_readings mr
  where mr.id = new.reading_id and mr.meter_id = new.meter_id
    and mr.period_year = new.period_year and mr.period_month = new.period_month;
  if not found then raise exception 'Matching meter reading not found'; end if;

  select et.* into v_tariff from public.electricity_tariffs et
  where et.id = v_meter.tariff_id and et.is_active;
  if not found then raise exception 'Active electricity tariff not found'; end if;

  v_period_start := make_date(new.period_year, new.period_month, 1);
  v_period_end := (v_period_start + interval '1 month - 1 day')::date;
  if v_meter.ownership = 'tenant_owned' then
    select c.tenant_id into v_tenant_id
    from public.contracts c
    where c.unit_id = v_meter.unit_id and c.state = 'active'
      and c.start_date <= v_period_end and c.end_date >= v_period_start
    order by c.start_date desc, c.id
    limit 1;
    if v_tenant_id is null then
      raise exception 'Tenant-owned meter has no active contract for the charge period';
    end if;
  end if;

  new.unit_id := v_meter.unit_id;
  new.tenant_id := v_tenant_id;
  new.consumption_kwh := v_reading.consumption_kwh;
  new.amount := public.compute_electricity_amount(v_meter.tariff_id, v_reading.consumption_kwh);
  new.currency := v_tariff.currency;
  return new;
end;
$$;

create or replace function public.enforce_electricity_charge_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Only draft electricity charges can be deleted';
    end if;
    return old;
  end if;
  if row(new.code, new.meter_id, new.unit_id, new.tenant_id, new.reading_id,
    new.period_year, new.period_month, new.consumption_kwh, new.amount,
    new.currency, new.created_at) is distinct from
    row(old.code, old.meter_id, old.unit_id, old.tenant_id, old.reading_id,
    old.period_year, old.period_month, old.consumption_kwh, old.amount,
    old.currency, old.created_at) then
    raise exception 'Electricity charge source and amount fields are immutable';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'draft' and new.status in ('issued', 'cancelled'))
    or (old.status = 'issued' and new.status in ('paid', 'cancelled'))
  ) then
    raise exception 'Invalid electricity charge status transition';
  end if;
  return new;
end;
$$;

create or replace function public.protect_charged_meter_reading()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.electricity_charges ec
    where ec.meter_id = old.meter_id and ec.status <> 'draft'
      and (ec.period_year, ec.period_month) >= (old.period_year, old.period_month)
  ) then
    raise exception 'Reading cannot change after this or a following charge is finalized';
  end if;
  if tg_op = 'UPDATE'
    and (new.meter_id, new.period_year, new.period_month)
      is distinct from (old.meter_id, old.period_year, old.period_month)
    and exists (
      select 1 from public.electricity_charges ec
      where ec.meter_id = new.meter_id and ec.status <> 'draft'
        and (ec.period_year, ec.period_month) >= (new.period_year, new.period_month)
    ) then
    raise exception 'Reading cannot move before a finalized charge';
  end if;
  if tg_op = 'DELETE' or (
    new.meter_id, new.period_year, new.period_month
  ) is distinct from (
    old.meter_id, old.period_year, old.period_month
  ) then
    delete from public.electricity_charges ec
    where ec.meter_id = old.meter_id and ec.period_year = old.period_year
      and ec.period_month = old.period_month and ec.status = 'draft';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.refresh_draft_charge_for_reading()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.electricity_charges ec
  set reading_id = new.id,
    consumption_kwh = new.consumption_kwh,
    amount = public.compute_electricity_amount(em.tariff_id, new.consumption_kwh),
    currency = et.currency
  from public.electricity_meters em
  join public.electricity_tariffs et on et.id = em.tariff_id
  where ec.meter_id = new.meter_id and ec.period_year = new.period_year
    and ec.period_month = new.period_month and ec.status = 'draft'
    and em.id = new.meter_id;
  return null;
end;
$$;

revoke all on function public.validate_electricity_charge_insert() from public;
revoke all on function public.enforce_electricity_charge_integrity() from public;
revoke all on function public.protect_charged_meter_reading() from public;
revoke all on function public.refresh_draft_charge_for_reading() from public;

drop trigger if exists validate_electricity_charge_insert on public.electricity_charges;
create trigger validate_electricity_charge_insert
before insert on public.electricity_charges
for each row execute function public.validate_electricity_charge_insert();

drop trigger if exists enforce_electricity_charge_integrity on public.electricity_charges;
create trigger enforce_electricity_charge_integrity
before update or delete on public.electricity_charges
for each row execute function public.enforce_electricity_charge_integrity();

drop trigger if exists protect_charged_meter_reading on public.meter_readings;
create trigger protect_charged_meter_reading
before update of meter_id, reading, period_year, period_month or delete on public.meter_readings
for each row execute function public.protect_charged_meter_reading();

drop trigger if exists refresh_draft_charge_for_reading on public.meter_readings;
create trigger refresh_draft_charge_for_reading
after insert or update of meter_id, reading, period_year, period_month on public.meter_readings
for each row execute function public.refresh_draft_charge_for_reading();

create or replace function public.generate_electricity_charges(
  p_period_year integer,
  p_period_month integer,
  p_unit_id uuid default null
)
returns table (
  charge_id uuid,
  code text,
  unit_id uuid,
  amount numeric,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
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
    select em.id as meter_id, em.unit_id, em.ownership, em.tariff_id,
      mr.id as reading_id, mr.consumption_kwh,
      case when em.ownership = 'tenant_owned' then c.tenant_id else null end as tenant_id,
      et.currency
    from public.electricity_meters em
    join public.meter_readings mr on mr.meter_id = em.id
      and mr.period_year = p_period_year and mr.period_month = p_period_month
    join public.electricity_tariffs et on et.id = em.tariff_id and et.is_active
    left join lateral (
      select contracts.tenant_id
      from public.contracts
      where contracts.unit_id = em.unit_id
        and contracts.state = 'active'
        and contracts.start_date <= v_period_end
        and contracts.end_date >= v_period_start
      order by contracts.start_date desc, contracts.id
      limit 1
    ) c on true
    where em.is_active and (p_unit_id is null or em.unit_id = p_unit_id)
      and (em.ownership = 'company_owned' or c.tenant_id is not null)
  ), inserted as (
    insert into public.electricity_charges (
      meter_id, unit_id, tenant_id, reading_id, period_year, period_month,
      consumption_kwh, amount, currency, status
    )
    select e.meter_id, e.unit_id, e.tenant_id, e.reading_id,
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
$$;

revoke all on function public.generate_electricity_charges(integer, integer, uuid) from public;
grant execute on function public.generate_electricity_charges(integer, integer, uuid)
to authenticated, service_role;
