-- 269_company_electricity_columns.sql
-- T028 (Electricity group): add `company_id`, `unique (company_id, id)`,
-- composite FKs, per-company uniques, `company_id`-led indexes, and
-- parent-derived defaults on electricity_tariffs, electricity_meters,
-- meter_readings, and electricity_charges.
-- Idempotent.

------------------------------------------------------------
-- 1. electricity_tariffs
------------------------------------------------------------

alter table public.electricity_tariffs
  add column if not exists company_id uuid;

update public.electricity_tariffs et
   set company_id = public._legacy_single_company_id()
 where et.company_id is null;

alter table public.electricity_tariffs
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.electricity_tariffs drop constraint if exists electricity_tariffs_company_id_fkey;
alter table public.electricity_tariffs
  add constraint electricity_tariffs_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.electricity_tariffs drop constraint if exists electricity_tariffs_company_id_id_key;
alter table public.electricity_tariffs
  add constraint electricity_tariffs_company_id_id_key unique (company_id, id);

alter table public.electricity_tariffs drop constraint if exists electricity_tariffs_code_key;
drop index if exists public.electricity_tariffs_code_key;
alter table public.electricity_tariffs drop constraint if exists electricity_tariffs_company_code_key;
alter table public.electricity_tariffs
  add constraint electricity_tariffs_company_code_key unique (company_id, code);

create index if not exists electricity_tariffs_company_active_idx
  on public.electricity_tariffs (company_id, is_active);

------------------------------------------------------------
-- 2. electricity_meters
------------------------------------------------------------

alter table public.electricity_meters
  add column if not exists company_id uuid;

update public.electricity_meters em
   set company_id = coalesce(
     em.company_id,
     (select u.company_id from public.units u where u.id = em.unit_id),
     (select t.company_id from public.electricity_tariffs t where t.id = em.tariff_id),
     public._legacy_single_company_id()
   )
 where em.company_id is null;

alter table public.electricity_meters
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.electricity_meters drop constraint if exists electricity_meters_company_id_fkey;
alter table public.electricity_meters
  add constraint electricity_meters_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.electricity_meters drop constraint if exists electricity_meters_company_id_id_key;
alter table public.electricity_meters
  add constraint electricity_meters_company_id_id_key unique (company_id, id);

alter table public.electricity_meters drop constraint if exists electricity_meters_company_unit_fkey;
alter table public.electricity_meters
  add constraint electricity_meters_company_unit_fkey
    foreign key (company_id, unit_id) references public.units(company_id, id) on delete cascade;

alter table public.electricity_meters drop constraint if exists electricity_meters_company_tariff_fkey;
alter table public.electricity_meters
  add constraint electricity_meters_company_tariff_fkey
    foreign key (company_id, tariff_id)
    references public.electricity_tariffs(company_id, id) on delete set null (tariff_id);

create index if not exists electricity_meters_company_unit_idx
  on public.electricity_meters (company_id, unit_id);

create or replace function public.tg_electricity_meters_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select u.company_id from public.units u where u.id = new.unit_id),
      (select t.company_id from public.electricity_tariffs t where t.id = new.tariff_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_electricity_meters_default_company on public.electricity_meters;
create trigger trg_electricity_meters_default_company
  before insert on public.electricity_meters
  for each row execute function public.tg_electricity_meters_default_company();

------------------------------------------------------------
-- 3. meter_readings
------------------------------------------------------------

alter table public.meter_readings
  add column if not exists company_id uuid;

update public.meter_readings mr
   set company_id = coalesce(
     mr.company_id,
     (select em.company_id from public.electricity_meters em where em.id = mr.meter_id),
     public._legacy_single_company_id()
   )
 where mr.company_id is null;

alter table public.meter_readings
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.meter_readings drop constraint if exists meter_readings_company_id_fkey;
alter table public.meter_readings
  add constraint meter_readings_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.meter_readings drop constraint if exists meter_readings_company_id_id_key;
alter table public.meter_readings
  add constraint meter_readings_company_id_id_key unique (company_id, id);

alter table public.meter_readings drop constraint if exists meter_readings_company_meter_fkey;
alter table public.meter_readings
  add constraint meter_readings_company_meter_fkey
    foreign key (company_id, meter_id)
    references public.electricity_meters(company_id, id) on delete cascade;

create index if not exists meter_readings_company_meter_idx
  on public.meter_readings (company_id, meter_id);
create index if not exists meter_readings_company_date_idx
  on public.meter_readings (company_id, reading_date desc);

create or replace function public.tg_meter_readings_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select em.company_id from public.electricity_meters em where em.id = new.meter_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_meter_readings_default_company on public.meter_readings;
create trigger trg_meter_readings_default_company
  before insert on public.meter_readings
  for each row execute function public.tg_meter_readings_default_company();

------------------------------------------------------------
-- 4. electricity_charges
------------------------------------------------------------

alter table public.electricity_charges
  add column if not exists company_id uuid;

update public.electricity_charges ec
   set company_id = coalesce(
     ec.company_id,
     (select em.company_id from public.electricity_meters em where em.id = ec.meter_id),
     (select u.company_id from public.units u where u.id = ec.unit_id),
     (select t.company_id from public.tenants t where t.id = ec.tenant_id),
     public._legacy_single_company_id()
   )
 where ec.company_id is null;

alter table public.electricity_charges
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.electricity_charges drop constraint if exists electricity_charges_company_id_fkey;
alter table public.electricity_charges
  add constraint electricity_charges_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.electricity_charges drop constraint if exists electricity_charges_company_id_id_key;
alter table public.electricity_charges
  add constraint electricity_charges_company_id_id_key unique (company_id, id);

alter table public.electricity_charges drop constraint if exists electricity_charges_code_key;
drop index if exists public.electricity_charges_code_key;
alter table public.electricity_charges drop constraint if exists electricity_charges_company_code_key;
alter table public.electricity_charges
  add constraint electricity_charges_company_code_key unique (company_id, code);

alter table public.electricity_charges drop constraint if exists electricity_charges_company_meter_fkey;
alter table public.electricity_charges
  add constraint electricity_charges_company_meter_fkey
    foreign key (company_id, meter_id)
    references public.electricity_meters(company_id, id) on delete restrict;

alter table public.electricity_charges drop constraint if exists electricity_charges_company_unit_fkey;
alter table public.electricity_charges
  add constraint electricity_charges_company_unit_fkey
    foreign key (company_id, unit_id) references public.units(company_id, id) on delete restrict;

alter table public.electricity_charges drop constraint if exists electricity_charges_company_tenant_fkey;
alter table public.electricity_charges
  add constraint electricity_charges_company_tenant_fkey
    foreign key (company_id, tenant_id)
    references public.tenants(company_id, id) on delete set null (tenant_id);

alter table public.electricity_charges drop constraint if exists electricity_charges_company_reading_fkey;
alter table public.electricity_charges
  add constraint electricity_charges_company_reading_fkey
    foreign key (company_id, reading_id)
    references public.meter_readings(company_id, id) on delete set null (reading_id);

create index if not exists electricity_charges_company_unit_idx
  on public.electricity_charges (company_id, unit_id);
create index if not exists electricity_charges_company_tenant_idx
  on public.electricity_charges (company_id, tenant_id);
create index if not exists electricity_charges_company_status_idx
  on public.electricity_charges (company_id, status);
create index if not exists electricity_charges_company_period_idx
  on public.electricity_charges (company_id, period_year desc, period_month desc);

create or replace function public.tg_electricity_charges_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select em.company_id from public.electricity_meters em where em.id = new.meter_id),
      (select u.company_id from public.units u where u.id = new.unit_id),
      (select t.company_id from public.tenants t where t.id = new.tenant_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_electricity_charges_default_company on public.electricity_charges;
create trigger trg_electricity_charges_default_company
  before insert on public.electricity_charges
  for each row execute function public.tg_electricity_charges_default_company();
