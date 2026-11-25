-- Admin table operations: maintenance requests and expanded CSV imports.

do $$
begin
  create type public.maintenance_priority as enum ('low', 'medium', 'high', 'urgent');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.maintenance_status as enum ('open', 'in_progress', 'completed', 'cancelled');
exception when duplicate_object then null;
end $$;

create sequence if not exists public.maintenance_request_code_seq;

create or replace function public.next_maintenance_request_code()
returns text
language sql
security definer
set search_path = public
as $$ select 'MNT-' || lpad(nextval('public.maintenance_request_code_seq')::text, 6, '0') $$;

revoke all on function public.next_maintenance_request_code() from public;
grant execute on function public.next_maintenance_request_code() to authenticated, service_role;

create table if not exists public.maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  code text unique not null default public.next_maintenance_request_code(),
  company_id uuid not null references public.companies(id) on delete restrict,
  property_id uuid not null references public.properties(id) on delete restrict,
  building_id uuid references public.buildings(id) on delete restrict,
  unit_id uuid references public.units(id) on delete restrict,
  title text not null check (length(trim(title)) > 0),
  description text,
  priority public.maintenance_priority not null default 'medium',
  status public.maintenance_status not null default 'open',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists maintenance_requests_property_id_idx on public.maintenance_requests (property_id);
create index if not exists maintenance_requests_building_id_idx on public.maintenance_requests (building_id);
create index if not exists maintenance_requests_unit_id_idx on public.maintenance_requests (unit_id);
create index if not exists maintenance_requests_status_idx on public.maintenance_requests (status);

drop trigger if exists set_updated_at on public.maintenance_requests;
create trigger set_updated_at before update on public.maintenance_requests
for each row execute function public.tg_set_updated_at();

grant select, insert, update, delete on public.maintenance_requests to authenticated;
grant all on public.maintenance_requests to service_role;

alter table public.maintenance_requests enable row level security;

drop policy if exists maintenance_requests_select_permitted on public.maintenance_requests;
create policy maintenance_requests_select_permitted on public.maintenance_requests
for select to authenticated using (public.has_permission(auth.uid(), 'maintenance.read'));

drop policy if exists maintenance_requests_insert_permitted on public.maintenance_requests;
create policy maintenance_requests_insert_permitted on public.maintenance_requests
for insert to authenticated with check (public.has_permission(auth.uid(), 'maintenance.create'));

drop policy if exists maintenance_requests_update_permitted on public.maintenance_requests;
create policy maintenance_requests_update_permitted on public.maintenance_requests
for update to authenticated using (public.has_permission(auth.uid(), 'maintenance.update'))
with check (public.has_permission(auth.uid(), 'maintenance.update'));

drop policy if exists maintenance_requests_delete_permitted on public.maintenance_requests;
create policy maintenance_requests_delete_permitted on public.maintenance_requests
for delete to authenticated using (public.has_permission(auth.uid(), 'maintenance.delete'));

drop policy if exists maintenance_requests_service_role_all on public.maintenance_requests;
create policy maintenance_requests_service_role_all on public.maintenance_requests
for all to service_role using (true) with check (true);

insert into public.permissions (code, module, action, is_system)
select 'maintenance.' || action, 'maintenance', action, true
from (values ('create'), ('read'), ('update'), ('delete'), ('export')) as actions(action)
on conflict (code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'admin'::public.app_role, permission.code
from public.permissions permission
where permission.module = 'maintenance'
on conflict (role, permission_code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'accountant'::public.app_role, permission.code
from public.permissions permission
where permission.module = 'maintenance'
  and permission.action in ('create', 'read', 'update', 'export')
on conflict (role, permission_code) do nothing;

create or replace function public.bulk_import_phase6(p_entity text, p_rows jsonb, p_created_by uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_count integer;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a JSON array';
  end if;

  if p_entity = 'expenses' then
    insert into public.expenses (code, company_id, class, category_id, payee, amount, currency, property_id,
      building_id, unit_id, cost_center, start_date, end_date, recurrence, expense_date, status, note, created_by)
    select coalesce(nullif(row_data.code, ''), public.next_expense_code()), row_data.company_id,
      coalesce(row_data.class, 'regular_recurring')::public.expense_classes, row_data.category_id, nullif(row_data.payee, ''),
      row_data.amount, coalesce(nullif(row_data.currency, ''), 'KWD'), row_data.property_id, row_data.building_id, row_data.unit_id,
      nullif(row_data.cost_center, ''), row_data.start_date, row_data.end_date, nullif(row_data.recurrence, ''), row_data.expense_date,
      coalesce(nullif(row_data.status, ''), 'approved'), nullif(row_data.note, ''), p_created_by
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, class text, category_id uuid,
      payee text, amount numeric, currency text, property_id uuid, building_id uuid, unit_id uuid,
      cost_center text, start_date date, end_date date, recurrence text, expense_date date, status text, note text);
  elsif p_entity = 'deposits' then
    insert into public.deposits (code, company_id, deposit_date, bank_name, amount, currency, note, status, created_by)
    select coalesce(nullif(row_data.code, ''), public.next_deposit_code()), row_data.company_id, row_data.deposit_date,
      row_data.bank_name, row_data.amount, coalesce(nullif(row_data.currency, ''), 'KWD'), nullif(row_data.note, ''),
      coalesce(nullif(row_data.status, ''), 'confirmed'), p_created_by
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, deposit_date date, bank_name text,
      amount numeric, currency text, note text, status text);
  elsif p_entity = 'tenants' then
    insert into public.tenants (code, company_id, name, category, lifecycle, nationality, preferred_language,
      mobile, whatsapp, email, commercial_name, authorized_manager, owner_name, notes,
      tenant_portal_enabled, reminders_enabled, receipt_visible_to_tenant)
    select coalesce(nullif(row_data.code, ''), public.next_tenant_code()), row_data.company_id, row_data.name,
      coalesce(nullif(row_data.category, ''), 'standard')::public.tenant_categories,
      coalesce(nullif(row_data.lifecycle, ''), 'active')::public.tenant_lifecycle, nullif(row_data.nationality, ''),
      coalesce(nullif(row_data.preferred_language, ''), 'ar')::public.locale_code, nullif(row_data.mobile, ''),
      nullif(row_data.whatsapp, ''), nullif(row_data.email, '')::citext, nullif(row_data.commercial_name, ''),
      nullif(row_data.authorized_manager, ''), nullif(row_data.owner_name, ''), nullif(row_data.notes, ''),
      coalesce(row_data.tenant_portal_enabled, false), coalesce(row_data.reminders_enabled, true),
      coalesce(row_data.receipt_visible_to_tenant, true)
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, name text, category text,
      lifecycle text, nationality text, preferred_language text, mobile text, whatsapp text, email text,
      commercial_name text, authorized_manager text, owner_name text, notes text,
      tenant_portal_enabled boolean, reminders_enabled boolean, receipt_visible_to_tenant boolean);
  elsif p_entity = 'properties' then
    insert into public.properties (code, company_id, name_ar, name_en, type, address_ar, address_en, location_url,
      area, description_ar, description_en, image_url, status)
    select coalesce(nullif(row_data.code, ''), public.next_property_code()), row_data.company_id, row_data.name_ar,
      nullif(row_data.name_en, ''), coalesce(nullif(row_data.type, ''), 'compound')::public.property_types,
      nullif(row_data.address_ar, ''), nullif(row_data.address_en, ''), nullif(row_data.location_url, ''), row_data.area,
      nullif(row_data.description_ar, ''), nullif(row_data.description_en, ''), nullif(row_data.image_url, ''),
      coalesce(nullif(row_data.status, ''), 'active')
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, name_ar text, name_en text, type text,
      address_ar text, address_en text, location_url text, area numeric, description_ar text, description_en text,
      image_url text, status text);
  elsif p_entity = 'buildings' then
    insert into public.buildings (code, property_id, category_id, name_ar, name_en, address_ar, address_en, area,
      floors, image_url, description_ar, description_en, status)
    select coalesce(nullif(row_data.code, ''), public.next_building_code()), row_data.property_id, row_data.category_id,
      row_data.name_ar, nullif(row_data.name_en, ''), nullif(row_data.address_ar, ''), nullif(row_data.address_en, ''),
      row_data.area, row_data.floors, nullif(row_data.image_url, ''), nullif(row_data.description_ar, ''),
      nullif(row_data.description_en, ''), coalesce(nullif(row_data.status, ''), 'active')
    from jsonb_to_recordset(p_rows) as row_data(code text, property_id uuid, category_id uuid, name_ar text,
      name_en text, address_ar text, address_en text, area numeric, floors integer, image_url text,
      description_ar text, description_en text, status text);
  elsif p_entity = 'units' then
    insert into public.units (code, property_id, building_id, name, type, area, status,
      electricity_meter_ownership, default_rent, description_ar, description_en)
    select coalesce(nullif(row_data.code, ''), public.next_unit_code()), row_data.property_id, row_data.building_id,
      row_data.name, coalesce(nullif(row_data.type, ''), 'apartment')::public.unit_types, row_data.area,
      coalesce(nullif(row_data.status, ''), 'available')::public.unit_status,
      coalesce(nullif(row_data.electricity_meter_ownership, ''), 'company_owned')::public.electricity_meter_ownership,
      row_data.default_rent, nullif(row_data.description_ar, ''), nullif(row_data.description_en, '')
    from jsonb_to_recordset(p_rows) as row_data(code text, property_id uuid, building_id uuid, name text,
      type text, area numeric, status text, electricity_meter_ownership text, default_rent numeric,
      description_ar text, description_en text);
  elsif p_entity = 'maintenance' then
    insert into public.maintenance_requests (code, company_id, property_id, building_id, unit_id, title, description,
      priority, status, created_by)
    select coalesce(nullif(row_data.code, ''), public.next_maintenance_request_code()), row_data.company_id,
      row_data.property_id, row_data.building_id, row_data.unit_id, row_data.title, nullif(row_data.description, ''),
      coalesce(nullif(row_data.priority, ''), 'medium')::public.maintenance_priority,
      coalesce(nullif(row_data.status, ''), 'open')::public.maintenance_status, p_created_by
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, property_id uuid, building_id uuid,
      unit_id uuid, title text, description text, priority text, status text);
  else
    raise exception 'Unsupported import entity: %', p_entity;
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.bulk_import_phase6(text, jsonb, uuid) from public, authenticated;
grant execute on function public.bulk_import_phase6(text, jsonb, uuid) to service_role;
