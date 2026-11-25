-- 56_refunds_partial_insurance.sql
--
-- T13: the Payment screen becomes Payment and Refund.
--
--   T13a refunds            — money returned to a tenant, with an after-action
--   T13b partial payments   — DELIBERATELY INERT records (see below)
--   T13c insurance payments — the tenant's deposit held with us
--
-- Plus get_budget_summary v2, which gains two keys and changes `net`.

-- ---------------------------------------------------------------------------
-- 1. Enum
-- ---------------------------------------------------------------------------

-- `create type if not exists` IS NOT VALID POSTGRES. Migration 52 used it and
-- broke clean-database provisioning for every migration numbered after it,
-- because scripts/test-db.sh applies with ON_ERROR_STOP=1. This is the idiom
-- every other type in this repo uses.
do $$ begin
  create type public.refund_post_actions as enum ('archive', 'freeze', 'store');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Archive markers
-- ---------------------------------------------------------------------------

-- "Archived" means hidden from normal views with the portal login disabled —
-- never that financial history was deleted. Invoices, payments and receipts all
-- survive an archive; refunds.sqltest.ts asserts that.
--
-- Deliberately a nullable timestamp rather than a new `tenant_lifecycle` value.
-- Migration 54 made lifecycle *derived* from contracts with exactly one sticky
-- state (`blocked`); an `archived` member would have to be sticky too, giving
-- the enum a second sticky value and reopening the argument Batch C settled.
-- A timestamp is orthogonal to that and records *when*, which an enum cannot.
alter table public.tenants add column if not exists archived_at timestamptz;
alter table public.contracts add column if not exists archived_at timestamptz;

create index if not exists tenants_archived_at_idx on public.tenants (archived_at);
create index if not exists contracts_archived_at_idx on public.contracts (archived_at);

-- ---------------------------------------------------------------------------
-- 3. Refunds
-- ---------------------------------------------------------------------------

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete set null,
  contract_id uuid references public.contracts(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  -- Snapshot of where the tenant was, so a refund still reads correctly after a
  -- unit is reassigned or a building is renamed.
  unit_id uuid references public.units(id) on delete set null,
  building_id uuid references public.buildings(id) on delete set null,
  amount numeric(14,3) not null check (amount > 0),
  currency text not null default 'KWD',
  refund_date date not null default current_date,
  reason text,
  post_action public.refund_post_actions not null default 'store',
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.refunds enable row level security;

drop policy if exists refunds_staff_read on public.refunds;
create policy refunds_staff_read on public.refunds for select to authenticated
  using (public.is_staff(auth.uid()));
drop policy if exists refunds_insert_permitted on public.refunds;
create policy refunds_insert_permitted on public.refunds for insert to authenticated
  with check (public.has_permission(auth.uid(), 'refunds.create'));
drop policy if exists refunds_update_permitted on public.refunds;
create policy refunds_update_permitted on public.refunds for update to authenticated
  using (public.has_permission(auth.uid(), 'refunds.update'))
  with check (public.has_permission(auth.uid(), 'refunds.update'));
drop policy if exists refunds_delete_permitted on public.refunds;
create policy refunds_delete_permitted on public.refunds for delete to authenticated
  using (public.has_permission(auth.uid(), 'refunds.delete'));
drop policy if exists refunds_service_role_all on public.refunds;
create policy refunds_service_role_all on public.refunds for all to service_role
  using (true) with check (true);

drop trigger if exists refunds_set_updated_at on public.refunds;
create trigger refunds_set_updated_at before update on public.refunds
  for each row execute function public.tg_set_updated_at();

create index if not exists refunds_tenant_idx on public.refunds (tenant_id);
create index if not exists refunds_date_idx on public.refunds (refund_date);

-- ---------------------------------------------------------------------------
-- 4. Partial payments — inert by design
-- ---------------------------------------------------------------------------

-- These records touch NOTHING in the money path:
--   * no payment_allocations rows
--   * no effect on invoices.paid or invoices.state
--   * excluded from get_budget_summary
--
-- The isolation is the feature, not an omission. refunds.sqltest.ts asserts
-- that creating one leaves every invoice balance and every budget figure
-- unchanged — without that test this table would drift into the money path the
-- first time somebody "improved" it.
create table if not exists public.partial_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete set null,
  contract_id uuid references public.contracts(id) on delete restrict,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  -- Which invoice the note refers to. Nullable, and carries no financial
  -- meaning: it does not allocate against that invoice.
  invoice_id uuid references public.invoices(id) on delete set null,
  unit_id uuid references public.units(id) on delete set null,
  building_id uuid references public.buildings(id) on delete set null,
  amount numeric(14,3) not null check (amount > 0),
  currency text not null default 'KWD',
  paid_date date not null default current_date,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.partial_payments enable row level security;

drop policy if exists partial_payments_staff_read on public.partial_payments;
create policy partial_payments_staff_read on public.partial_payments for select to authenticated
  using (public.is_staff(auth.uid()));
drop policy if exists partial_payments_insert_permitted on public.partial_payments;
create policy partial_payments_insert_permitted on public.partial_payments for insert to authenticated
  with check (public.has_permission(auth.uid(), 'partial_payments.create'));
drop policy if exists partial_payments_update_permitted on public.partial_payments;
create policy partial_payments_update_permitted on public.partial_payments for update to authenticated
  using (public.has_permission(auth.uid(), 'partial_payments.update'))
  with check (public.has_permission(auth.uid(), 'partial_payments.update'));
drop policy if exists partial_payments_delete_permitted on public.partial_payments;
create policy partial_payments_delete_permitted on public.partial_payments for delete to authenticated
  using (public.has_permission(auth.uid(), 'partial_payments.delete'));
drop policy if exists partial_payments_service_role_all on public.partial_payments;
create policy partial_payments_service_role_all on public.partial_payments for all to service_role
  using (true) with check (true);

drop trigger if exists partial_payments_set_updated_at on public.partial_payments;
create trigger partial_payments_set_updated_at before update on public.partial_payments
  for each row execute function public.tg_set_updated_at();

create index if not exists partial_payments_tenant_idx on public.partial_payments (tenant_id);

-- ---------------------------------------------------------------------------
-- 5. Insurance payments
-- ---------------------------------------------------------------------------

-- NOT public.deposits. That table models *bank* deposits — bank_name,
-- deposit_date, attachment_path, and no tenant or contract link at all. It
-- answers "what did we bank this week", not "what insurance is this tenant
-- holding with us". Reusing it would also mean reusing the `deposits` key in
-- get_budget_summary, which already backs a shipped KPI card
-- (BudgetDashboard.tsx) — silently changing what that card means.
create table if not exists public.insurance_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete set null,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  unit_id uuid references public.units(id) on delete set null,
  building_id uuid references public.buildings(id) on delete set null,
  amount numeric(14,3) not null check (amount > 0),
  currency text not null default 'KWD',
  collected_date date not null default current_date,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One insurance record per contract: activating a contract twice must not
  -- accumulate duplicate holdings.
  unique (contract_id)
);

alter table public.insurance_payments enable row level security;

drop policy if exists insurance_payments_staff_read on public.insurance_payments;
create policy insurance_payments_staff_read on public.insurance_payments for select to authenticated
  using (public.is_staff(auth.uid()));
drop policy if exists insurance_payments_insert_permitted on public.insurance_payments;
create policy insurance_payments_insert_permitted on public.insurance_payments for insert to authenticated
  with check (public.has_permission(auth.uid(), 'insurance.create'));
drop policy if exists insurance_payments_update_permitted on public.insurance_payments;
create policy insurance_payments_update_permitted on public.insurance_payments for update to authenticated
  using (public.has_permission(auth.uid(), 'insurance.update'))
  with check (public.has_permission(auth.uid(), 'insurance.update'));
drop policy if exists insurance_payments_delete_permitted on public.insurance_payments;
create policy insurance_payments_delete_permitted on public.insurance_payments for delete to authenticated
  using (public.has_permission(auth.uid(), 'insurance.delete'));
drop policy if exists insurance_payments_service_role_all on public.insurance_payments;
create policy insurance_payments_service_role_all on public.insurance_payments for all to service_role
  using (true) with check (true);

drop trigger if exists insurance_payments_set_updated_at on public.insurance_payments;
create trigger insurance_payments_set_updated_at before update on public.insurance_payments
  for each row execute function public.tg_set_updated_at();

create index if not exists insurance_payments_tenant_idx on public.insurance_payments (tenant_id);

-- ---------------------------------------------------------------------------
-- 6. Permissions
-- ---------------------------------------------------------------------------

insert into public.permissions (code, module, action, is_system)
select m.module || '.' || a.action, m.module, a.action, true
from (values ('refunds'), ('partial_payments'), ('insurance')) as m(module)
cross join (values ('create'), ('read'), ('update'), ('delete'), ('export')) as a(action)
on conflict (code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'admin'::public.app_role, p.code
from public.permissions p
where p.module in ('refunds', 'partial_payments', 'insurance')
on conflict (role, permission_code) do nothing;

-- Mirrors the accountant's existing payments/deposits/expenses grant: they may
-- record and correct, but not delete.
insert into public.role_permissions (role, permission_code)
select 'accountant'::public.app_role, p.code
from public.permissions p
where p.module in ('refunds', 'partial_payments', 'insurance')
  and p.action in ('create', 'read', 'update', 'export')
on conflict (role, permission_code) do nothing;

-- ---------------------------------------------------------------------------
-- 7. get_budget_summary v2
-- ---------------------------------------------------------------------------

-- THIS FILE NOW HOLDS THE LIVE DEFINITION. It was previously defined only in
-- 08_phase6_expenses_deposits_budget.sql; anyone reading that body after this
-- migration is reading a stale one. Same supersede-by-number pattern migration
-- 44 uses for build_scheduled_report_html.
--
-- Changes: `refunds` and `insurance_collected` are new keys, and `net` becomes
-- collections - expenses - refunds. A refund is money that left, so a net
-- ignoring it overstated. That KPI moving is intended.
create or replace function public.get_budget_summary(
  p_from date,
  p_to date,
  p_property_id uuid default null,
  p_building_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_collections numeric(14,3);
  v_deposits numeric(14,3);
  v_expenses numeric(14,3);
  v_refunds numeric(14,3);
  v_insurance numeric(14,3);
  v_categories jsonb;
  v_months jsonb;
begin
  if p_to < p_from then raise exception 'Invalid date range'; end if;
  if auth.role() = 'authenticated' and not public.has_permission(auth.uid(), 'reports.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- reverse_payment writes POSITIVE mirror allocations
  -- (05_phase3_invoices_payments.sql:656), so summing allocations would
  -- double-count a reversed payment. Filtering on the payment row is what makes
  -- this correct, and every aggregate below follows the same predicate.
  select coalesce(sum(p.amount), 0) into v_collections
  from public.payments p left join public.units u on u.id = p.unit_id
  where p.status = 'confirmed' and p.reversed_by_payment_id is null
    and p.payment_date between p_from and p_to
    and (p_property_id is null or u.property_id = p_property_id)
    and (p_building_id is null or u.building_id = p_building_id);

  select coalesce(sum(d.amount), 0) into v_deposits from public.deposits d
  where d.status = 'confirmed' and d.deposit_date between p_from and p_to;

  select coalesce(sum(e.amount), 0) into v_expenses
  from public.expenses e left join public.units u on u.id = e.unit_id
  where e.status = 'approved' and e.expense_date between p_from and p_to
    and (p_property_id is null or e.property_id = p_property_id or u.property_id = p_property_id)
    and (p_building_id is null or e.building_id = p_building_id or u.building_id = p_building_id);

  select coalesce(sum(r.amount), 0) into v_refunds
  from public.refunds r left join public.units u on u.id = r.unit_id
  where r.refund_date between p_from and p_to
    and (p_property_id is null or u.property_id = p_property_id)
    and (p_building_id is null or r.building_id = p_building_id or u.building_id = p_building_id);

  select coalesce(sum(ins.amount), 0) into v_insurance
  from public.insurance_payments ins left join public.units u on u.id = ins.unit_id
  where ins.collected_date between p_from and p_to
    and (p_property_id is null or u.property_id = p_property_id)
    and (p_building_id is null or ins.building_id = p_building_id or u.building_id = p_building_id);

  -- public.partial_payments is deliberately absent from every aggregate here.

  select coalesce(jsonb_agg(jsonb_build_object('category_id', x.category_id, 'code', x.code,
    'name_ar', x.name_ar, 'name_en', x.name_en, 'amount', x.amount) order by x.amount desc), '[]'::jsonb)
  into v_categories from (
    select e.category_id, coalesce(c.code, 'uncategorized') code,
      coalesce(c.name_ar, 'غير مصنف') name_ar, coalesce(c.name_en, 'Uncategorized') name_en,
      sum(e.amount)::numeric(14,3) amount
    from public.expenses e left join public.expense_categories c on c.id = e.category_id
    left join public.units u on u.id = e.unit_id
    where e.status = 'approved' and e.expense_date between p_from and p_to
      and (p_property_id is null or e.property_id = p_property_id or u.property_id = p_property_id)
      and (p_building_id is null or e.building_id = p_building_id or u.building_id = p_building_id)
    group by e.category_id, c.code, c.name_ar, c.name_en
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month_start, 'YYYY-MM'),
    'collections', coalesce(p.total, 0), 'expenses', coalesce(e.total, 0)) order by m.month_start), '[]'::jsonb)
  into v_months
  from generate_series(date_trunc('month', p_from)::date, date_trunc('month', p_to)::date, interval '1 month') m(month_start)
  left join lateral (
    select sum(pm.amount)::numeric(14,3) total from public.payments pm
    left join public.units u on u.id = pm.unit_id
    where pm.status = 'confirmed' and pm.reversed_by_payment_id is null
      and pm.payment_date >= m.month_start and pm.payment_date < m.month_start + interval '1 month'
      and pm.payment_date between p_from and p_to
      and (p_property_id is null or u.property_id = p_property_id)
      and (p_building_id is null or u.building_id = p_building_id)
  ) p on true
  left join lateral (
    select sum(ex.amount)::numeric(14,3) total from public.expenses ex
    left join public.units u on u.id = ex.unit_id
    where ex.status = 'approved'
      and ex.expense_date >= m.month_start and ex.expense_date < m.month_start + interval '1 month'
      and ex.expense_date between p_from and p_to
      and (p_property_id is null or ex.property_id = p_property_id or u.property_id = p_property_id)
      and (p_building_id is null or ex.building_id = p_building_id or u.building_id = p_building_id)
  ) e on true;

  return jsonb_build_object(
    'collections', v_collections,
    'deposits', v_deposits,
    'expenses', v_expenses,
    'refunds', v_refunds,
    'insurance_collected', v_insurance,
    'net', v_collections - v_expenses - v_refunds,
    'categories', v_categories,
    'months', v_months
  );
end;
$$;

revoke all on function public.get_budget_summary(date, date, uuid, uuid) from public;
grant execute on function public.get_budget_summary(date, date, uuid, uuid)
  to authenticated, service_role;
