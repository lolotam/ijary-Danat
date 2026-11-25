do $$ begin
  create type public.property_types as enum ('compound', 'building_complex', 'tower', 'villa_compound', 'other');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.electricity_meter_ownership as enum ('company_owned', 'tenant_owned');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.unit_status as enum ('available', 'reserved', 'occupied', 'vacant', 'under_maintenance', 'archived');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.unit_types as enum ('apartment', 'shop', 'office', 'commercial', 'warehouse', 'villa', 'other');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.tenant_categories as enum ('vip', 'uncommitted', 'chronically_distressed', 'standard', 'custom');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.tenant_lifecycle as enum ('active', 'inactive', 'contract_ended', 'blocked');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.tenant_document_types as enum ('civil_id', 'commercial_license', 'power_of_attorney', 'authorized_signature', 'contract', 'payment_evidence', 'other');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.contract_types as enum ('investment', 'lease');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.contract_states as enum ('draft', 'active', 'frozen', 'suspended', 'expired', 'renewed', 'terminated');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.concession_types as enum ('free_months', 'percentage_discount', 'fixed_discount');
exception when duplicate_object then null; end $$;

create sequence if not exists public.property_code_seq;
create sequence if not exists public.building_code_seq;
create sequence if not exists public.unit_code_seq;
create sequence if not exists public.tenant_code_seq;
create sequence if not exists public.contract_code_seq;

create or replace function public.next_property_code()
returns text language sql security definer set search_path = public
as $$ select 'PROP-' || lpad(nextval('public.property_code_seq')::text, 5, '0') $$;
create or replace function public.next_building_code()
returns text language sql security definer set search_path = public
as $$ select 'BLDG-' || lpad(nextval('public.building_code_seq')::text, 5, '0') $$;
create or replace function public.next_unit_code()
returns text language sql security definer set search_path = public
as $$ select 'UNIT-' || lpad(nextval('public.unit_code_seq')::text, 5, '0') $$;
create or replace function public.next_tenant_code()
returns text language sql security definer set search_path = public
as $$ select 'DANA-' || lpad(nextval('public.tenant_code_seq')::text, 6, '0') $$;
create or replace function public.next_contract_code()
returns text language sql security definer set search_path = public
as $$ select 'CON-' || lpad(nextval('public.contract_code_seq')::text, 5, '0') $$;

revoke all on function public.next_property_code() from public;
revoke all on function public.next_building_code() from public;
revoke all on function public.next_unit_code() from public;
revoke all on function public.next_tenant_code() from public;
revoke all on function public.next_contract_code() from public;
grant execute on function public.next_property_code() to authenticated, service_role;
grant execute on function public.next_building_code() to authenticated, service_role;
grant execute on function public.next_unit_code() to authenticated, service_role;
grant execute on function public.next_tenant_code() to authenticated, service_role;
grant execute on function public.next_contract_code() to authenticated, service_role;

create table if not exists public.building_categories (
  id uuid primary key default gen_random_uuid(), code text unique not null,
  name_ar text not null, name_en text not null, is_system boolean not null default false,
  sort_order integer not null default 0, created_at timestamptz not null default now()
);

insert into public.building_categories (code, name_ar, name_en, is_system, sort_order)
values
  ('restaurants_cafes', 'المطاعم والمقاهي', 'Restaurants & Cafes', true, 10),
  ('retail_perfume_clothing_children', 'التجزئة والعطور والملابس ولوازم الأطفال', 'Retail, Perfume, Clothing & Children', true, 20),
  ('health_clubs', 'الأندية الصحية', 'Health Clubs', true, 30),
  ('groceries', 'البقالات والمواد الغذائية', 'Groceries', true, 40),
  ('telecom', 'شركات الاتصالات', 'Telecom Companies', true, 50),
  ('residential', 'سكني', 'Residential', true, 60),
  ('offices', 'مكاتب', 'Offices', true, 70),
  ('warehouses', 'مخازن', 'Warehouses', true, 80),
  ('mixed_use', 'متعدد الاستخدامات', 'Mixed Use', true, 90)
on conflict (code) do nothing;

create table if not exists public.properties (
  id uuid primary key default gen_random_uuid(), code text unique not null default public.next_property_code(),
  name_ar text not null, name_en text, type public.property_types not null default 'compound',
  address_ar text, address_en text, location_url text, area numeric(12,3),
  description_ar text, description_en text, image_url text,
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  company_id uuid references public.companies(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.buildings (
  id uuid primary key default gen_random_uuid(), code text unique not null default public.next_building_code(),
  property_id uuid not null references public.properties(id) on delete restrict,
  category_id uuid references public.building_categories(id) on delete set null,
  name_ar text not null, name_en text, address_ar text, address_en text, area numeric(12,3),
  floors integer, image_url text, description_ar text, description_en text,
  status text not null default 'active' check (status in ('active', 'inactive', 'under_maintenance', 'archived')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.units (
  id uuid primary key default gen_random_uuid(), code text unique not null default public.next_unit_code(),
  property_id uuid not null references public.properties(id) on delete restrict,
  building_id uuid references public.buildings(id) on delete set null, name text not null,
  type public.unit_types not null default 'apartment', area numeric(12,3),
  status public.unit_status not null default 'available',
  electricity_meter_ownership public.electricity_meter_ownership not null default 'company_owned',
  default_rent numeric(14,3), description_ar text, description_en text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(), code text unique not null default public.next_tenant_code(),
  company_id uuid references public.companies(id) on delete set null, name text not null,
  category public.tenant_categories not null default 'standard', lifecycle public.tenant_lifecycle not null default 'active',
  nationality text, preferred_language public.locale_code not null default 'ar', mobile text, whatsapp text, email citext,
  alternate_contacts jsonb, commercial_name text, authorized_manager text, owner_name text,
  reminders_enabled boolean not null default true, receipt_visible_to_tenant boolean not null default false,
  tenant_portal_enabled boolean not null default false, notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

do $$ begin
  alter table public.profiles add constraint profiles_tenant_id_fkey
    foreign key (tenant_id) references public.tenants(id) on delete set null;
exception when duplicate_object then null; end $$;

create table if not exists public.tenant_documents (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id) on delete cascade,
  type public.tenant_document_types not null, storage_path text not null, display_name text,
  mime_type text, size_bytes bigint, uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(), code text unique not null default public.next_contract_code(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  unit_id uuid not null references public.units(id) on delete restrict,
  type public.contract_types not null default 'investment', state public.contract_states not null default 'draft',
  entry_date date, start_date date not null, end_date date not null, duration_months integer,
  end_date_override_reason text, monthly_amount numeric(14,3) not null check (monthly_amount >= 0),
  due_day integer not null default 1 check (due_day between 1 and 28),
  grace_days integer not null default 0 check (grace_days >= 0), deposit numeric(14,3) not null default 0,
  notes text, documents jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create table if not exists public.concessions (
  id uuid primary key default gen_random_uuid(), contract_id uuid not null references public.contracts(id) on delete cascade,
  type public.concession_types not null, free_months integer not null default 0 check (free_months >= 0),
  discount_percent numeric(5,2) check (discount_percent between 0 and 100), discount_amount numeric(14,3),
  start_date date not null, end_date date not null check (end_date >= start_date), reason text,
  status text not null default 'active' check (status in ('active', 'expired', 'cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create index if not exists profiles_tenant_id_idx on public.profiles (tenant_id);
create index if not exists properties_company_id_idx on public.properties (company_id);
create index if not exists properties_code_idx on public.properties (code);
create index if not exists buildings_property_id_idx on public.buildings (property_id);
create index if not exists buildings_code_idx on public.buildings (code);
create index if not exists units_property_id_idx on public.units (property_id);
create index if not exists units_building_id_idx on public.units (building_id);
create index if not exists units_status_idx on public.units (status);
create index if not exists units_code_idx on public.units (code);
create index if not exists tenants_company_id_idx on public.tenants (company_id);
create index if not exists tenants_code_idx on public.tenants (code);
create index if not exists tenants_lifecycle_idx on public.tenants (lifecycle);
create index if not exists tenants_category_idx on public.tenants (category);
create index if not exists tenant_documents_tenant_id_idx on public.tenant_documents (tenant_id);
create index if not exists contracts_tenant_id_idx on public.contracts (tenant_id);
create index if not exists contracts_unit_id_idx on public.contracts (unit_id);
create index if not exists contracts_state_idx on public.contracts (state);
create index if not exists contracts_start_date_idx on public.contracts (start_date);
create index if not exists contracts_end_date_idx on public.contracts (end_date);
create unique index if not exists one_active_contract_per_unit on public.contracts (unit_id)
  where state in ('draft', 'active', 'frozen', 'suspended');
create index if not exists concessions_contract_id_idx on public.concessions (contract_id);

drop trigger if exists set_updated_at on public.properties;
create trigger set_updated_at before update on public.properties for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.buildings;
create trigger set_updated_at before update on public.buildings for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.units;
create trigger set_updated_at before update on public.units for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.tenants;
create trigger set_updated_at before update on public.tenants for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.contracts;
create trigger set_updated_at before update on public.contracts for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.concessions;
create trigger set_updated_at before update on public.concessions for each row execute function public.tg_set_updated_at();

grant select, insert, update, delete on public.building_categories, public.properties, public.buildings,
  public.units, public.tenants, public.tenant_documents, public.contracts, public.concessions to authenticated;
grant all on public.building_categories, public.properties, public.buildings, public.units,
  public.tenants, public.tenant_documents, public.contracts, public.concessions to service_role;

alter table public.building_categories enable row level security;
alter table public.properties enable row level security;
alter table public.buildings enable row level security;
alter table public.units enable row level security;
alter table public.tenants enable row level security;
alter table public.tenant_documents enable row level security;
alter table public.contracts enable row level security;
alter table public.concessions enable row level security;

drop policy if exists building_categories_select_staff on public.building_categories;
create policy building_categories_select_staff on public.building_categories for select to authenticated
  using (public.is_staff(auth.uid()));
drop policy if exists building_categories_write_admin on public.building_categories;
create policy building_categories_write_admin on public.building_categories for all to authenticated
  using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists properties_select_staff on public.properties;
create policy properties_select_staff on public.properties for select to authenticated using (public.is_staff(auth.uid()));
drop policy if exists properties_write_admin on public.properties;
create policy properties_write_admin on public.properties for all to authenticated
  using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists buildings_select_staff on public.buildings;
create policy buildings_select_staff on public.buildings for select to authenticated using (public.is_staff(auth.uid()));
drop policy if exists buildings_write_admin on public.buildings;
create policy buildings_write_admin on public.buildings for all to authenticated
  using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists units_select_staff on public.units;
create policy units_select_staff on public.units for select to authenticated using (public.is_staff(auth.uid()));
drop policy if exists units_write_admin on public.units;
create policy units_write_admin on public.units for all to authenticated
  using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists tenants_select_allowed on public.tenants;
create policy tenants_select_allowed on public.tenants for select to authenticated using (
  public.is_staff(auth.uid()) or exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.tenant_id = tenants.id
  )
);
drop policy if exists tenants_insert_permitted on public.tenants;
create policy tenants_insert_permitted on public.tenants for insert to authenticated
  with check (public.has_permission(auth.uid(), 'tenants.create'));
drop policy if exists tenants_update_permitted on public.tenants;
create policy tenants_update_permitted on public.tenants for update to authenticated
  using (public.has_permission(auth.uid(), 'tenants.update'))
  with check (public.has_permission(auth.uid(), 'tenants.update'));
drop policy if exists tenants_delete_permitted on public.tenants;
create policy tenants_delete_permitted on public.tenants for delete to authenticated
  using (public.has_permission(auth.uid(), 'tenants.delete'));

drop policy if exists tenant_documents_select_allowed on public.tenant_documents;
create policy tenant_documents_select_allowed on public.tenant_documents for select to authenticated using (
  public.is_staff(auth.uid()) or exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.tenant_id = tenant_documents.tenant_id
  )
);
drop policy if exists tenant_documents_insert_permitted on public.tenant_documents;
create policy tenant_documents_insert_permitted on public.tenant_documents for insert to authenticated
  with check (public.has_permission(auth.uid(), 'tenants.update'));
drop policy if exists tenant_documents_update_permitted on public.tenant_documents;
create policy tenant_documents_update_permitted on public.tenant_documents for update to authenticated
  using (public.has_permission(auth.uid(), 'tenants.update'))
  with check (public.has_permission(auth.uid(), 'tenants.update'));
drop policy if exists tenant_documents_delete_permitted on public.tenant_documents;
create policy tenant_documents_delete_permitted on public.tenant_documents for delete to authenticated
  using (public.has_permission(auth.uid(), 'tenants.update'));

drop policy if exists contracts_select_allowed on public.contracts;
create policy contracts_select_allowed on public.contracts for select to authenticated using (
  public.is_staff(auth.uid()) or exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.tenant_id = contracts.tenant_id
  )
);
drop policy if exists contracts_insert_permitted on public.contracts;
create policy contracts_insert_permitted on public.contracts for insert to authenticated
  with check (public.has_permission(auth.uid(), 'contracts.create'));
drop policy if exists contracts_update_permitted on public.contracts;
create policy contracts_update_permitted on public.contracts for update to authenticated
  using (public.has_permission(auth.uid(), 'contracts.update'))
  with check (public.has_permission(auth.uid(), 'contracts.update'));
drop policy if exists contracts_delete_permitted on public.contracts;
create policy contracts_delete_permitted on public.contracts for delete to authenticated
  using (public.has_permission(auth.uid(), 'contracts.delete'));

drop policy if exists concessions_select_allowed on public.concessions;
create policy concessions_select_allowed on public.concessions for select to authenticated using (
  public.is_staff(auth.uid()) or exists (
    select 1 from public.contracts c
    join public.profiles p on p.tenant_id = c.tenant_id
    where c.id = concessions.contract_id and p.id = auth.uid()
  )
);
drop policy if exists concessions_insert_permitted on public.concessions;
create policy concessions_insert_permitted on public.concessions for insert to authenticated
  with check (public.has_permission(auth.uid(), 'contracts.update'));
drop policy if exists concessions_update_permitted on public.concessions;
create policy concessions_update_permitted on public.concessions for update to authenticated
  using (public.has_permission(auth.uid(), 'contracts.update'))
  with check (public.has_permission(auth.uid(), 'contracts.update'));
drop policy if exists concessions_delete_permitted on public.concessions;
create policy concessions_delete_permitted on public.concessions for delete to authenticated
  using (public.has_permission(auth.uid(), 'contracts.update'));

insert into public.permissions (code, module, action, is_system)
select 'buildings.' || action, 'buildings', action, true
from (values ('create'), ('read'), ('update'), ('delete'), ('export')) as actions(action)
on conflict (code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'admin'::public.app_role, p.code from public.permissions p where p.module = 'buildings'
on conflict (role, permission_code) do nothing;

insert into public.role_permissions (role, permission_code)
select role, module || '.read'
from (values
  ('admin'::public.app_role), ('accountant'::public.app_role),
  ('collector'::public.app_role), ('readonly'::public.app_role)
) as roles(role)
cross join (values ('properties'), ('buildings'), ('units'), ('tenants'), ('contracts')) as modules(module)
on conflict (role, permission_code) do nothing;

insert into storage.buckets (id, name, public)
values ('tenant-documents', 'tenant-documents', false)
on conflict (id) do update set public = false;

drop policy if exists tenant_documents_storage_select on storage.objects;
create policy tenant_documents_storage_select on storage.objects for select to authenticated using (
  bucket_id = 'tenant-documents'
  and (storage.foldername(name))[1] = 'companies'
  and (storage.foldername(name))[3] = 'tenants'
  and (
    public.is_staff(auth.uid()) or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.tenant_id::text = (storage.foldername(name))[4]
    )
  )
);

drop policy if exists tenant_documents_storage_insert on storage.objects;
create policy tenant_documents_storage_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'tenant-documents'
  and (storage.foldername(name))[1] = 'companies'
  and (storage.foldername(name))[3] = 'tenants'
  and public.has_permission(auth.uid(), 'tenants.update')
);

drop policy if exists tenant_documents_storage_delete on storage.objects;
create policy tenant_documents_storage_delete on storage.objects for delete to authenticated using (
  bucket_id = 'tenant-documents'
  and (storage.foldername(name))[1] = 'companies'
  and (storage.foldername(name))[3] = 'tenants'
  and public.has_permission(auth.uid(), 'tenants.update')
);
