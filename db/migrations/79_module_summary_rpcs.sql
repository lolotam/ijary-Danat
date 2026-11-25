-- 79 — per-module summary RPCs for the admin list-page KPI cards.
--
-- One function per module, each taking the SAME filter arguments as its list
-- query so the cards agree with the table beneath them. Follows the shape of
-- get_budget_summary / get_deposit_total in migration 08.
--
-- These are `security definer`, so RLS does not apply and the has_permission
-- guard IS the access control. Note the revoke names `anon` explicitly: the
-- older migrations only `revoke ... from public`, which does not reach anon —
-- Supabase grants it directly through default privileges.

------------------------------------------------------------
-- Payments
------------------------------------------------------------

create or replace function public.get_payments_summary(
  p_search text default null,
  p_method text default null,
  p_status text default null,
  p_tenant_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_full_total numeric(14,3); v_full_count bigint;
  v_partial_total numeric(14,3); v_partial_count bigint;
  v_insurance_total numeric(14,3); v_insurance_count bigint;
  v_refund_total numeric(14,3); v_refund_count bigint;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'payments.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- Same predicate get_budget_summary uses for `collections`, so this card and
  -- the budget report cannot disagree.
  select coalesce(sum(p.amount), 0), count(*)
    into v_full_total, v_full_count
  from public.payments p
  where p.status = 'confirmed'
    and p.reversed_by_payment_id is null
    and (p_method is null or p.method::text = p_method)
    and (p_status is null or p.status::text = p_status)
    and (p_tenant_id is null or p.tenant_id = p_tenant_id)
    and (p_search is null or p.code ilike '%' || p_search || '%'
      or coalesce(p.reference, '') ilike '%' || p_search || '%'
      or exists (
        select 1 from public.tenants t
        where t.id = p.tenant_id
          and (t.code ilike '%' || p_search || '%' or t.name ilike '%' || p_search || '%')
      ));

  -- partial_payments / insurance_payments / refunds are plain ledgers: no code
  -- and no status column, so only p_tenant_id is expressible against them.
  select coalesce(sum(x.amount), 0), count(*) into v_partial_total, v_partial_count
  from public.partial_payments x
  where (p_tenant_id is null or x.tenant_id = p_tenant_id);

  select coalesce(sum(x.amount), 0), count(*) into v_insurance_total, v_insurance_count
  from public.insurance_payments x
  where (p_tenant_id is null or x.tenant_id = p_tenant_id);

  select coalesce(sum(x.amount), 0), count(*) into v_refund_total, v_refund_count
  from public.refunds x
  where (p_tenant_id is null or x.tenant_id = p_tenant_id);

  return jsonb_build_object(
    'full',      jsonb_build_object('total', v_full_total,      'count', v_full_count),
    'partial',   jsonb_build_object('total', v_partial_total,   'count', v_partial_count),
    'insurance', jsonb_build_object('total', v_insurance_total, 'count', v_insurance_count),
    'refunds',   jsonb_build_object('total', v_refund_total,    'count', v_refund_count),
    -- Insurance is a holding, not income — it does not move net. Same rule as
    -- BudgetSummary (src/hooks/useBudget.ts).
    'net', v_full_total + v_partial_total - v_refund_total
  );
end;
$$;

revoke all on function public.get_payments_summary(text, text, text, uuid) from public, anon;
grant execute on function public.get_payments_summary(text, text, text, uuid)
  to authenticated, service_role;

------------------------------------------------------------
-- Expenses
------------------------------------------------------------

create or replace function public.get_expenses_summary(
  p_search text default null,
  p_class text default null,
  p_category_id uuid default null,
  p_property_id uuid default null,
  p_status text default null,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_total numeric(14,3); v_count bigint;
  v_approved numeric(14,3); v_approved_count bigint;
  v_pending numeric(14,3); v_pending_count bigint;
  v_month numeric(14,3); v_month_count bigint;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'expenses.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- Predicates mirror fetchExpenses() in src/hooks/useExpenses.ts exactly.
  -- Note the inline subquery rather than a CTE: every `select ... into` in
  -- db/migrations/ uses this form (see get_budget_summary in migration 08).
  select
    coalesce(sum(f.amount), 0), count(*),
    coalesce(sum(f.amount) filter (where f.status = 'approved'), 0),
    count(*) filter (where f.status = 'approved'),
    coalesce(sum(f.amount) filter (where f.status = 'pending'), 0),
    count(*) filter (where f.status = 'pending')
  into v_total, v_count, v_approved, v_approved_count, v_pending, v_pending_count
  from (
    select e.*
    from public.expenses e
    where (p_class is null or e.class::text = p_class)
      and (p_category_id is null or e.category_id = p_category_id)
      and (p_property_id is null or e.property_id = p_property_id)
      and (p_status is null or e.status::text = p_status)
      and (p_from is null or e.expense_date >= p_from)
      and (p_to is null or e.expense_date <= p_to)
      and (p_search is null or e.code ilike '%' || p_search || '%'
        or coalesce(e.payee, '') ilike '%' || p_search || '%'
        or coalesce(e.cost_center, '') ilike '%' || p_search || '%'
        or coalesce(e.note, '') ilike '%' || p_search || '%')
  ) f;

  -- `this month` deliberately ignores p_from/p_to — it is an absolute reference
  -- point, not a slice of the current filter.
  select coalesce(sum(e.amount), 0), count(*)
    into v_month, v_month_count
  from public.expenses e
  where e.expense_date >= date_trunc('month', current_date)::date
    and e.expense_date < (date_trunc('month', current_date) + interval '1 month')::date;

  return jsonb_build_object(
    'total',      jsonb_build_object('amount', v_total,    'count', v_count),
    'approved',   jsonb_build_object('amount', v_approved, 'count', v_approved_count),
    'pending',    jsonb_build_object('amount', v_pending,  'count', v_pending_count),
    'this_month', jsonb_build_object('amount', v_month,    'count', v_month_count)
  );
end;
$$;

revoke all on function public.get_expenses_summary(text, text, uuid, uuid, text, date, date)
  from public, anon;
grant execute on function public.get_expenses_summary(text, text, uuid, uuid, text, date, date)
  to authenticated, service_role;

------------------------------------------------------------
-- Contracts
------------------------------------------------------------

create or replace function public.get_contracts_summary(
  p_search text default null,
  p_state text default null,
  p_tenant_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_total bigint; v_active bigint; v_expiring bigint; v_ended bigint;
  v_next_expiry date; v_monthly numeric(14,3);
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'contracts.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select
    count(*),
    count(*) filter (where f.state = 'active'),
    -- There is no `expiring` state. Migration 76: nothing in this codebase
    -- transitions a contract to `expired`, so the window is computed from
    -- end_date over live contracts.
    count(*) filter (
      where f.state = 'active'
        and f.end_date between current_date and current_date + 60
    ),
    count(*) filter (where f.state in ('expired', 'terminated')),
    min(f.end_date) filter (
      where f.state = 'active' and f.end_date >= current_date
    ),
    coalesce(sum(f.monthly_amount) filter (where f.state = 'active'), 0)
  into v_total, v_active, v_expiring, v_ended, v_next_expiry, v_monthly
  from (
    select c.*
    from public.contracts c
    where c.archived_at is null                      -- matches useContracts
      and (p_state is null or c.state::text = p_state)
      and (p_tenant_id is null or c.tenant_id = p_tenant_id)
      and (p_search is null or c.code ilike '%' || p_search || '%')
  ) f;

  return jsonb_build_object(
    'total', v_total,
    'active', v_active,
    'expiring_60d', v_expiring,
    'ended', v_ended,
    'next_expiry', v_next_expiry,
    'monthly_amount', v_monthly,
    'annual_amount', v_monthly * 12
  );
end;
$$;

revoke all on function public.get_contracts_summary(text, text, uuid) from public, anon;
grant execute on function public.get_contracts_summary(text, text, uuid)
  to authenticated, service_role;

------------------------------------------------------------
-- Tenants
------------------------------------------------------------

create or replace function public.get_tenants_summary(
  p_search text default null,
  p_category text default null,
  p_lifecycle text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_total bigint; v_active bigint; v_blocked bigint;
  v_arrears numeric(14,3); v_arrears_tenants bigint;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'tenants.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- Two statements rather than one: joining `invoices` into the same select
  -- would multiply the tenant rows and corrupt the count(*) aggregates.
  select
    count(*),
    count(*) filter (where t.lifecycle = 'active'),
    count(*) filter (where t.lifecycle in ('blocked', 'inactive'))
  into v_total, v_active, v_blocked
  from public.tenants t
  where t.archived_at is null                        -- matches useTenants
    and (p_category is null or t.category::text = p_category)
    and (p_lifecycle is null or t.lifecycle::text = p_lifecycle)
    and (p_search is null or t.code ilike '%' || p_search || '%'
      or t.name ilike '%' || p_search || '%'
      or coalesce(t.mobile, '') ilike '%' || p_search || '%'
      or coalesce(t.email, '') ilike '%' || p_search || '%');

  select coalesce(sum(i.balance), 0), count(distinct i.tenant_id)
  into v_arrears, v_arrears_tenants
  from public.invoices i
  join public.tenants t on t.id = i.tenant_id
  where i.state = 'overdue' and i.balance > 0
    and t.archived_at is null
    and (p_category is null or t.category::text = p_category)
    and (p_lifecycle is null or t.lifecycle::text = p_lifecycle)
    and (p_search is null or t.code ilike '%' || p_search || '%'
      or t.name ilike '%' || p_search || '%'
      or coalesce(t.mobile, '') ilike '%' || p_search || '%'
      or coalesce(t.email, '') ilike '%' || p_search || '%');

  return jsonb_build_object(
    'total', v_total,
    'active', v_active,
    'blocked_inactive', v_blocked,
    'arrears', jsonb_build_object('amount', v_arrears, 'tenants', v_arrears_tenants)
  );
end;
$$;

revoke all on function public.get_tenants_summary(text, text, text) from public, anon;
grant execute on function public.get_tenants_summary(text, text, text)
  to authenticated, service_role;

------------------------------------------------------------
-- Units
------------------------------------------------------------

create or replace function public.get_units_summary(
  p_search text default null,
  p_property_id uuid default null,
  p_building_id uuid default null,
  p_status text default null,
  p_type text default null,
  p_meter text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_total bigint; v_occupied bigint; v_vacant bigint; v_maintenance bigint;
  v_rent numeric(14,3);
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'units.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select
    count(*),
    -- `occupied` is trigger-derived from an active contract (migration 76) and
    -- cannot be written by the app, so reading the column is authoritative.
    count(*) filter (where u.status = 'occupied'),
    count(*) filter (where u.status = 'vacant'),
    count(*) filter (where u.status = 'under_maintenance'),
    coalesce(sum(coalesce(u.default_rent, 0)), 0)
  into v_total, v_occupied, v_vacant, v_maintenance, v_rent
  from public.units u
  where (p_property_id is null or u.property_id = p_property_id)
    and (p_building_id is null or u.building_id = p_building_id)
    and (p_status is null or u.status::text = p_status)
    and (p_type is null or u.type::text = p_type)
    and (p_meter is null or u.electricity_meter_ownership::text = p_meter)
    and (p_search is null or u.code ilike '%' || p_search || '%'
      or u.name ilike '%' || p_search || '%');

  return jsonb_build_object(
    'total', v_total,
    'occupied', v_occupied,
    'vacant', v_vacant,
    'under_maintenance', v_maintenance,
    'rent_potential', v_rent
  );
end;
$$;

revoke all on function public.get_units_summary(text, uuid, uuid, text, text, text)
  from public, anon;
grant execute on function public.get_units_summary(text, uuid, uuid, text, text, text)
  to authenticated, service_role;
