-- 259_company_properties_columns.sql
-- T023 (columns, constraints, FKs, indexes): Properties group
--   properties, buildings, units, maintenance_requests.
-- Idempotent.

do $$
declare
  v_default_company_id uuid;
begin
  select id into v_default_company_id
    from public.companies
   order by created_at asc, id asc
   limit 1;

  ------------------------------------------------------------
  -- 1. properties
  ------------------------------------------------------------
  if v_default_company_id is not null then
    update public.properties
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.properties drop constraint if exists properties_company_id_fkey;
  alter table public.properties
    add constraint properties_company_id_fkey
    foreign key (company_id) references public.companies(id);

  alter table public.properties
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.properties drop constraint if exists properties_company_id_id_key;
  alter table public.properties
    add constraint properties_company_id_id_key unique (company_id, id);

  alter table public.properties drop constraint if exists properties_code_key;
  alter table public.properties drop constraint if exists properties_company_code_key;
  alter table public.properties
    add constraint properties_company_code_key unique (company_id, code);

  create index if not exists properties_company_status_idx
    on public.properties (company_id, status);

  ------------------------------------------------------------
  -- 2. buildings
  ------------------------------------------------------------
  alter table public.buildings
    add column if not exists company_id uuid references public.companies(id);

  update public.buildings b
     set company_id = p.company_id
    from public.properties p
   where p.id = b.property_id
     and b.company_id is null;

  if v_default_company_id is not null then
    update public.buildings
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.buildings
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.buildings drop constraint if exists buildings_company_id_id_key;
  alter table public.buildings
    add constraint buildings_company_id_id_key unique (company_id, id);

  alter table public.buildings drop constraint if exists buildings_code_key;
  alter table public.buildings drop constraint if exists buildings_company_code_key;
  alter table public.buildings
    add constraint buildings_company_code_key unique (company_id, code);

  alter table public.buildings drop constraint if exists buildings_property_id_fkey;
  alter table public.buildings drop constraint if exists buildings_company_property_fkey;
  alter table public.buildings
    add constraint buildings_company_property_fkey
    foreign key (company_id, property_id)
    references public.properties(company_id, id) on delete restrict;

  alter table public.buildings drop constraint if exists buildings_category_id_fkey;
  alter table public.buildings drop constraint if exists buildings_company_category_fkey;
  alter table public.buildings
    add constraint buildings_company_category_fkey
    foreign key (company_id, category_id)
    references public.building_categories(company_id, id) on delete set null (category_id);

  create index if not exists buildings_company_property_idx
    on public.buildings (company_id, property_id);

  ------------------------------------------------------------
  -- 3. units
  ------------------------------------------------------------
  alter table public.units
    add column if not exists company_id uuid references public.companies(id);

  update public.units u
     set company_id = p.company_id
    from public.properties p
   where p.id = u.property_id
     and u.company_id is null;

  if v_default_company_id is not null then
    update public.units
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.units
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.units drop constraint if exists units_company_id_id_key;
  alter table public.units
    add constraint units_company_id_id_key unique (company_id, id);

  alter table public.units drop constraint if exists units_code_key;
  alter table public.units drop constraint if exists units_company_code_key;
  alter table public.units
    add constraint units_company_code_key unique (company_id, code);

  alter table public.units drop constraint if exists units_property_id_fkey;
  alter table public.units drop constraint if exists units_company_property_fkey;
  alter table public.units
    add constraint units_company_property_fkey
    foreign key (company_id, property_id)
    references public.properties(company_id, id) on delete restrict;

  alter table public.units drop constraint if exists units_building_id_fkey;
  alter table public.units drop constraint if exists units_company_building_fkey;
  alter table public.units
    add constraint units_company_building_fkey
    foreign key (company_id, building_id)
    references public.buildings(company_id, id) on delete set null (building_id);

  create index if not exists units_company_property_idx
    on public.units (company_id, property_id);
  create index if not exists units_company_building_idx
    on public.units (company_id, building_id);
  create index if not exists units_company_status_idx
    on public.units (company_id, status);

  ------------------------------------------------------------
  -- 4. maintenance_requests
  ------------------------------------------------------------
  alter table public.maintenance_requests drop constraint if exists maintenance_requests_company_id_fkey;
  alter table public.maintenance_requests
    add constraint maintenance_requests_company_id_fkey
    foreign key (company_id) references public.companies(id);

  alter table public.maintenance_requests
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.maintenance_requests drop constraint if exists maintenance_requests_company_id_id_key;
  alter table public.maintenance_requests
    add constraint maintenance_requests_company_id_id_key unique (company_id, id);

  alter table public.maintenance_requests drop constraint if exists maintenance_requests_code_key;
  alter table public.maintenance_requests drop constraint if exists maintenance_requests_company_code_key;
  alter table public.maintenance_requests
    add constraint maintenance_requests_company_code_key unique (company_id, code);

  alter table public.maintenance_requests drop constraint if exists maintenance_requests_property_id_fkey;
  alter table public.maintenance_requests drop constraint if exists maintenance_requests_company_property_fkey;
  alter table public.maintenance_requests
    add constraint maintenance_requests_company_property_fkey
    foreign key (company_id, property_id)
    references public.properties(company_id, id) on delete restrict;

  alter table public.maintenance_requests drop constraint if exists maintenance_requests_building_id_fkey;
  alter table public.maintenance_requests drop constraint if exists maintenance_requests_company_building_fkey;
  alter table public.maintenance_requests
    add constraint maintenance_requests_company_building_fkey
    foreign key (company_id, building_id)
    references public.buildings(company_id, id) on delete restrict;

  alter table public.maintenance_requests drop constraint if exists maintenance_requests_unit_id_fkey;
  alter table public.maintenance_requests drop constraint if exists maintenance_requests_company_unit_fkey;
  alter table public.maintenance_requests
    add constraint maintenance_requests_company_unit_fkey
    foreign key (company_id, unit_id)
    references public.units(company_id, id) on delete restrict;

  create index if not exists maintenance_requests_company_property_idx
    on public.maintenance_requests (company_id, property_id);
  create index if not exists maintenance_requests_company_status_idx
    on public.maintenance_requests (company_id, status);
end $$;

/**
 * يستنتج `company_id` للمباني والوحدات وطلبات الصيانة من العقار الأب عند غياب القيمة صراحة.
 */
create or replace function public.tg_property_child_fill_company_id()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.company_id is null then
    select p.company_id into new.company_id
      from public.properties p
     where p.id = new.property_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_buildings_fill_company_id on public.buildings;
create trigger trg_buildings_fill_company_id
  before insert on public.buildings
  for each row execute function public.tg_property_child_fill_company_id();

drop trigger if exists trg_units_fill_company_id on public.units;
create trigger trg_units_fill_company_id
  before insert on public.units
  for each row execute function public.tg_property_child_fill_company_id();

drop trigger if exists trg_maintenance_fill_company_id on public.maintenance_requests;
create trigger trg_maintenance_fill_company_id
  before insert on public.maintenance_requests
  for each row execute function public.tg_property_child_fill_company_id();
