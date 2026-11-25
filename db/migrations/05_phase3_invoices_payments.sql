do $$ begin
  create type public.invoice_states as enum ('due', 'overdue', 'paid', 'partially_paid', 'cancelled', 'waived');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.payment_methods as enum ('payment_link', 'bank_transfer', 'cheque', 'cash', 'knet');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.payment_account_types as enum ('commercial_account', 'personal_account');
exception when duplicate_object then null; end $$;

create sequence if not exists public.invoice_code_seq;
create sequence if not exists public.payment_code_seq;
create sequence if not exists public.receipt_code_seq;

create or replace function public.next_invoice_code()
returns text language sql security definer set search_path = public
as $$ select 'INV-' || lpad(nextval('public.invoice_code_seq')::text, 7, '0') $$;
create or replace function public.next_payment_code()
returns text language sql security definer set search_path = public
as $$ select 'PAY-' || lpad(nextval('public.payment_code_seq')::text, 7, '0') $$;
create or replace function public.next_receipt_code()
returns text language sql security definer set search_path = public
as $$ select 'REC-' || lpad(nextval('public.receipt_code_seq')::text, 7, '0') $$;

revoke all on function public.next_invoice_code() from public;
revoke all on function public.next_payment_code() from public;
revoke all on function public.next_receipt_code() from public;
grant execute on function public.next_invoice_code() to authenticated, service_role;
grant execute on function public.next_payment_code() to authenticated, service_role;
grant execute on function public.next_receipt_code() to authenticated, service_role;

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  code text unique not null default public.next_invoice_code(),
  company_id uuid references public.companies(id) on delete set null,
  contract_id uuid not null references public.contracts(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  unit_id uuid not null references public.units(id) on delete restrict,
  period_year integer not null,
  period_month integer not null check (period_month between 1 and 12),
  issue_date date not null,
  due_date date not null,
  subtotal numeric(14,3) not null default 0 check (subtotal >= 0),
  discount numeric(14,3) not null default 0 check (discount >= 0),
  total numeric(14,3) not null default 0 check (total >= 0),
  paid numeric(14,3) not null default 0 check (paid >= 0 and paid <= total),
  balance numeric(14,3) generated always as (total - paid) stored,
  state public.invoice_states not null default 'due',
  is_visible_to_tenant boolean not null default true,
  idempotency_key text not null unique,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_id, period_year, period_month)
);

create table if not exists public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  line integer not null,
  description_ar text,
  description_en text,
  quantity numeric(10,3) not null default 1 check (quantity > 0),
  unit_price numeric(14,3) not null default 0,
  discount_percent numeric(5,2) not null default 0 check (discount_percent between 0 and 100),
  amount numeric(14,3) not null default 0,
  is_concession boolean not null default false,
  created_at timestamptz not null default now(),
  unique (invoice_id, line)
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  code text unique not null default public.next_payment_code(),
  company_id uuid references public.companies(id) on delete set null,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  account_type public.payment_account_types,
  method public.payment_methods not null,
  amount numeric(14,3) not null check (amount > 0),
  currency text not null default 'KWD',
  payment_date date not null,
  reference text,
  unit_id uuid references public.units(id) on delete set null,
  attachment_path text,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  status text not null default 'confirmed' check (status in ('pending', 'confirmed', 'reversed')),
  reversed_by_payment_id uuid references public.payments(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (reversed_by_payment_id is null or reversed_by_payment_id <> id)
);

create table if not exists public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  amount numeric(14,3) not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (payment_id, invoice_id)
);

create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  code text unique not null default public.next_receipt_code(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  amount numeric(14,3) not null check (amount > 0),
  currency text not null default 'KWD',
  issue_date timestamptz not null default now(),
  storage_path text,
  html_snapshot text,
  visible_to_tenant boolean not null default false,
  created_at timestamptz not null default now(),
  unique (payment_id)
);

create index if not exists invoices_tenant_id_idx on public.invoices (tenant_id);
create index if not exists invoices_contract_id_idx on public.invoices (contract_id);
create index if not exists invoices_state_idx on public.invoices (state);
create index if not exists invoices_period_year_idx on public.invoices (period_year);
create index if not exists invoices_period_month_idx on public.invoices (period_month);
create index if not exists invoices_due_date_idx on public.invoices (due_date);
create index if not exists invoice_items_invoice_id_idx on public.invoice_items (invoice_id);
create index if not exists payments_tenant_id_idx on public.payments (tenant_id);
create index if not exists payments_status_idx on public.payments (status);
create index if not exists payments_payment_date_idx on public.payments (payment_date);
create index if not exists payments_method_idx on public.payments (method);
create index if not exists payment_allocations_payment_id_idx on public.payment_allocations (payment_id);
create index if not exists payment_allocations_invoice_id_idx on public.payment_allocations (invoice_id);
create index if not exists receipts_payment_id_idx on public.receipts (payment_id);
create index if not exists receipts_tenant_id_idx on public.receipts (tenant_id);

drop trigger if exists set_updated_at on public.invoices;
create trigger set_updated_at before update on public.invoices
for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.payments;
create trigger set_updated_at before update on public.payments
for each row execute function public.tg_set_updated_at();

grant select, insert, update, delete on public.invoices to authenticated;
grant all on public.invoices to service_role;
grant select, insert, update, delete on public.invoice_items to authenticated;
grant all on public.invoice_items to service_role;
grant select, insert, update on public.payments to authenticated;
grant all on public.payments to service_role;
grant select, insert, update, delete on public.payment_allocations to authenticated;
grant all on public.payment_allocations to service_role;
grant select, insert, update, delete on public.receipts to authenticated;
grant all on public.receipts to service_role;

alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.receipts enable row level security;

drop policy if exists invoices_select_allowed on public.invoices;
create policy invoices_select_allowed on public.invoices for select to authenticated using (
  public.is_staff(auth.uid()) or (
    is_visible_to_tenant and exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.tenant_id = invoices.tenant_id
    )
  )
);
drop policy if exists invoices_write_staff on public.invoices;
create policy invoices_write_staff on public.invoices for all to authenticated
  using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
drop policy if exists invoices_service_role_all on public.invoices;
create policy invoices_service_role_all on public.invoices for all to service_role using (true) with check (true);

drop policy if exists invoice_items_select_allowed on public.invoice_items;
create policy invoice_items_select_allowed on public.invoice_items for select to authenticated using (
  exists (
    select 1 from public.invoices i
    where i.id = invoice_items.invoice_id
      and (public.is_staff(auth.uid()) or (
        i.is_visible_to_tenant and exists (
          select 1 from public.profiles p where p.id = auth.uid() and p.tenant_id = i.tenant_id
        )
      ))
  )
);
drop policy if exists invoice_items_write_staff on public.invoice_items;
create policy invoice_items_write_staff on public.invoice_items for all to authenticated
  using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
drop policy if exists invoice_items_service_role_all on public.invoice_items;
create policy invoice_items_service_role_all on public.invoice_items for all to service_role using (true) with check (true);

drop policy if exists payments_select_allowed on public.payments;
create policy payments_select_allowed on public.payments for select to authenticated using (
  public.is_staff(auth.uid()) or (
    status = 'confirmed' and reversed_by_payment_id is null and exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.tenant_id = payments.tenant_id
    )
  )
);
drop policy if exists payments_insert_staff on public.payments;
create policy payments_insert_staff on public.payments for insert to authenticated
  with check (public.is_staff(auth.uid()));
drop policy if exists payments_update_staff on public.payments;
create policy payments_update_staff on public.payments for update to authenticated
  using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
drop policy if exists payments_service_role_all on public.payments;
create policy payments_service_role_all on public.payments for all to service_role using (true) with check (true);

drop policy if exists payment_allocations_select_allowed on public.payment_allocations;
create policy payment_allocations_select_allowed on public.payment_allocations for select to authenticated using (
  exists (
    select 1 from public.payments p
    where p.id = payment_allocations.payment_id
      and (public.is_staff(auth.uid()) or exists (
        select 1 from public.profiles pr where pr.id = auth.uid() and pr.tenant_id = p.tenant_id
      ))
  )
);
drop policy if exists payment_allocations_write_staff on public.payment_allocations;
create policy payment_allocations_write_staff on public.payment_allocations for all to authenticated
  using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
drop policy if exists payment_allocations_service_role_all on public.payment_allocations;
create policy payment_allocations_service_role_all on public.payment_allocations for all to service_role using (true) with check (true);

drop policy if exists receipts_select_allowed on public.receipts;
create policy receipts_select_allowed on public.receipts for select to authenticated using (
  public.is_staff(auth.uid()) or (
    visible_to_tenant and exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.tenant_id = receipts.tenant_id
    )
  )
);
drop policy if exists receipts_write_staff on public.receipts;
create policy receipts_write_staff on public.receipts for all to authenticated
  using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));
drop policy if exists receipts_service_role_all on public.receipts;
create policy receipts_service_role_all on public.receipts for all to service_role using (true) with check (true);

insert into storage.buckets (id, name, public)
values ('payment-attachments', 'payment-attachments', false)
on conflict (id) do update set public = false;

drop policy if exists payment_attachments_select_staff on storage.objects;
create policy payment_attachments_select_staff on storage.objects for select to authenticated using (
  bucket_id = 'payment-attachments' and public.is_staff(auth.uid())
);
drop policy if exists payment_attachments_insert_staff on storage.objects;
create policy payment_attachments_insert_staff on storage.objects for insert to authenticated with check (
  bucket_id = 'payment-attachments'
  and public.is_staff(auth.uid())
  and public.has_permission(auth.uid(), 'payments.create')
);
create or replace function public.generate_invoices(
  p_contract_id uuid default null,
  p_through_year integer default null
)
returns table (
  id uuid, code text, contract_id uuid, period_year integer,
  period_month integer, total numeric, state text
)
language plpgsql security definer set search_path = public
as $$
declare
  v_year integer := coalesce(p_through_year, extract(year from current_date)::integer);
  v_start_month integer;
  v_end_month integer;
  v_month integer;
  v_period_start date;
  v_invoice_id uuid;
  v_invoice_code text;
  v_subtotal numeric(14,3);
  v_total numeric(14,3);
  v_discount numeric(14,3);
  v_item_total numeric(14,3);
  v_line integer;
  v_concession public.concessions%rowtype;
  v_concession_amount numeric(14,3);
  v_contract public.contracts%rowtype;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_year < 2000 or v_year > 2200 then
    raise exception 'Target year is outside the supported range';
  end if;
  for v_contract in
    select c.* from public.contracts c
    where c.state = 'active'
      and (p_contract_id is null or c.id = p_contract_id)
      and c.start_date <= make_date(v_year, 12, 31)
      and c.end_date >= make_date(v_year, 1, 1)
    order by c.id
  loop
    v_start_month := case
      when v_year = extract(year from current_date)::integer
        then greatest(extract(month from current_date)::integer,
          case when extract(year from v_contract.start_date)::integer = v_year
            then extract(month from v_contract.start_date)::integer else 1 end)
      else case when extract(year from v_contract.start_date)::integer = v_year
        then extract(month from v_contract.start_date)::integer else 1 end
    end;
    v_end_month := case when extract(year from v_contract.end_date)::integer = v_year
      then extract(month from v_contract.end_date)::integer else 12 end;
    if v_start_month <= v_end_month then
      for v_month in v_start_month..v_end_month loop
        v_period_start := make_date(v_year, v_month, 1);
        if v_period_start < date_trunc('month', v_contract.start_date)::date
          or v_period_start > date_trunc('month', v_contract.end_date)::date then
          continue;
        end if;
        v_subtotal := v_contract.monthly_amount;
        v_total := v_subtotal;
        for v_concession in
          select cn.* from public.concessions cn
          where cn.contract_id = v_contract.id and cn.status = 'active'
            and cn.start_date <= v_period_start and cn.end_date >= v_period_start
          order by case cn.type when 'free_months' then 1 when 'percentage_discount' then 2 else 3 end,
            cn.created_at, cn.id
        loop
          if v_concession.type = 'free_months' then
            v_total := 0;
          elsif v_concession.type = 'percentage_discount' then
            v_total := greatest(0, v_total - round(v_total * coalesce(v_concession.discount_percent, 0) / 100, 3));
          else
            v_total := greatest(0, v_total - coalesce(v_concession.discount_amount, 0));
          end if;
        end loop;
        v_discount := v_subtotal - v_total;
        v_invoice_id := null;
        insert into public.invoices (
          code, company_id, contract_id, tenant_id, unit_id, period_year, period_month,
          issue_date, due_date, subtotal, discount, total, paid, state,
          is_visible_to_tenant, idempotency_key
        )
        select public.next_invoice_code(), t.company_id, v_contract.id, v_contract.tenant_id,
          v_contract.unit_id, v_year, v_month, current_date,
          make_date(v_year, v_month, v_contract.due_day), v_subtotal, v_discount,
          v_total, 0, 'due', true,
          v_contract.id::text || ':' || v_year::text || ':' || v_month::text
        from public.tenants t where t.id = v_contract.tenant_id
        -- Target the constraint by name, not by column list: contract_id is
        -- also an OUT parameter of this function, so a column-list ON CONFLICT
        -- raises "column reference \"contract_id\" is ambiguous" and aborts.
        -- 23_invoice_backfill_and_manual_payment.sql:116 and
        -- 37_concession_free_months_skip_and_reapply.sql:131 already use this
        -- form; 05 was the unfixed original, which broke provisioning a clean
        -- database at 11_mock_data.sql (the first caller of generate_invoices).
        on conflict on constraint invoices_contract_id_period_year_period_month_key do nothing
        returning invoices.id, invoices.code into v_invoice_id, v_invoice_code;
        if v_invoice_id is null then continue; end if;
        insert into public.invoice_items (
          invoice_id, line, description_ar, description_en, quantity,
          unit_price, discount_percent, amount, is_concession
        ) values (
          v_invoice_id, 1, 'قيمة استثمار شهرية', 'Monthly investment value',
          1, v_subtotal, 0, v_subtotal, false
        );
        v_line := 2;
        v_item_total := v_subtotal;
        for v_concession in
          select cn.* from public.concessions cn
          where cn.contract_id = v_contract.id and cn.status = 'active'
            and cn.start_date <= v_period_start and cn.end_date >= v_period_start
          order by case cn.type when 'free_months' then 1 when 'percentage_discount' then 2 else 3 end,
            cn.created_at, cn.id
        loop
          if v_concession.type = 'free_months' then
            v_concession_amount := 0;
            v_item_total := 0;
          elsif v_concession.type = 'percentage_discount' then
            v_concession_amount := round(
              v_item_total * coalesce(v_concession.discount_percent, 0) / 100,
              3
            );
            v_item_total := greatest(0, v_item_total - v_concession_amount);
          else
            v_concession_amount := least(
              v_item_total,
              coalesce(v_concession.discount_amount, 0)
            );
            v_item_total := greatest(0, v_item_total - v_concession_amount);
          end if;
          insert into public.invoice_items (
            invoice_id, line, description_ar, description_en, quantity,
            unit_price, discount_percent, amount, is_concession
          ) values (
            v_invoice_id, v_line,
            case v_concession.type when 'free_months' then 'فترة مجانية'
              when 'percentage_discount' then 'خصم نسبة مئوية' else 'خصم مبلغ ثابت' end,
            case v_concession.type when 'free_months' then 'Free period'
              when 'percentage_discount' then 'Percentage discount' else 'Fixed discount' end,
            1, 0, coalesce(v_concession.discount_percent, 0),
            -v_concession_amount, true
          );
          v_line := v_line + 1;
        end loop;
        id := v_invoice_id; code := v_invoice_code; contract_id := v_contract.id;
        period_year := v_year; period_month := v_month; total := v_total; state := 'due';
        return next;
      end loop;
    end if;
  end loop;
end;
$$;
revoke all on function public.generate_invoices(uuid, integer) from public;
grant execute on function public.generate_invoices(uuid, integer) to authenticated, service_role;

create or replace function public.evaluate_overdue(p_as_of date default null)
returns table (invoice_id uuid, old_state text, new_state text)
language plpgsql security definer set search_path = public
as $$
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  return query
  with eligible as (
    select i.id, i.state::text as previous_state
    from public.invoices i join public.contracts c on c.id = i.contract_id
    where i.state in ('due', 'partially_paid') and i.balance > 0
      and (i.due_date + c.grace_days) < coalesce(p_as_of, current_date)
    for update of i
  ),
  changed as (
    update public.invoices i set state = 'overdue'
    from eligible e where i.id = e.id returning i.id, e.previous_state
  )
  select changed.id, changed.previous_state, 'overdue'::text from changed;
end;
$$;
revoke all on function public.evaluate_overdue(date) from public;
grant execute on function public.evaluate_overdue(date) to authenticated, service_role;

create or replace function public.receipt_html_for_payment(p_payment_id uuid)
returns text language sql security definer set search_path = public
as $$
  select '<article dir="rtl"><header>'
    || case when c.logo_url is null then '' else '<img src="' || c.logo_url || '" alt="" />' end
    || '<h1>قيمة استثمار</h1><h2>'
    || coalesce(c.name_ar, c.name_en, '') || '</h2></header><p>'
    || coalesce(t.name, '') || ' — ' || p.code || '</p><ul>'
    || coalesce((
      select string_agg(
        '<li>قيمة استثمار ' || i.period_month::text || '/' || i.period_year::text
        || ': ' || pa.amount::text || ' ' || p.currency || '</li>',
        '' order by i.period_year, i.period_month
      )
      from public.payment_allocations pa
      join public.invoices i on i.id = pa.invoice_id
      where pa.payment_id = p.id
    ), '')
    || '</ul><strong>' || p.amount::text || ' ' || p.currency
    || '</strong><p>قيمة استثمار للوحدة</p><footer>'
    || coalesce(c.address_ar, c.address_en, '') || ' · '
    || coalesce(c.phone, '') || ' · ' || coalesce(c.map_url, '')
    || ' · ' || coalesce(c.name_ar, c.name_en, '') || '</footer></article>'
  from public.payments p
  join public.tenants t on t.id = p.tenant_id
  left join public.companies c on c.id = p.company_id
  where p.id = p_payment_id
$$;

create or replace function public.tg_sync_payment_receipt()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_visible boolean;
begin
  if new.status <> 'confirmed' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'confirmed' then return new; end if;
  select t.receipt_visible_to_tenant into v_visible
  from public.tenants t where t.id = new.tenant_id;
  insert into public.receipts (
    payment_id, tenant_id, amount, currency, html_snapshot, visible_to_tenant
  ) values (
    new.id, new.tenant_id, new.amount, new.currency,
    public.receipt_html_for_payment(new.id), coalesce(v_visible, false)
  )
  on conflict (payment_id) do update set
    amount = excluded.amount,
    currency = excluded.currency,
    html_snapshot = excluded.html_snapshot;
  return new;
end;
$$;
revoke all on function public.receipt_html_for_payment(uuid) from public;
revoke all on function public.tg_sync_payment_receipt() from public;

drop trigger if exists sync_payment_receipt on public.payments;
create trigger sync_payment_receipt
after insert or update of status on public.payments
for each row execute function public.tg_sync_payment_receipt();


create or replace function public.apply_payment_allocation(
  p_payment_id uuid,
  p_allocations jsonb
)
returns table (invoice_id uuid, applied numeric, new_state text)
language plpgsql security definer set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
  v_allocation record;
  v_invoice public.invoices%rowtype;
  v_allocated numeric(14,3);
  v_requested numeric(14,3);
  v_new_paid numeric(14,3);
  v_new_state public.invoice_states;
  v_grace_days integer;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'payments.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Allocations must be a non-empty JSON array';
  end if;

  select p.* into v_payment
  from public.payments p where p.id = p_payment_id
  for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_payment.status <> 'confirmed' then
    raise exception 'Only confirmed payments can be allocated';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
    where x.invoice_id is null or x.amount is null or x.amount <= 0
  ) then
    raise exception 'Every allocation requires an invoice and a positive amount';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
    group by x.invoice_id having count(*) > 1
  ) then
    raise exception 'Duplicate invoice allocation';
  end if;

  select coalesce(sum(pa.amount), 0) into v_allocated
  from public.payment_allocations pa where pa.payment_id = p_payment_id;
  select coalesce(sum(x.amount), 0) into v_requested
  from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric);
  if v_allocated + v_requested > v_payment.amount then
    raise exception 'Allocations exceed the remaining payment amount';
  end if;

  for v_allocation in
    select x.invoice_id, x.amount
    from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
    order by x.invoice_id
  loop
    select i.* into v_invoice
    from public.invoices i where i.id = v_allocation.invoice_id
    for update;
    if not found then raise exception 'Invoice not found'; end if;
    if v_invoice.tenant_id <> v_payment.tenant_id then
      raise exception 'Invoice and payment tenants do not match';
    end if;
    if v_invoice.state in ('cancelled', 'waived') then
      raise exception 'Cancelled or waived invoices cannot receive allocations';
    end if;
    if v_allocation.amount > v_invoice.balance then
      raise exception 'Allocation exceeds invoice balance';
    end if;

    select c.grace_days into v_grace_days
    from public.contracts c where c.id = v_invoice.contract_id;
    v_new_paid := least(v_invoice.total, v_invoice.paid + v_allocation.amount);
    v_new_state := case
      when v_new_paid >= v_invoice.total then 'paid'::public.invoice_states
      when (v_invoice.due_date + coalesce(v_grace_days, 0)) < current_date then 'overdue'::public.invoice_states
      when v_new_paid > 0 then 'partially_paid'::public.invoice_states
      else 'due'::public.invoice_states
    end;

    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (p_payment_id, v_invoice.id, v_allocation.amount);
    update public.invoices i
    set paid = v_new_paid, state = v_new_state
    where i.id = v_invoice.id;

    invoice_id := v_invoice.id;
    applied := v_allocation.amount;
    new_state := v_new_state::text;
    return next;
  end loop;
  update public.receipts r
  set html_snapshot = public.receipt_html_for_payment(p_payment_id)
  where r.payment_id = p_payment_id;
end;
$$;
revoke all on function public.apply_payment_allocation(uuid, jsonb) from public;
grant execute on function public.apply_payment_allocation(uuid, jsonb) to authenticated, service_role;

create or replace function public.reverse_payment(p_payment_id uuid, p_reason text)
returns table (reversal_payment_id uuid)
language plpgsql security definer set search_path = public
as $$
declare
  v_original public.payments%rowtype;
  v_reversal_id uuid;
  v_allocation public.payment_allocations%rowtype;
  v_invoice public.invoices%rowtype;
  v_new_paid numeric(14,3);
  v_new_state public.invoice_states;
  v_grace_days integer;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'payments.reverse') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A reversal reason is required';
  end if;

  select p.* into v_original
  from public.payments p where p.id = p_payment_id
  for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_original.status <> 'confirmed' or v_original.reversed_by_payment_id is not null then
    raise exception 'Only an unreversed confirmed payment can be reversed';
  end if;
  if exists (
    select 1 from public.payments p
    where p.reversed_by_payment_id = v_original.id and p.status = 'reversed'
  ) then
    raise exception 'Payment has already been reversed';
  end if;

  insert into public.payments (
    code, company_id, tenant_id, account_type, method, amount, currency,
    payment_date, reference, unit_id, note, created_by, status, reversed_by_payment_id
  ) values (
    public.next_payment_code(), v_original.company_id, v_original.tenant_id,
    v_original.account_type, v_original.method, v_original.amount, v_original.currency,
    current_date, trim(p_reason), v_original.unit_id, trim(p_reason), auth.uid(),
    'reversed', v_original.id
  ) returning id into v_reversal_id;

  for v_allocation in
    select pa.* from public.payment_allocations pa
    where pa.payment_id = v_original.id order by pa.invoice_id
  loop
    select i.* into v_invoice
    from public.invoices i where i.id = v_allocation.invoice_id
    for update;
    select c.grace_days into v_grace_days
    from public.contracts c where c.id = v_invoice.contract_id;

    v_new_paid := greatest(0, v_invoice.paid - v_allocation.amount);
    v_new_state := case
      when v_invoice.total = 0 or v_new_paid >= v_invoice.total then 'paid'::public.invoice_states
      when (v_invoice.due_date + coalesce(v_grace_days, 0)) < current_date then 'overdue'::public.invoice_states
      when v_new_paid > 0 then 'partially_paid'::public.invoice_states
      else 'due'::public.invoice_states
    end;

    update public.invoices i
    set paid = v_new_paid, state = v_new_state
    where i.id = v_invoice.id;
    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (v_reversal_id, v_invoice.id, v_allocation.amount);
  end loop;

  update public.payments p set status = 'reversed' where p.id = v_original.id;
  reversal_payment_id := v_reversal_id;
  return next;
end;
$$;
revoke all on function public.reverse_payment(uuid, text) from public;
grant execute on function public.reverse_payment(uuid, text) to authenticated, service_role;

drop policy if exists payment_attachments_delete_staff on storage.objects;
create policy payment_attachments_delete_staff on storage.objects for delete to authenticated using (
  bucket_id = 'payment-attachments'
  and public.is_staff(auth.uid())
  and public.has_permission(auth.uid(), 'payments.update')
);

