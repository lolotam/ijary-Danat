do $$ begin
  create type public.gateway_providers as enum ('myfatoorah');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.gateway_payment_methods as enum ('knet', 'applepay', 'googlepay');
exception when duplicate_object then null; end $$;

alter type public.payment_methods add value if not exists 'applepay';
alter type public.payment_methods add value if not exists 'googlepay';

create sequence if not exists public.payment_request_code_seq;

create or replace function public.next_payment_request_code()
returns text language sql security definer set search_path = public
as $$ select 'PREQ-' || lpad(nextval('public.payment_request_code_seq')::text, 7, '0') $$;

revoke all on function public.next_payment_request_code() from public;
grant execute on function public.next_payment_request_code() to authenticated, service_role;

create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  code text unique not null default public.next_payment_request_code(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  gateway public.gateway_providers not null default 'myfatoorah',
  provider_invoice_id text,
  provider_payment_id text,
  payment_url text,
  amount numeric(14,3) not null check (amount > 0),
  currency text not null default 'KWD',
  requested_invoice_ids uuid[] not null check (cardinality(requested_invoice_ids) > 0),
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'failed', 'expired', 'cancelled')),
  idempotency_key text unique,
  request_payload jsonb,
  gateway_response jsonb,
  resulting_payment_id uuid references public.payments(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  gateway public.gateway_providers not null,
  event_type text,
  provider_event_id text,
  provider_payment_id text,
  raw_payload jsonb,
  signature_valid boolean not null default false,
  processed boolean not null default false,
  result text,
  error text,
  received_at timestamptz not null default now()
);

create index if not exists payment_requests_tenant_id_idx
  on public.payment_requests (tenant_id);
create index if not exists payment_requests_status_idx
  on public.payment_requests (status);
create index if not exists payment_requests_idempotency_key_idx
  on public.payment_requests (idempotency_key);
create index if not exists webhook_events_provider_payment_id_idx
  on public.webhook_events (provider_payment_id);
create index if not exists webhook_events_processed_idx
  on public.webhook_events (processed);
create unique index if not exists webhook_events_gateway_provider_event_id_uidx
  on public.webhook_events (gateway, provider_event_id)
  where provider_event_id is not null;
create unique index if not exists payments_myfatoorah_reference_uidx
  on public.payments (reference)
  where reference like 'MF:%';

drop trigger if exists set_updated_at on public.payment_requests;
create trigger set_updated_at before update on public.payment_requests
for each row execute function public.tg_set_updated_at();

grant select, insert on public.payment_requests to authenticated;
grant all on public.payment_requests to service_role;
grant select on public.webhook_events to authenticated;
grant all on public.webhook_events to service_role;

alter table public.payment_requests enable row level security;
alter table public.webhook_events enable row level security;

drop policy if exists payment_requests_select_allowed on public.payment_requests;
create policy payment_requests_select_allowed on public.payment_requests
for select to authenticated using (
  public.is_staff(auth.uid()) or exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.tenant_id = payment_requests.tenant_id
  )
);

drop policy if exists payment_requests_insert_own_tenant on public.payment_requests;
create policy payment_requests_insert_own_tenant on public.payment_requests
for insert to authenticated with check (
  created_by = auth.uid()
  and exists (
    select 1
    from public.profiles p
    join public.tenants t on t.id = p.tenant_id
    where p.id = auth.uid()
      and p.tenant_id = payment_requests.tenant_id
      and t.tenant_portal_enabled
      and public.has_role(auth.uid(), 'tenant')
  )
);

drop policy if exists payment_requests_service_role_all on public.payment_requests;
create policy payment_requests_service_role_all on public.payment_requests
for all to service_role using (true) with check (true);

drop policy if exists webhook_events_select_staff on public.webhook_events;
create policy webhook_events_select_staff on public.webhook_events
for select to authenticated using (public.is_staff(auth.uid()));

drop policy if exists webhook_events_service_role_all on public.webhook_events;
create policy webhook_events_service_role_all on public.webhook_events
for all to service_role using (true) with check (true);

drop policy if exists payments_select_allowed on public.payments;
create policy payments_select_allowed on public.payments for select to authenticated using (
  public.is_staff(auth.uid()) or (
    status in ('confirmed', 'reversed') and exists (
      select 1
      from public.profiles p
      where p.id = auth.uid() and p.tenant_id = payments.tenant_id
    )
  )
);

create or replace function public.evaluate_portal_payable_invoices(
  p_tenant_id uuid,
  p_company_max_visible integer default 6
)
returns table (
  invoice_id uuid,
  period_year integer,
  period_month integer,
  total numeric,
  paid numeric,
  balance numeric,
  state text,
  is_overdue boolean,
  sequence_order integer,
  is_selectable boolean,
  lock_reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_max_visible integer;
begin
  if p_tenant_id is null then
    raise exception 'Tenant is required';
  end if;

  if auth.role() = 'authenticated' and not (
    public.is_staff(auth.uid()) or (
      public.has_role(auth.uid(), 'tenant') and exists (
        select 1
        from public.profiles p
        where p.id = auth.uid() and p.tenant_id = p_tenant_id
      )
    )
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select least(
    greatest(coalesce(p_company_max_visible, 6), 1),
    coalesce(c.max_visible_unpaid_invoices, greatest(coalesce(p_company_max_visible, 6), 1))
  )
  into v_max_visible
  from public.tenants t
  left join public.companies c on c.id = t.company_id
  where t.id = p_tenant_id;

  if v_max_visible is null then
    raise exception 'Tenant not found';
  end if;

  return query
  with payable as (
    select
      i.id,
      i.period_year,
      i.period_month,
      i.total,
      i.paid,
      i.balance,
      i.state::text,
      (i.state = 'overdue' or (i.due_date + coalesce(c.grace_days, 0)) < current_date) as overdue,
      row_number() over (
        order by i.period_year, i.period_month, i.due_date, i.id
      )::integer as seq
    from public.invoices i
    left join public.contracts c on c.id = i.contract_id
    where i.tenant_id = p_tenant_id
      and i.state in ('due', 'overdue', 'partially_paid')
      and i.balance > 0
      and i.is_visible_to_tenant
  ), ordered as (
    select
      p.*,
      first_value(p.period_month) over (order by p.seq) as blocking_month,
      first_value(p.period_year) over (order by p.seq) as blocking_year
    from payable p
  )
  select
    o.id,
    o.period_year,
    o.period_month,
    o.total,
    o.paid,
    o.balance,
    o.state,
    o.overdue,
    o.seq,
    o.seq = 1,
    case
      when o.seq = 1 then null
      else 'ادفع فاتورة شهر '
        || lpad(o.blocking_month::text, 2, '0') || '/' || o.blocking_year::text
        || ' أولًا / Pay month '
        || lpad(o.blocking_month::text, 2, '0') || '/' || o.blocking_year::text
        || ' first'
    end
  from ordered o
  order by o.seq
  limit v_max_visible;
end;
$$;

revoke all on function public.evaluate_portal_payable_invoices(uuid, integer) from public;
grant execute on function public.evaluate_portal_payable_invoices(uuid, integer)
  to authenticated, service_role;
