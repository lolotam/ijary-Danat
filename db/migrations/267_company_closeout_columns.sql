-- 267_company_closeout_columns.sql
-- T027 (Closeout group): tighten or add `company_id`, `unique (company_id, id)`,
-- composite FKs, per-company uniques, `company_id`-led indexes, and parent-derived
-- defaults on contract_closeouts, contract_closeout_deductions, and
-- contract_closeout_invoice_actions.
-- Idempotent.

------------------------------------------------------------
-- 1. contract_closeouts
------------------------------------------------------------

alter table public.contract_closeouts
  drop constraint if exists contract_closeouts_company_id_fkey;

update public.contract_closeouts cc
   set company_id = coalesce(
     cc.company_id,
     (select c.company_id from public.contracts c where c.id = cc.contract_id),
     (select t.company_id from public.tenants t where t.id = cc.tenant_id),
     (select co.id from public.companies co order by co.created_at asc limit 1)
   )
 where cc.company_id is null;

alter table public.contract_closeouts
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.contract_closeouts
  add constraint contract_closeouts_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.contract_closeouts drop constraint if exists contract_closeouts_company_id_id_key;
alter table public.contract_closeouts
  add constraint contract_closeouts_company_id_id_key unique (company_id, id);

alter table public.contract_closeouts drop constraint if exists contract_closeouts_idempotency_key_key;
drop index if exists public.contract_closeouts_idempotency_key_key;
alter table public.contract_closeouts drop constraint if exists contract_closeouts_company_idempotency_key;
alter table public.contract_closeouts
  add constraint contract_closeouts_company_idempotency_key unique (company_id, idempotency_key);

alter table public.contract_closeouts drop constraint if exists contract_closeouts_company_contract_fkey;
alter table public.contract_closeouts
  add constraint contract_closeouts_company_contract_fkey
    foreign key (company_id, contract_id) references public.contracts(company_id, id) on delete restrict;

alter table public.contract_closeouts drop constraint if exists contract_closeouts_company_tenant_fkey;
alter table public.contract_closeouts
  add constraint contract_closeouts_company_tenant_fkey
    foreign key (company_id, tenant_id) references public.tenants(company_id, id) on delete restrict;

alter table public.contract_closeouts drop constraint if exists contract_closeouts_company_unit_fkey;
alter table public.contract_closeouts
  add constraint contract_closeouts_company_unit_fkey
    foreign key (company_id, unit_id)
    references public.units(company_id, id) on delete set null (unit_id);

alter table public.contract_closeouts drop constraint if exists contract_closeouts_company_building_fkey;
alter table public.contract_closeouts
  add constraint contract_closeouts_company_building_fkey
    foreign key (company_id, building_id)
    references public.buildings(company_id, id) on delete set null (building_id);

alter table public.contract_closeouts drop constraint if exists contract_closeouts_company_refund_fkey;
alter table public.contract_closeouts
  add constraint contract_closeouts_company_refund_fkey
    foreign key (company_id, refund_id)
    references public.refunds(company_id, id) on delete set null (refund_id);

create index if not exists contract_closeouts_company_contract_idx
  on public.contract_closeouts (company_id, contract_id);
create index if not exists contract_closeouts_company_tenant_idx
  on public.contract_closeouts (company_id, tenant_id);
create index if not exists contract_closeouts_company_status_idx
  on public.contract_closeouts (company_id, status);
create index if not exists contract_closeouts_company_completed_at_idx
  on public.contract_closeouts (company_id, completed_at);

create or replace function public.tg_contract_closeouts_default_company()
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

drop trigger if exists trg_contract_closeouts_default_company on public.contract_closeouts;
create trigger trg_contract_closeouts_default_company
  before insert on public.contract_closeouts
  for each row execute function public.tg_contract_closeouts_default_company();

------------------------------------------------------------
-- 2. contract_closeout_deductions
------------------------------------------------------------

alter table public.contract_closeout_deductions
  add column if not exists company_id uuid;

update public.contract_closeout_deductions d
   set company_id = coalesce(
     d.company_id,
     (select cc.company_id from public.contract_closeouts cc where cc.id = d.closeout_id),
     (select co.id from public.companies co order by co.created_at asc limit 1)
   )
 where d.company_id is null;

alter table public.contract_closeout_deductions
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.contract_closeout_deductions
  drop constraint if exists contract_closeout_deductions_company_id_fkey;
alter table public.contract_closeout_deductions
  add constraint contract_closeout_deductions_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.contract_closeout_deductions
  drop constraint if exists contract_closeout_deductions_company_id_id_key;
alter table public.contract_closeout_deductions
  add constraint contract_closeout_deductions_company_id_id_key unique (company_id, id);

alter table public.contract_closeout_deductions
  drop constraint if exists contract_closeout_deductions_company_closeout_fkey;
alter table public.contract_closeout_deductions
  add constraint contract_closeout_deductions_company_closeout_fkey
    foreign key (company_id, closeout_id)
    references public.contract_closeouts(company_id, id) on delete cascade;

create index if not exists contract_closeout_deductions_company_closeout_idx
  on public.contract_closeout_deductions (company_id, closeout_id);

create or replace function public.tg_contract_closeout_deductions_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select cc.company_id from public.contract_closeouts cc where cc.id = new.closeout_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_contract_closeout_deductions_default_company on public.contract_closeout_deductions;
create trigger trg_contract_closeout_deductions_default_company
  before insert on public.contract_closeout_deductions
  for each row execute function public.tg_contract_closeout_deductions_default_company();

------------------------------------------------------------
-- 3. contract_closeout_invoice_actions
------------------------------------------------------------

alter table public.contract_closeout_invoice_actions
  add column if not exists company_id uuid;

update public.contract_closeout_invoice_actions a
   set company_id = coalesce(
     a.company_id,
     (select cc.company_id from public.contract_closeouts cc where cc.id = a.closeout_id),
     (select i.company_id from public.invoices i where i.id = a.invoice_id),
     (select co.id from public.companies co order by co.created_at asc limit 1)
   )
 where a.company_id is null;

alter table public.contract_closeout_invoice_actions
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.contract_closeout_invoice_actions
  drop constraint if exists contract_closeout_invoice_actions_company_id_fkey;
alter table public.contract_closeout_invoice_actions
  add constraint contract_closeout_invoice_actions_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.contract_closeout_invoice_actions
  drop constraint if exists contract_closeout_invoice_actions_company_id_id_key;
alter table public.contract_closeout_invoice_actions
  add constraint contract_closeout_invoice_actions_company_id_id_key unique (company_id, id);

alter table public.contract_closeout_invoice_actions
  drop constraint if exists contract_closeout_invoice_actions_company_closeout_fkey;
alter table public.contract_closeout_invoice_actions
  add constraint contract_closeout_invoice_actions_company_closeout_fkey
    foreign key (company_id, closeout_id)
    references public.contract_closeouts(company_id, id) on delete cascade;

alter table public.contract_closeout_invoice_actions
  drop constraint if exists contract_closeout_invoice_actions_company_invoice_fkey;
alter table public.contract_closeout_invoice_actions
  add constraint contract_closeout_invoice_actions_company_invoice_fkey
    foreign key (company_id, invoice_id)
    references public.invoices(company_id, id) on delete restrict;

create index if not exists contract_closeout_invoice_actions_company_closeout_idx
  on public.contract_closeout_invoice_actions (company_id, closeout_id);
create index if not exists contract_closeout_invoice_actions_company_invoice_idx
  on public.contract_closeout_invoice_actions (company_id, invoice_id);

create or replace function public.tg_contract_closeout_invoice_actions_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select cc.company_id from public.contract_closeouts cc where cc.id = new.closeout_id),
      (select i.company_id from public.invoices i where i.id = new.invoice_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_contract_closeout_invoice_actions_default_company on public.contract_closeout_invoice_actions;
create trigger trg_contract_closeout_invoice_actions_default_company
  before insert on public.contract_closeout_invoice_actions
  for each row execute function public.tg_contract_closeout_invoice_actions_default_company();

-- Deferred composite FK from 261 (contract_operational_events -> contract_closeouts)
alter table public.contract_operational_events
  drop constraint if exists contract_operational_events_company_closeout_fkey;
alter table public.contract_operational_events
  add constraint contract_operational_events_company_closeout_fkey
    foreign key (company_id, closeout_id)
    references public.contract_closeouts(company_id, id) on delete set null (closeout_id);
