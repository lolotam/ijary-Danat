-- 261_company_contracts_columns.sql
-- T024 (columns, constraints, FKs, indexes): Renters & Contracts group
--   tenants, tenant_documents, contracts, contract_units,
--   contract_extra_charges, concessions, concession_invoices,
--   commercial_brands, commercial_brand_contracts, contract_operational_events
--   + deferred composite FKs from profiles and user_tenants to tenants(company_id, id).
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
  -- 1. tenants
  ------------------------------------------------------------
  if v_default_company_id is not null then
    update public.tenants
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.tenants drop constraint if exists tenants_company_id_fkey;
  alter table public.tenants
    add constraint tenants_company_id_fkey
    foreign key (company_id) references public.companies(id);

  alter table public.tenants
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.tenants drop constraint if exists tenants_company_id_id_key;
  alter table public.tenants
    add constraint tenants_company_id_id_key unique (company_id, id);

  alter table public.tenants drop constraint if exists tenants_code_key;
  alter table public.tenants drop constraint if exists tenants_company_code_key;
  alter table public.tenants
    add constraint tenants_company_code_key unique (company_id, code);

  create index if not exists tenants_company_lifecycle_idx
    on public.tenants (company_id, lifecycle);

  -- Deferred composite FKs from T021 identity tables now that tenants has unique (company_id, id).
  alter table public.profiles drop constraint if exists profiles_tenant_id_fkey;
  alter table public.profiles drop constraint if exists profiles_company_tenant_fkey;
  alter table public.profiles
    add constraint profiles_company_tenant_fkey
    foreign key (company_id, tenant_id)
    references public.tenants(company_id, id) on delete set null (tenant_id);

  alter table public.user_tenants drop constraint if exists user_tenants_tenant_id_fkey;
  alter table public.user_tenants drop constraint if exists user_tenants_company_tenant_fkey;
  alter table public.user_tenants
    add constraint user_tenants_company_tenant_fkey
    foreign key (company_id, tenant_id)
    references public.tenants(company_id, id) on delete cascade;

  ------------------------------------------------------------
  -- 2. contracts
  ------------------------------------------------------------
  alter table public.contracts
    add column if not exists company_id uuid references public.companies(id);

  update public.contracts c
     set company_id = t.company_id
    from public.tenants t
   where t.id = c.tenant_id
     and c.company_id is null;

  if v_default_company_id is not null then
    update public.contracts
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.contracts
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.contracts drop constraint if exists contracts_company_id_id_key;
  alter table public.contracts
    add constraint contracts_company_id_id_key unique (company_id, id);

  alter table public.contracts drop constraint if exists contracts_code_key;
  alter table public.contracts drop constraint if exists contracts_company_code_key;
  alter table public.contracts
    add constraint contracts_company_code_key unique (company_id, code);

  alter table public.contracts drop constraint if exists contracts_tenant_id_fkey;
  alter table public.contracts drop constraint if exists contracts_company_tenant_fkey;
  alter table public.contracts
    add constraint contracts_company_tenant_fkey
    foreign key (company_id, tenant_id)
    references public.tenants(company_id, id) on delete restrict;

  create index if not exists contracts_company_tenant_idx
    on public.contracts (company_id, tenant_id);
  create index if not exists contracts_company_state_idx
    on public.contracts (company_id, state);
  create index if not exists contracts_company_end_date_idx
    on public.contracts (company_id, end_date);

  ------------------------------------------------------------
  -- 3. tenant_documents
  ------------------------------------------------------------
  alter table public.tenant_documents
    add column if not exists company_id uuid references public.companies(id);

  update public.tenant_documents td
     set company_id = t.company_id
    from public.tenants t
   where t.id = td.tenant_id
     and td.company_id is null;

  if v_default_company_id is not null then
    update public.tenant_documents
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.tenant_documents
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.tenant_documents drop constraint if exists tenant_documents_company_id_id_key;
  alter table public.tenant_documents
    add constraint tenant_documents_company_id_id_key unique (company_id, id);

  alter table public.tenant_documents drop constraint if exists tenant_documents_tenant_id_fkey;
  alter table public.tenant_documents drop constraint if exists tenant_documents_company_tenant_fkey;
  alter table public.tenant_documents
    add constraint tenant_documents_company_tenant_fkey
    foreign key (company_id, tenant_id)
    references public.tenants(company_id, id) on delete cascade;

  alter table public.tenant_documents drop constraint if exists tenant_documents_contract_id_fkey;
  alter table public.tenant_documents drop constraint if exists tenant_documents_company_contract_fkey;
  alter table public.tenant_documents
    add constraint tenant_documents_company_contract_fkey
    foreign key (company_id, contract_id)
    references public.contracts(company_id, id) on delete set null (contract_id);

  create index if not exists tenant_documents_company_tenant_idx
    on public.tenant_documents (company_id, tenant_id);

  ------------------------------------------------------------
  -- 4. contract_units
  ------------------------------------------------------------
  alter table public.contract_units
    add column if not exists company_id uuid references public.companies(id);

  update public.contract_units cu
     set company_id = c.company_id
    from public.contracts c
   where c.id = cu.contract_id
     and cu.company_id is null;

  if v_default_company_id is not null then
    update public.contract_units
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.contract_units
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.contract_units drop constraint if exists contract_units_company_id_id_key;
  alter table public.contract_units
    add constraint contract_units_company_id_id_key unique (company_id, id);

  alter table public.contract_units drop constraint if exists contract_units_contract_id_fkey;
  alter table public.contract_units drop constraint if exists contract_units_company_contract_fkey;
  alter table public.contract_units
    add constraint contract_units_company_contract_fkey
    foreign key (company_id, contract_id)
    references public.contracts(company_id, id) on delete cascade;

  alter table public.contract_units drop constraint if exists contract_units_unit_id_fkey;
  alter table public.contract_units drop constraint if exists contract_units_company_unit_fkey;
  alter table public.contract_units
    add constraint contract_units_company_unit_fkey
    foreign key (company_id, unit_id)
    references public.units(company_id, id) on delete restrict;

  create index if not exists contract_units_company_contract_idx
    on public.contract_units (company_id, contract_id);

  ------------------------------------------------------------
  -- 5. contract_extra_charges
  ------------------------------------------------------------
  alter table public.contract_extra_charges
    add column if not exists company_id uuid references public.companies(id);

  update public.contract_extra_charges cec
     set company_id = c.company_id
    from public.contracts c
   where c.id = cec.contract_id
     and cec.company_id is null;

  if v_default_company_id is not null then
    update public.contract_extra_charges
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.contract_extra_charges
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.contract_extra_charges drop constraint if exists contract_extra_charges_company_id_id_key;
  alter table public.contract_extra_charges
    add constraint contract_extra_charges_company_id_id_key unique (company_id, id);

  alter table public.contract_extra_charges drop constraint if exists contract_extra_charges_contract_id_fkey;
  alter table public.contract_extra_charges drop constraint if exists contract_extra_charges_company_contract_fkey;
  alter table public.contract_extra_charges
    add constraint contract_extra_charges_company_contract_fkey
    foreign key (company_id, contract_id)
    references public.contracts(company_id, id) on delete cascade;

  alter table public.contract_extra_charges drop constraint if exists contract_extra_charges_category_id_fkey;
  alter table public.contract_extra_charges drop constraint if exists contract_extra_charges_company_category_fkey;
  alter table public.contract_extra_charges
    add constraint contract_extra_charges_company_category_fkey
    foreign key (company_id, category_id)
    references public.expense_categories(company_id, id) on delete restrict;

  create index if not exists contract_extra_charges_company_contract_idx
    on public.contract_extra_charges (company_id, contract_id);

  ------------------------------------------------------------
  -- 6. concessions
  ------------------------------------------------------------
  alter table public.concessions
    add column if not exists company_id uuid references public.companies(id);

  update public.concessions cn
     set company_id = c.company_id
    from public.contracts c
   where c.id = cn.contract_id
     and cn.company_id is null;

  if v_default_company_id is not null then
    update public.concessions
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.concessions
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.concessions drop constraint if exists concessions_company_id_id_key;
  alter table public.concessions
    add constraint concessions_company_id_id_key unique (company_id, id);

  alter table public.concessions drop constraint if exists concessions_contract_id_fkey;
  alter table public.concessions drop constraint if exists concessions_company_contract_fkey;
  alter table public.concessions
    add constraint concessions_company_contract_fkey
    foreign key (company_id, contract_id)
    references public.contracts(company_id, id) on delete cascade;

  create index if not exists concessions_company_contract_idx
    on public.concessions (company_id, contract_id);

  ------------------------------------------------------------
  -- 7. concession_invoices (invoice_id composite FK added in 263)
  ------------------------------------------------------------
  alter table public.concession_invoices
    add column if not exists company_id uuid references public.companies(id);

  update public.concession_invoices ci
     set company_id = cn.company_id
    from public.concessions cn
   where cn.id = ci.concession_id
     and ci.company_id is null;

  if v_default_company_id is not null then
    update public.concession_invoices
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.concession_invoices
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.concession_invoices drop constraint if exists concession_invoices_invoice_id_key;
  alter table public.concession_invoices drop constraint if exists concession_invoices_company_invoice_key;
  alter table public.concession_invoices
    add constraint concession_invoices_company_invoice_key unique (company_id, invoice_id);

  alter table public.concession_invoices drop constraint if exists concession_invoices_concession_id_fkey;
  alter table public.concession_invoices drop constraint if exists concession_invoices_company_concession_fkey;
  alter table public.concession_invoices
    add constraint concession_invoices_company_concession_fkey
    foreign key (company_id, concession_id)
    references public.concessions(company_id, id) on delete cascade;

  create index if not exists concession_invoices_company_concession_idx
    on public.concession_invoices (company_id, concession_id);

  ------------------------------------------------------------
  -- 8. commercial_brands (media composite FKs added in 277)
  ------------------------------------------------------------
  alter table public.commercial_brands
    add column if not exists company_id uuid references public.companies(id);

  update public.commercial_brands cb
     set company_id = p.company_id
    from public.properties p
   where p.id = cb.property_id
     and cb.company_id is null;

  if v_default_company_id is not null then
    update public.commercial_brands
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.commercial_brands
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.commercial_brands drop constraint if exists commercial_brands_company_id_id_key;
  alter table public.commercial_brands
    add constraint commercial_brands_company_id_id_key unique (company_id, id);

  alter table public.commercial_brands drop constraint if exists commercial_brands_slug_unique;
  alter table public.commercial_brands drop constraint if exists commercial_brands_company_slug_unique;
  alter table public.commercial_brands
    add constraint commercial_brands_company_slug_unique unique (company_id, property_id, slug);

  alter table public.commercial_brands drop constraint if exists commercial_brands_property_id_fkey;
  alter table public.commercial_brands drop constraint if exists commercial_brands_company_property_fkey;
  alter table public.commercial_brands
    add constraint commercial_brands_company_property_fkey
    foreign key (company_id, property_id)
    references public.properties(company_id, id) on delete cascade;

  alter table public.commercial_brands drop constraint if exists commercial_brands_unit_id_fkey;
  alter table public.commercial_brands drop constraint if exists commercial_brands_company_unit_fkey;
  alter table public.commercial_brands
    add constraint commercial_brands_company_unit_fkey
    foreign key (company_id, unit_id)
    references public.units(company_id, id) on delete set null (unit_id);

  alter table public.commercial_brands drop constraint if exists commercial_brands_category_id_fkey;
  alter table public.commercial_brands drop constraint if exists commercial_brands_company_category_fkey;
  alter table public.commercial_brands
    add constraint commercial_brands_company_category_fkey
    foreign key (company_id, category_id)
    references public.building_categories(company_id, id) on delete set null (category_id);

  create index if not exists commercial_brands_company_property_idx
    on public.commercial_brands (company_id, property_id);

  ------------------------------------------------------------
  -- 9. commercial_brand_contracts
  ------------------------------------------------------------
  alter table public.commercial_brand_contracts
    add column if not exists company_id uuid references public.companies(id);

  update public.commercial_brand_contracts cbc
     set company_id = cb.company_id
    from public.commercial_brands cb
   where cb.id = cbc.brand_id
     and cbc.company_id is null;

  if v_default_company_id is not null then
    update public.commercial_brand_contracts
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.commercial_brand_contracts
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.commercial_brand_contracts drop constraint if exists commercial_brand_contracts_brand_id_fkey;
  alter table public.commercial_brand_contracts drop constraint if exists commercial_brand_contracts_company_brand_fkey;
  alter table public.commercial_brand_contracts
    add constraint commercial_brand_contracts_company_brand_fkey
    foreign key (company_id, brand_id)
    references public.commercial_brands(company_id, id) on delete cascade;

  alter table public.commercial_brand_contracts drop constraint if exists commercial_brand_contracts_contract_id_fkey;
  alter table public.commercial_brand_contracts drop constraint if exists commercial_brand_contracts_company_contract_fkey;
  alter table public.commercial_brand_contracts
    add constraint commercial_brand_contracts_company_contract_fkey
    foreign key (company_id, contract_id)
    references public.contracts(company_id, id) on delete cascade;

  create index if not exists commercial_brand_contracts_company_brand_idx
    on public.commercial_brand_contracts (company_id, brand_id);

  ------------------------------------------------------------
  -- 10. contract_operational_events (closeout_id FK added in 267)
  ------------------------------------------------------------
  alter table public.contract_operational_events
    add column if not exists company_id uuid references public.companies(id);

  update public.contract_operational_events coe
     set company_id = c.company_id
    from public.contracts c
   where c.id = coe.contract_id
     and coe.company_id is null;

  if v_default_company_id is not null then
    update public.contract_operational_events
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.contract_operational_events
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.contract_operational_events drop constraint if exists contract_operational_events_company_id_id_key;
  alter table public.contract_operational_events
    add constraint contract_operational_events_company_id_id_key unique (company_id, id);

  alter table public.contract_operational_events drop constraint if exists contract_operational_events_contract_id_fkey;
  alter table public.contract_operational_events drop constraint if exists contract_operational_events_company_contract_fkey;
  alter table public.contract_operational_events
    add constraint contract_operational_events_company_contract_fkey
    foreign key (company_id, contract_id)
    references public.contracts(company_id, id) on delete cascade;

  alter table public.contract_operational_events drop constraint if exists contract_operational_events_tenant_id_fkey;
  alter table public.contract_operational_events drop constraint if exists contract_operational_events_company_tenant_fkey;
  alter table public.contract_operational_events
    add constraint contract_operational_events_company_tenant_fkey
    foreign key (company_id, tenant_id)
    references public.tenants(company_id, id) on delete set null (tenant_id);

  create index if not exists contract_operational_events_company_contract_idx
    on public.contract_operational_events (company_id, contract_id, occurred_at desc);
end $$;

------------------------------------------------------------
-- Parent derivation triggers (when superuser/SQL tests omit company_id)
------------------------------------------------------------

/**
 * يستنتج `company_id` للجداول التابعة للمستأجر عند غياب القيمة صراحة.
 */
create or replace function public.tg_tenant_child_fill_company_id()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.company_id is null then
    select t.company_id into new.company_id
      from public.tenants t
     where t.id = new.tenant_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_user_tenants_fill_company_id on public.user_tenants;
create trigger trg_user_tenants_fill_company_id
  before insert on public.user_tenants
  for each row execute function public.tg_tenant_child_fill_company_id();

drop trigger if exists trg_contracts_fill_company_id on public.contracts;
create trigger trg_contracts_fill_company_id
  before insert on public.contracts
  for each row execute function public.tg_tenant_child_fill_company_id();

drop trigger if exists trg_tenant_documents_fill_company_id on public.tenant_documents;
create trigger trg_tenant_documents_fill_company_id
  before insert on public.tenant_documents
  for each row execute function public.tg_tenant_child_fill_company_id();

/**
 * يستنتج `company_id` للجداول التابعة للعقد عند غياب القيمة صراحة.
 */
create or replace function public.tg_contract_child_fill_company_id()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.company_id is null then
    select c.company_id into new.company_id
      from public.contracts c
     where c.id = new.contract_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_contract_units_fill_company_id on public.contract_units;
create trigger trg_contract_units_fill_company_id
  before insert on public.contract_units
  for each row execute function public.tg_contract_child_fill_company_id();

drop trigger if exists trg_contract_extra_charges_fill_company_id on public.contract_extra_charges;
create trigger trg_contract_extra_charges_fill_company_id
  before insert on public.contract_extra_charges
  for each row execute function public.tg_contract_child_fill_company_id();

drop trigger if exists trg_concessions_fill_company_id on public.concessions;
create trigger trg_concessions_fill_company_id
  before insert on public.concessions
  for each row execute function public.tg_contract_child_fill_company_id();

drop trigger if exists trg_contract_op_events_fill_company_id on public.contract_operational_events;
create trigger trg_contract_op_events_fill_company_id
  before insert on public.contract_operational_events
  for each row execute function public.tg_contract_child_fill_company_id();

/**
 * يستنتج `company_id` لفواتير الإعفاءات من جدول `concessions` عند غياب القيمة صراحة.
 */
create or replace function public.tg_concession_invoices_fill_company_id()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.company_id is null then
    select cn.company_id into new.company_id
      from public.concessions cn
     where cn.id = new.concession_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_concession_invoices_fill_company_id on public.concession_invoices;
create trigger trg_concession_invoices_fill_company_id
  before insert on public.concession_invoices
  for each row execute function public.tg_concession_invoices_fill_company_id();

drop trigger if exists trg_commercial_brands_fill_company_id on public.commercial_brands;
create trigger trg_commercial_brands_fill_company_id
  before insert on public.commercial_brands
  for each row execute function public.tg_property_child_fill_company_id();

/**
 * يستنتج `company_id` لربط العلامات التجارية بالعقود من جدول `commercial_brands` عند غياب القيمة صراحة.
 */
create or replace function public.tg_brand_contracts_fill_company_id()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.company_id is null then
    select cb.company_id into new.company_id
      from public.commercial_brands cb
     where cb.id = new.brand_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_brand_contracts_fill_company_id on public.commercial_brand_contracts;
create trigger trg_brand_contracts_fill_company_id
  before insert on public.commercial_brand_contracts
  for each row execute function public.tg_brand_contracts_fill_company_id();
