-- 265_company_ledgers_columns.sql
-- T026 (Ledgers group): tighten `company_id`, add `unique (company_id, id)`,
-- composite FKs (including payments -> deposits/partial_payments), per-company
-- uniques, `company_id`-led indexes, and parent-derived defaults on deposits,
-- partial_payments, insurance_payments, refunds, and expenses.
-- Idempotent.

------------------------------------------------------------
-- 1. deposits
------------------------------------------------------------

alter table public.deposits
  drop constraint if exists deposits_company_id_fkey;

update public.deposits d
   set company_id = coalesce(
     d.company_id,
     (select c.company_id from public.contracts c where c.id = d.contract_id),
     (select i.company_id from public.invoices i where i.id = d.invoice_id),
     public._legacy_single_company_id()
   )
 where d.company_id is null;

alter table public.deposits
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.deposits
  add constraint deposits_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.deposits drop constraint if exists deposits_company_id_id_key;
alter table public.deposits add constraint deposits_company_id_id_key unique (company_id, id);

alter table public.deposits drop constraint if exists deposits_code_key;
drop index if exists public.deposits_code_key;
alter table public.deposits drop constraint if exists deposits_company_code_key;
alter table public.deposits add constraint deposits_company_code_key unique (company_id, code);

alter table public.deposits drop constraint if exists deposits_company_contract_fkey;
alter table public.deposits
  add constraint deposits_company_contract_fkey
    foreign key (company_id, contract_id) references public.contracts(company_id, id) on delete restrict;

alter table public.deposits drop constraint if exists deposits_company_invoice_fkey;
alter table public.deposits
  add constraint deposits_company_invoice_fkey
    foreign key (company_id, invoice_id) references public.invoices(company_id, id) on delete restrict;

create index if not exists deposits_company_status_idx on public.deposits (company_id, status);
create index if not exists deposits_company_date_idx on public.deposits (company_id, deposit_date desc);
create index if not exists deposits_company_contract_idx on public.deposits (company_id, contract_id);

create or replace function public.tg_deposits_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select c.company_id from public.contracts c where c.id = new.contract_id),
      (select i.company_id from public.invoices i where i.id = new.invoice_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_deposits_default_company on public.deposits;
create trigger trg_deposits_default_company
  before insert on public.deposits
  for each row execute function public.tg_deposits_default_company();

------------------------------------------------------------
-- 2. partial_payments
------------------------------------------------------------

alter table public.partial_payments
  drop constraint if exists partial_payments_company_id_fkey;

update public.partial_payments pp
   set company_id = coalesce(
     pp.company_id,
     (select c.company_id from public.contracts c where c.id = pp.contract_id),
     (select t.company_id from public.tenants t where t.id = pp.tenant_id),
     (select i.company_id from public.invoices i where i.id = pp.invoice_id),
     public._legacy_single_company_id()
   )
 where pp.company_id is null;

alter table public.partial_payments
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.partial_payments
  add constraint partial_payments_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.partial_payments drop constraint if exists partial_payments_company_id_id_key;
alter table public.partial_payments
  add constraint partial_payments_company_id_id_key unique (company_id, id);

alter table public.partial_payments drop constraint if exists partial_payments_company_contract_fkey;
alter table public.partial_payments
  add constraint partial_payments_company_contract_fkey
    foreign key (company_id, contract_id) references public.contracts(company_id, id) on delete restrict;

alter table public.partial_payments drop constraint if exists partial_payments_company_tenant_fkey;
alter table public.partial_payments
  add constraint partial_payments_company_tenant_fkey
    foreign key (company_id, tenant_id) references public.tenants(company_id, id) on delete restrict;

alter table public.partial_payments drop constraint if exists partial_payments_company_invoice_fkey;
alter table public.partial_payments
  add constraint partial_payments_company_invoice_fkey
    foreign key (company_id, invoice_id)
    references public.invoices(company_id, id) on delete set null (invoice_id);

alter table public.partial_payments drop constraint if exists partial_payments_company_unit_fkey;
alter table public.partial_payments
  add constraint partial_payments_company_unit_fkey
    foreign key (company_id, unit_id)
    references public.units(company_id, id) on delete set null (unit_id);

alter table public.partial_payments drop constraint if exists partial_payments_company_building_fkey;
alter table public.partial_payments
  add constraint partial_payments_company_building_fkey
    foreign key (company_id, building_id)
    references public.buildings(company_id, id) on delete set null (building_id);

create index if not exists partial_payments_company_tenant_idx
  on public.partial_payments (company_id, tenant_id);
create index if not exists partial_payments_company_invoice_idx
  on public.partial_payments (company_id, invoice_id);
create index if not exists partial_payments_company_status_idx
  on public.partial_payments (company_id, status);

create or replace function public.tg_partial_payments_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select c.company_id from public.contracts c where c.id = new.contract_id),
      (select t.company_id from public.tenants t where t.id = new.tenant_id),
      (select i.company_id from public.invoices i where i.id = new.invoice_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_partial_payments_default_company on public.partial_payments;
create trigger trg_partial_payments_default_company
  before insert on public.partial_payments
  for each row execute function public.tg_partial_payments_default_company();

-- Complete cross-company FKs from `payments` to `deposits` and `partial_payments`.
alter table public.payments drop constraint if exists payments_company_source_deposit_fkey;
alter table public.payments
  add constraint payments_company_source_deposit_fkey
    foreign key (company_id, source_deposit_id)
    references public.deposits(company_id, id) on delete restrict;

alter table public.payments drop constraint if exists payments_company_source_partial_payment_fkey;
alter table public.payments
  add constraint payments_company_source_partial_payment_fkey
    foreign key (company_id, source_partial_payment_id)
    references public.partial_payments(company_id, id) on delete restrict;

------------------------------------------------------------
-- 3. insurance_payments
------------------------------------------------------------

alter table public.insurance_payments
  drop constraint if exists insurance_payments_company_id_fkey;

update public.insurance_payments ip
   set company_id = coalesce(
     ip.company_id,
     (select c.company_id from public.contracts c where c.id = ip.contract_id),
     (select t.company_id from public.tenants t where t.id = ip.tenant_id),
     public._legacy_single_company_id()
   )
 where ip.company_id is null;

alter table public.insurance_payments
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.insurance_payments
  add constraint insurance_payments_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.insurance_payments drop constraint if exists insurance_payments_company_id_id_key;
alter table public.insurance_payments
  add constraint insurance_payments_company_id_id_key unique (company_id, id);

alter table public.insurance_payments drop constraint if exists insurance_payments_company_contract_fkey;
alter table public.insurance_payments
  add constraint insurance_payments_company_contract_fkey
    foreign key (company_id, contract_id) references public.contracts(company_id, id) on delete cascade;

alter table public.insurance_payments drop constraint if exists insurance_payments_company_tenant_fkey;
alter table public.insurance_payments
  add constraint insurance_payments_company_tenant_fkey
    foreign key (company_id, tenant_id) references public.tenants(company_id, id) on delete restrict;

alter table public.insurance_payments drop constraint if exists insurance_payments_company_unit_fkey;
alter table public.insurance_payments
  add constraint insurance_payments_company_unit_fkey
    foreign key (company_id, unit_id)
    references public.units(company_id, id) on delete set null (unit_id);

alter table public.insurance_payments drop constraint if exists insurance_payments_company_building_fkey;
alter table public.insurance_payments
  add constraint insurance_payments_company_building_fkey
    foreign key (company_id, building_id)
    references public.buildings(company_id, id) on delete set null (building_id);

create index if not exists insurance_payments_company_tenant_idx
  on public.insurance_payments (company_id, tenant_id);

create or replace function public.tg_insurance_payments_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select c.company_id from public.contracts c where c.id = new.contract_id),
      (select t.company_id from public.tenants t where t.id = new.tenant_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_insurance_payments_default_company on public.insurance_payments;
create trigger trg_insurance_payments_default_company
  before insert on public.insurance_payments
  for each row execute function public.tg_insurance_payments_default_company();

------------------------------------------------------------
-- 4. refunds
------------------------------------------------------------

alter table public.refunds
  drop constraint if exists refunds_company_id_fkey;

update public.refunds r
   set company_id = coalesce(
     r.company_id,
     (select c.company_id from public.contracts c where c.id = r.contract_id),
     (select t.company_id from public.tenants t where t.id = r.tenant_id),
     public._legacy_single_company_id()
   )
 where r.company_id is null;

alter table public.refunds
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.refunds
  add constraint refunds_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.refunds drop constraint if exists refunds_company_id_id_key;
alter table public.refunds add constraint refunds_company_id_id_key unique (company_id, id);

drop index if exists public.refunds_code_uidx;
alter table public.refunds drop constraint if exists refunds_company_code_key;
alter table public.refunds add constraint refunds_company_code_key unique (company_id, code);

alter table public.refunds drop constraint if exists refunds_company_contract_fkey;
alter table public.refunds
  add constraint refunds_company_contract_fkey
    foreign key (company_id, contract_id) references public.contracts(company_id, id) on delete restrict;

alter table public.refunds drop constraint if exists refunds_company_tenant_fkey;
alter table public.refunds
  add constraint refunds_company_tenant_fkey
    foreign key (company_id, tenant_id) references public.tenants(company_id, id) on delete restrict;

alter table public.refunds drop constraint if exists refunds_company_unit_fkey;
alter table public.refunds
  add constraint refunds_company_unit_fkey
    foreign key (company_id, unit_id)
    references public.units(company_id, id) on delete set null (unit_id);

alter table public.refunds drop constraint if exists refunds_company_building_fkey;
alter table public.refunds
  add constraint refunds_company_building_fkey
    foreign key (company_id, building_id)
    references public.buildings(company_id, id) on delete set null (building_id);

alter table public.refunds drop constraint if exists refunds_company_reversal_of_fkey;
alter table public.refunds
  add constraint refunds_company_reversal_of_fkey
    foreign key (company_id, reversal_of_id)
    references public.refunds(company_id, id) on delete set null (reversal_of_id);

create index if not exists refunds_company_tenant_idx on public.refunds (company_id, tenant_id);
create index if not exists refunds_company_status_idx on public.refunds (company_id, status);
create index if not exists refunds_company_date_idx on public.refunds (company_id, refund_date);

create or replace function public.tg_refunds_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select c.company_id from public.contracts c where c.id = new.contract_id),
      (select t.company_id from public.tenants t where t.id = new.tenant_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_refunds_default_company on public.refunds;
create trigger trg_refunds_default_company
  before insert on public.refunds
  for each row execute function public.tg_refunds_default_company();

------------------------------------------------------------
-- 5. expenses
------------------------------------------------------------

alter table public.expenses
  drop constraint if exists expenses_company_id_fkey;

update public.expenses e
   set company_id = coalesce(
     e.company_id,
     (select p.company_id from public.properties p where p.id = e.property_id),
     (select b.company_id from public.buildings b where b.id = e.building_id),
     (select u.company_id from public.units u where u.id = e.unit_id),
     (select ec.company_id from public.expense_categories ec where ec.id = e.category_id),
     public._legacy_single_company_id()
   )
 where e.company_id is null;

alter table public.expenses
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.expenses
  add constraint expenses_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.expenses drop constraint if exists expenses_company_id_id_key;
alter table public.expenses add constraint expenses_company_id_id_key unique (company_id, id);

alter table public.expenses drop constraint if exists expenses_code_key;
drop index if exists public.expenses_code_key;
alter table public.expenses drop constraint if exists expenses_company_code_key;
alter table public.expenses add constraint expenses_company_code_key unique (company_id, code);

alter table public.expenses drop constraint if exists expenses_company_category_fkey;
alter table public.expenses
  add constraint expenses_company_category_fkey
    foreign key (company_id, category_id)
    references public.expense_categories(company_id, id) on delete set null (category_id);

alter table public.expenses drop constraint if exists expenses_company_property_fkey;
alter table public.expenses
  add constraint expenses_company_property_fkey
    foreign key (company_id, property_id)
    references public.properties(company_id, id) on delete set null (property_id);

alter table public.expenses drop constraint if exists expenses_company_building_fkey;
alter table public.expenses
  add constraint expenses_company_building_fkey
    foreign key (company_id, building_id)
    references public.buildings(company_id, id) on delete set null (building_id);

alter table public.expenses drop constraint if exists expenses_company_unit_fkey;
alter table public.expenses
  add constraint expenses_company_unit_fkey
    foreign key (company_id, unit_id)
    references public.units(company_id, id) on delete set null (unit_id);

create index if not exists expenses_company_status_idx on public.expenses (company_id, status);
create index if not exists expenses_company_date_idx on public.expenses (company_id, expense_date desc);
create index if not exists expenses_company_property_idx on public.expenses (company_id, property_id);
create index if not exists expenses_company_category_idx on public.expenses (company_id, category_id);

create or replace function public.tg_expenses_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select p.company_id from public.properties p where p.id = new.property_id),
      (select b.company_id from public.buildings b where b.id = new.building_id),
      (select u.company_id from public.units u where u.id = new.unit_id),
      (select ec.company_id from public.expense_categories ec where ec.id = new.category_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_expenses_default_company on public.expenses;
create trigger trg_expenses_default_company
  before insert on public.expenses
  for each row execute function public.tg_expenses_default_company();
