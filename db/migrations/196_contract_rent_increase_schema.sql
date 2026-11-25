-- 196_contract_rent_increase_schema.sql
--
-- زيادة إيجار واحدة لكل عقد، تسري من ذكرى بدايته السنوية.
--
-- Contracts already encode this in free text ("Rent increases by 15% after
-- year 2" in CON-00026's notes) and nobody reprices. The three columns make it
-- data; contract_unit_period_amounts makes it money. Once-per-contract is the
-- shape, not a rule to enforce elsewhere.

alter table public.contracts
  add column if not exists increase_after_years integer,
  add column if not exists increase_type text,
  add column if not exists increase_value numeric(14,3);

-- Every populated-branch predicate names a NOT NULL column explicitly: a CHECK
-- that evaluates to NULL passes, so `increase_after_years >= 1` alone would
-- admit a row with only that column set.
alter table public.contracts drop constraint if exists contracts_increase_all_or_none;
alter table public.contracts add constraint contracts_increase_all_or_none check (
  (increase_after_years is null and increase_type is null and increase_value is null)
  or (increase_after_years is not null and increase_after_years >= 1
      and increase_type is not null and increase_type in ('percent', 'fixed')
      and increase_value is not null and increase_value > 0
      and (increase_type <> 'percent' or increase_value <= 100))
);

/**
 * أول شهر تسري فيه الزيادة: بداية العقد + عدد السنوات، مقصوصاً إلى أول الشهر.
 */
create or replace function public.contract_increase_effective_period(p_contract public.contracts)
returns date
language sql
immutable
as $$
  select case
    when p_contract.increase_after_years is null then null
    else date_trunc('month',
           p_contract.start_date + make_interval(years => p_contract.increase_after_years))::date
  end
$$;

/**
 * إيجار كل وحدة في فترة معيّنة، بعد تطبيق الزيادة إن كانت سارية.
 *
 * Percent scales each unit. Fixed is split by largest remainder in whole fils:
 * every unit gets the floor of its exact share, and the leftover fils go one
 * each to the largest fractional parts (ties by line order). Every share is
 * non-negative and the lines sum to base + increase exactly — invoice_items
 * must equal the header.
 */
create or replace function public.contract_unit_period_amounts(
  p_contract_id uuid,
  p_period_start date
)
returns table (unit_id uuid, unit_code text, line_order integer, monthly_amount numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_contract public.contracts%rowtype;
  v_effective date;
  v_base_total numeric(14,3);
  v_total_fils bigint;
begin
  select c.* into v_contract from public.contracts c where c.id = p_contract_id;
  if not found then
    raise exception 'Contract not found';
  end if;

  v_effective := public.contract_increase_effective_period(v_contract);

  if v_effective is null or p_period_start < v_effective then
    return query
      select cu.unit_id, u.code, cu.line_order, cu.monthly_amount
        from public.contract_units cu
        join public.units u on u.id = cu.unit_id
       where cu.contract_id = p_contract_id
       order by cu.line_order, cu.unit_id;
    return;
  end if;

  if v_contract.increase_type = 'percent' then
    return query
      select cu.unit_id, u.code, cu.line_order,
             round(cu.monthly_amount * (1 + v_contract.increase_value / 100), 3)
        from public.contract_units cu
        join public.units u on u.id = cu.unit_id
       where cu.contract_id = p_contract_id
       order by cu.line_order, cu.unit_id;
    return;
  end if;

  select coalesce(sum(cu.monthly_amount), 0) into v_base_total
    from public.contract_units cu where cu.contract_id = p_contract_id;
  v_total_fils := round(v_contract.increase_value * 1000)::bigint;

  return query
    with exact as (
      select cu.unit_id, u.code, cu.line_order, cu.monthly_amount,
             (v_total_fils * cu.monthly_amount / nullif(v_base_total, 0)) as share
        from public.contract_units cu
        join public.units u on u.id = cu.unit_id
       where cu.contract_id = p_contract_id
    ),
    floored as (
      select e.*, floor(e.share)::bigint as fils, (e.share - floor(e.share)) as frac
        from exact e
    ),
    ranked as (
      select f.*, row_number() over (order by f.frac desc, f.line_order, f.unit_id) as rn,
             (v_total_fils - sum(f.fils) over ()) as leftover
        from floored f
    )
    select r.unit_id, r.code, r.line_order,
           r.monthly_amount + (r.fils + case when r.rn <= r.leftover then 1 else 0 end) / 1000.0
      from ranked r
     order by r.line_order, r.unit_id;
end;
$$;

-- Internal pricer only: the four SECURITY DEFINER invoice functions call it as
-- the owner, and no client code does. Granting it to `authenticated` would let
-- a portal tenant pass any contract id and read another tenant's unit rents.
revoke execute on function public.contract_unit_period_amounts(uuid, date) from public, anon, authenticated;
grant execute on function public.contract_unit_period_amounts(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- contract_period_amounts -- re-issued from 170, period-aware since 196
-- ---------------------------------------------------------------------------
-- Copied verbatim from db/migrations/170_free_month_generates_nothing.sql:57-95
-- except the subtotal source, which now routes through the unit pricer so the
-- increase in force for p_period_start is included.
create or replace function public.contract_period_amounts(
  p_contract_id uuid,
  p_period_start date
)
returns table (subtotal numeric, discount numeric, total numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_contract public.contracts%rowtype;
  v_subtotal numeric(14,3);
begin
  select c.* into v_contract from public.contracts c where c.id = p_contract_id;
  if not found then
    raise exception 'Contract not found';
  end if;

  if not exists (
    select 1 from public.contract_units cu where cu.contract_id = v_contract.id
  ) then
    raise exception 'Contract % has no units and cannot be priced. Add at least one unit first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  -- Period-aware since 196: the unit pricer applies the contract's rent
  -- increase once p_period_start reaches the anniversary.
  select coalesce(sum(upa.monthly_amount), 0) into v_subtotal
    from public.contract_unit_period_amounts(v_contract.id, p_period_start) upa;
  v_subtotal := v_subtotal + public.contract_extra_charges_total(p_contract_id);

  subtotal := v_subtotal;
  discount := 0;
  total := v_subtotal;
  return next;
end;
$$;

revoke execute on function public.contract_period_amounts(uuid, date) from public, anon;
grant execute on function public.contract_period_amounts(uuid, date) to authenticated, service_role;
