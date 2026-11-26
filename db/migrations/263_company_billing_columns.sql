-- 263_company_billing_columns.sql
-- T025 (Billing group): tighten or add `company_id`, composite FKs, per-company
-- unique constraints, `company_id`-led indexes, and parent-derived defaults on
-- invoices, invoice_items, payment_requests, payments, payment_allocations,
-- receipts, webhook_events, and email_webhook_events.
-- Idempotent.

------------------------------------------------------------
-- 1. invoices (tighten existing company_id)
------------------------------------------------------------

alter table public.invoices
  drop constraint if exists invoices_company_id_fkey;

update public.invoices i
   set company_id = coalesce(
     i.company_id,
     (select c.company_id from public.contracts c where c.id = i.contract_id),
     (select t.company_id from public.tenants t where t.id = i.tenant_id),
     (select co.id from public.companies co order by co.created_at asc limit 1)
   )
 where i.company_id is null;

alter table public.invoices
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.invoices
  add constraint invoices_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.invoices drop constraint if exists invoices_company_id_id_key;
alter table public.invoices add constraint invoices_company_id_id_key unique (company_id, id);

alter table public.invoices drop constraint if exists invoices_code_key;
drop index if exists public.invoices_code_key;
alter table public.invoices drop constraint if exists invoices_company_code_key;
alter table public.invoices add constraint invoices_company_code_key unique (company_id, code);

alter table public.invoices drop constraint if exists invoices_idempotency_key_key;
drop index if exists public.invoices_idempotency_key_key;
alter table public.invoices drop constraint if exists invoices_company_idempotency_key;
alter table public.invoices
  add constraint invoices_company_idempotency_key unique (company_id, idempotency_key);

alter table public.invoices drop constraint if exists invoices_company_contract_fkey;
alter table public.invoices
  add constraint invoices_company_contract_fkey
    foreign key (company_id, contract_id) references public.contracts(company_id, id) on delete restrict;

alter table public.invoices drop constraint if exists invoices_company_tenant_fkey;
alter table public.invoices
  add constraint invoices_company_tenant_fkey
    foreign key (company_id, tenant_id) references public.tenants(company_id, id) on delete restrict;

alter table public.invoices drop constraint if exists invoices_company_unit_fkey;
alter table public.invoices
  add constraint invoices_company_unit_fkey
    foreign key (company_id, unit_id) references public.units(company_id, id) on delete restrict;

create index if not exists invoices_company_contract_idx on public.invoices (company_id, contract_id);
create index if not exists invoices_company_tenant_idx on public.invoices (company_id, tenant_id);
create index if not exists invoices_company_state_idx on public.invoices (company_id, state);
create index if not exists invoices_company_due_date_idx on public.invoices (company_id, due_date);
create index if not exists invoices_company_period_idx on public.invoices (company_id, period_year, period_month);

create or replace function public.tg_invoices_default_company()
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

drop trigger if exists trg_invoices_default_company on public.invoices;
create trigger trg_invoices_default_company
  before insert on public.invoices
  for each row execute function public.tg_invoices_default_company();

------------------------------------------------------------
-- 2. invoice_items
------------------------------------------------------------

alter table public.invoice_items
  add column if not exists company_id uuid;

update public.invoice_items ii
   set company_id = coalesce(
     ii.company_id,
     (select i.company_id from public.invoices i where i.id = ii.invoice_id),
     (select co.id from public.companies co order by co.created_at asc limit 1)
   )
 where ii.company_id is null;

alter table public.invoice_items
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.invoice_items drop constraint if exists invoice_items_company_id_fkey;
alter table public.invoice_items
  add constraint invoice_items_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.invoice_items drop constraint if exists invoice_items_company_id_id_key;
alter table public.invoice_items add constraint invoice_items_company_id_id_key unique (company_id, id);

alter table public.invoice_items drop constraint if exists invoice_items_company_invoice_fkey;
alter table public.invoice_items
  add constraint invoice_items_company_invoice_fkey
    foreign key (company_id, invoice_id) references public.invoices(company_id, id) on delete cascade;

alter table public.invoice_items drop constraint if exists invoice_items_company_unit_fkey;
alter table public.invoice_items
  add constraint invoice_items_company_unit_fkey
    foreign key (company_id, unit_id) references public.units(company_id, id) on delete restrict;

create index if not exists invoice_items_company_invoice_idx
  on public.invoice_items (company_id, invoice_id);

create or replace function public.tg_invoice_items_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select i.company_id from public.invoices i where i.id = new.invoice_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_invoice_items_default_company on public.invoice_items;
create trigger trg_invoice_items_default_company
  before insert on public.invoice_items
  for each row execute function public.tg_invoice_items_default_company();

------------------------------------------------------------
-- 3. payment_requests (before payments FK to payment_requests)
------------------------------------------------------------

alter table public.payment_requests
  add column if not exists company_id uuid;

update public.payment_requests pr
   set company_id = coalesce(
     pr.company_id,
     (select t.company_id from public.tenants t where t.id = pr.tenant_id),
     (select co.id from public.companies co order by co.created_at asc limit 1)
   )
 where pr.company_id is null;

alter table public.payment_requests
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.payment_requests drop constraint if exists payment_requests_company_id_fkey;
alter table public.payment_requests
  add constraint payment_requests_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.payment_requests drop constraint if exists payment_requests_company_id_id_key;
alter table public.payment_requests
  add constraint payment_requests_company_id_id_key unique (company_id, id);

alter table public.payment_requests drop constraint if exists payment_requests_code_key;
drop index if exists public.payment_requests_code_key;
alter table public.payment_requests drop constraint if exists payment_requests_company_code_key;
alter table public.payment_requests
  add constraint payment_requests_company_code_key unique (company_id, code);

alter table public.payment_requests drop constraint if exists payment_requests_idempotency_key_key;
drop index if exists public.payment_requests_idempotency_key_key;
alter table public.payment_requests drop constraint if exists payment_requests_company_idempotency_key;
alter table public.payment_requests
  add constraint payment_requests_company_idempotency_key unique (company_id, idempotency_key);

alter table public.payment_requests drop constraint if exists payment_requests_company_tenant_fkey;
alter table public.payment_requests
  add constraint payment_requests_company_tenant_fkey
    foreign key (company_id, tenant_id) references public.tenants(company_id, id) on delete restrict;

create index if not exists payment_requests_company_tenant_idx
  on public.payment_requests (company_id, tenant_id);
create index if not exists payment_requests_company_status_idx
  on public.payment_requests (company_id, status);

create or replace function public.tg_payment_requests_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select t.company_id from public.tenants t where t.id = new.tenant_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payment_requests_default_company on public.payment_requests;
create trigger trg_payment_requests_default_company
  before insert on public.payment_requests
  for each row execute function public.tg_payment_requests_default_company();

------------------------------------------------------------
-- 4. payments (tighten existing company_id)
------------------------------------------------------------

alter table public.payments
  drop constraint if exists payments_company_id_fkey;

update public.payments p
   set company_id = coalesce(
     p.company_id,
     (select t.company_id from public.tenants t where t.id = p.tenant_id),
     (select co.id from public.companies co order by co.created_at asc limit 1)
   )
 where p.company_id is null;

alter table public.payments
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.payments
  add constraint payments_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.payments drop constraint if exists payments_company_id_id_key;
alter table public.payments add constraint payments_company_id_id_key unique (company_id, id);

alter table public.payments drop constraint if exists payments_code_key;
drop index if exists public.payments_code_key;
alter table public.payments drop constraint if exists payments_company_code_key;
alter table public.payments add constraint payments_company_code_key unique (company_id, code);

drop index if exists public.payments_myfatoorah_reference_uidx;
create unique index if not exists payments_company_myfatoorah_reference_uidx
  on public.payments (company_id, reference)
  where (reference ~~ 'MF:%'::text);

alter table public.payments drop constraint if exists payments_company_tenant_fkey;
alter table public.payments
  add constraint payments_company_tenant_fkey
    foreign key (company_id, tenant_id) references public.tenants(company_id, id) on delete restrict;

alter table public.payments drop constraint if exists payments_company_unit_fkey;
alter table public.payments
  add constraint payments_company_unit_fkey
    foreign key (company_id, unit_id)
    references public.units(company_id, id) on delete set null (unit_id);

alter table public.payments drop constraint if exists payments_company_payment_request_fkey;
alter table public.payments
  add constraint payments_company_payment_request_fkey
    foreign key (company_id, payment_request_id)
    references public.payment_requests(company_id, id) on delete set null (payment_request_id);

alter table public.payments drop constraint if exists payments_company_reversed_by_fkey;
alter table public.payments
  add constraint payments_company_reversed_by_fkey
    foreign key (company_id, reversed_by_payment_id)
    references public.payments(company_id, id) on delete set null (reversed_by_payment_id);

alter table public.payment_requests drop constraint if exists payment_requests_company_resulting_payment_fkey;
alter table public.payment_requests
  add constraint payment_requests_company_resulting_payment_fkey
    foreign key (company_id, resulting_payment_id)
    references public.payments(company_id, id) on delete set null (resulting_payment_id);

create index if not exists payments_company_tenant_idx on public.payments (company_id, tenant_id);
create index if not exists payments_company_status_idx on public.payments (company_id, status);
create index if not exists payments_company_payment_date_idx on public.payments (company_id, payment_date);
create index if not exists payments_company_created_at_idx on public.payments (company_id, created_at desc);

create or replace function public.tg_payments_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select t.company_id from public.tenants t where t.id = new.tenant_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payments_default_company on public.payments;
create trigger trg_payments_default_company
  before insert on public.payments
  for each row execute function public.tg_payments_default_company();

------------------------------------------------------------
-- 5. payment_allocations
------------------------------------------------------------

alter table public.payment_allocations
  add column if not exists company_id uuid;

update public.payment_allocations pa
   set company_id = coalesce(
     pa.company_id,
     (select p.company_id from public.payments p where p.id = pa.payment_id),
     (select i.company_id from public.invoices i where i.id = pa.invoice_id),
     (select co.id from public.companies co order by co.created_at asc limit 1)
   )
 where pa.company_id is null;

alter table public.payment_allocations
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.payment_allocations drop constraint if exists payment_allocations_company_id_fkey;
alter table public.payment_allocations
  add constraint payment_allocations_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.payment_allocations drop constraint if exists payment_allocations_company_id_id_key;
alter table public.payment_allocations
  add constraint payment_allocations_company_id_id_key unique (company_id, id);

alter table public.payment_allocations drop constraint if exists payment_allocations_company_payment_fkey;
alter table public.payment_allocations
  add constraint payment_allocations_company_payment_fkey
    foreign key (company_id, payment_id) references public.payments(company_id, id) on delete cascade;

alter table public.payment_allocations drop constraint if exists payment_allocations_company_invoice_fkey;
alter table public.payment_allocations
  add constraint payment_allocations_company_invoice_fkey
    foreign key (company_id, invoice_id) references public.invoices(company_id, id) on delete restrict;

create index if not exists payment_allocations_company_payment_idx
  on public.payment_allocations (company_id, payment_id);
create index if not exists payment_allocations_company_invoice_idx
  on public.payment_allocations (company_id, invoice_id);

create or replace function public.tg_payment_allocations_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select p.company_id from public.payments p where p.id = new.payment_id),
      (select i.company_id from public.invoices i where i.id = new.invoice_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_payment_allocations_default_company on public.payment_allocations;
create trigger trg_payment_allocations_default_company
  before insert on public.payment_allocations
  for each row execute function public.tg_payment_allocations_default_company();

------------------------------------------------------------
-- 6. receipts
------------------------------------------------------------

alter table public.receipts
  add column if not exists company_id uuid;

update public.receipts r
   set company_id = coalesce(
     r.company_id,
     (select p.company_id from public.payments p where p.id = r.payment_id),
     (select t.company_id from public.tenants t where t.id = r.tenant_id),
     (select co.id from public.companies co order by co.created_at asc limit 1)
   )
 where r.company_id is null;

alter table public.receipts
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.receipts drop constraint if exists receipts_company_id_fkey;
alter table public.receipts
  add constraint receipts_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.receipts drop constraint if exists receipts_company_id_id_key;
alter table public.receipts add constraint receipts_company_id_id_key unique (company_id, id);

alter table public.receipts drop constraint if exists receipts_code_key;
drop index if exists public.receipts_code_key;
alter table public.receipts drop constraint if exists receipts_company_code_key;
alter table public.receipts add constraint receipts_company_code_key unique (company_id, code);

alter table public.receipts drop constraint if exists receipts_company_payment_fkey;
alter table public.receipts
  add constraint receipts_company_payment_fkey
    foreign key (company_id, payment_id) references public.payments(company_id, id) on delete restrict;

alter table public.receipts drop constraint if exists receipts_company_tenant_fkey;
alter table public.receipts
  add constraint receipts_company_tenant_fkey
    foreign key (company_id, tenant_id) references public.tenants(company_id, id) on delete restrict;

create index if not exists receipts_company_tenant_idx on public.receipts (company_id, tenant_id);
create index if not exists receipts_company_payment_idx on public.receipts (company_id, payment_id);

create or replace function public.tg_receipts_default_company()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null then
    new.company_id := coalesce(
      public.current_company_id(),
      (select p.company_id from public.payments p where p.id = new.payment_id),
      (select t.company_id from public.tenants t where t.id = new.tenant_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_receipts_default_company on public.receipts;
create trigger trg_receipts_default_company
  before insert on public.receipts
  for each row execute function public.tg_receipts_default_company();

------------------------------------------------------------
-- 7. webhook_events
------------------------------------------------------------

alter table public.webhook_events
  add column if not exists company_id uuid;

update public.webhook_events we
   set company_id = (select co.id from public.companies co order by co.created_at asc limit 1)
 where we.company_id is null;

alter table public.webhook_events
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.webhook_events drop constraint if exists webhook_events_company_id_fkey;
alter table public.webhook_events
  add constraint webhook_events_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.webhook_events drop constraint if exists webhook_events_company_id_id_key;
alter table public.webhook_events
  add constraint webhook_events_company_id_id_key unique (company_id, id);

drop index if exists public.webhook_events_gateway_provider_event_id_uidx;
create unique index if not exists webhook_events_company_gateway_event_uidx
  on public.webhook_events (company_id, gateway, provider_event_id)
  where (provider_event_id is not null);

create index if not exists webhook_events_company_received_idx
  on public.webhook_events (company_id, received_at desc);

------------------------------------------------------------
-- 8. email_webhook_events
------------------------------------------------------------

alter table public.email_webhook_events
  add column if not exists company_id uuid;

update public.email_webhook_events ewe
   set company_id = (select co.id from public.companies co order by co.created_at asc limit 1)
 where ewe.company_id is null;

alter table public.email_webhook_events
  alter column company_id set default public.current_company_id(),
  alter column company_id set not null;

alter table public.email_webhook_events drop constraint if exists email_webhook_events_company_id_fkey;
alter table public.email_webhook_events
  add constraint email_webhook_events_company_id_fkey
    foreign key (company_id) references public.companies(id);

alter table public.email_webhook_events drop constraint if exists email_webhook_events_company_id_id_key;
alter table public.email_webhook_events
  add constraint email_webhook_events_company_id_id_key unique (company_id, id);

drop index if exists public.email_webhook_events_provider_event_id_uidx;
create unique index if not exists email_webhook_events_company_provider_event_uidx
  on public.email_webhook_events (company_id, provider, provider_event_id)
  where (provider_event_id is not null);

create index if not exists email_webhook_events_company_received_idx
  on public.email_webhook_events (company_id, received_at desc);

-- Deferred composite FK from 261 (concession_invoices -> invoices)
alter table public.concession_invoices drop constraint if exists concession_invoices_company_invoice_fkey;
alter table public.concession_invoices
  add constraint concession_invoices_company_invoice_fkey
    foreign key (company_id, invoice_id) references public.invoices(company_id, id) on delete cascade;
