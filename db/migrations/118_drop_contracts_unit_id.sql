-- 118_drop_contracts_unit_id.sql
--
-- Last step of the multi-unit-contracts feature: drop contracts.unit_id.
-- contract_units (migration 110) has been the source of truth for which
-- units a contract holds since migrations 111-117 moved every SQL reader
-- (occupancy, electricity's tenant-resolution trigger, bulk import,
-- close-out/restore, portal RLS, invoice generation/regeneration,
-- save_contract_with_units) off it.
--
-- This is NOT a safety net. PostgreSQL does not track column references
-- inside plpgsql (or old-style $$-quoted sql) function bodies as
-- dependencies, so `alter table ... drop column` succeeds even if a function
-- body still names contracts.unit_id -- that function then fails at RUNTIME,
-- on a money path, with `record "v_contract" has no field "unit_id"`. There
-- are no views over contracts to catch it either. The SQL test suite
-- (src/db/dropContractsUnitId.sqltest.ts) is the only real check, and it is
-- what found Section 0 below: 113_electricity_and_bulk_import.sql moved
-- validate_electricity_charge_insert off contracts.unit_id but not its
-- sibling public.generate_electricity_charges, which was never re-issued
-- after 09_phase7_electricity.sql and would have failed the moment this
-- migration's Section 1 ran.
-- ---------------------------------------------------------------------------

------------------------------------------------------------
-- 0. Re-issue generate_electricity_charges
--    (live definition was still 09_phase7_electricity.sql, ~line 545 —
--    missed by 113, which only moved the OTHER electricity function,
--    validate_electricity_charge_insert, onto contract_units.)
--
--    Only change: the per-unit active-tenant lookup joins through
--    contract_units instead of reading contracts.unit_id directly, same
--    shape as 113's fix to validate_electricity_charge_insert. The lateral
--    subquery's contracts alias is renamed `ct` (was `contracts`) only
--    because the outer query already uses `c` for the subquery's own output
--    column (`c.tenant_id`); everything else, including the returned
--    columns, the permission check, the eligibility predicate and the
--    insert, is byte-identical to the 09 definition.
------------------------------------------------------------

create or replace function public.generate_electricity_charges(
  p_period_year integer,
  p_period_month integer,
  p_unit_id uuid default null
)
returns table (
  charge_id uuid,
  code text,
  unit_id uuid,
  amount numeric,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_start date;
  v_period_end date;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'electricity.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if p_period_year < 2000 or p_period_year > 2200
    or p_period_month < 1 or p_period_month > 12 then
    raise exception 'Electricity charge period is invalid';
  end if;

  v_period_start := make_date(p_period_year, p_period_month, 1);
  v_period_end := (v_period_start + interval '1 month - 1 day')::date;

  return query
  with eligible as (
    select em.id as meter_id, em.unit_id, em.ownership, em.tariff_id,
      mr.id as reading_id, mr.consumption_kwh,
      case when em.ownership = 'tenant_owned' then c.tenant_id else null end as tenant_id,
      et.currency
    from public.electricity_meters em
    join public.meter_readings mr on mr.meter_id = em.id
      and mr.period_year = p_period_year and mr.period_month = p_period_month
    join public.electricity_tariffs et on et.id = em.tariff_id and et.is_active
    left join lateral (
      select ct.tenant_id
      from public.contract_units cu
      join public.contracts ct on ct.id = cu.contract_id
      where cu.unit_id = em.unit_id
        and ct.state = 'active'
        and ct.start_date <= v_period_end
        and ct.end_date >= v_period_start
      order by ct.start_date desc, ct.id
      limit 1
    ) c on true
    where em.is_active and (p_unit_id is null or em.unit_id = p_unit_id)
      and (em.ownership = 'company_owned' or c.tenant_id is not null)
  ), inserted as (
    insert into public.electricity_charges (
      meter_id, unit_id, tenant_id, reading_id, period_year, period_month,
      consumption_kwh, amount, currency, status
    )
    select e.meter_id, e.unit_id, e.tenant_id, e.reading_id,
      p_period_year, p_period_month, e.consumption_kwh,
      public.compute_electricity_amount(e.tariff_id, e.consumption_kwh),
      e.currency, 'draft'
    from eligible e
    on conflict (meter_id, period_year, period_month) do nothing
    returning electricity_charges.id, electricity_charges.code,
      electricity_charges.unit_id, electricity_charges.amount, electricity_charges.status
  )
  select inserted.id, inserted.code, inserted.unit_id,
    inserted.amount, inserted.status from inserted;
end;
$$;

------------------------------------------------------------
-- 0b. Re-issue sync_unit_status_for — comment only, body unchanged
--    (live definition is 76_unit_status_lifecycle.sql, ~line 118; already
--    shipped, so it is re-issued here rather than edited in place —
--    supersede-by-number, same reasoning as Section 0 above.)
--
--    Not a functional fix: nothing in this body ever read contracts.unit_id
--    as code. It is re-issued only because one of its comments now describes
--    a column that no longer exists ("`contracts.unit_id` is ON DELETE
--    RESTRICT") — that guarantee moved to `contract_units.unit_id` in
--    migration 110 (`references public.units(id) on delete restrict`), which
--    is what actually stops a unit from vanishing while a contract still
--    holds it today. Every other line, including the security-definer
--    rationale and the locking comment, is byte-identical to 76's.
------------------------------------------------------------

create or replace function public.sync_unit_status_for(_unit uuid)
returns public.unit_status
language plpgsql
security definer
set search_path = public
as $$
declare
  _current public.unit_status;
  _next public.unit_status;
begin
  if _unit is null then
    return null;
  end if;

  -- `for update` so two concurrent contract writes touching the same unit
  -- cannot interleave into a stale value. The trigger below has already locked
  -- every affected unit in a deterministic order; this re-lock is a no-op there
  -- and keeps the function safe when called on its own (the backfill, or by
  -- hand).
  select status into _current
    from public.units
   where id = _unit
     for update;

  -- Defensive only. contract_units.unit_id is ON DELETE RESTRICT (migration
  -- 110), so a unit cannot vanish while a contract still holds it — but
  -- sync_unit_status_for is also called from the backfill and could be
  -- called by hand, and a null return beats an unhandled no-data error.
  if not found then
    return null;
  end if;

  _next := public.compute_unit_status(_unit, _current);

  -- Guarded so a no-op contract save does not bump units.updated_at.
  update public.units
     set status = _next
   where id = _unit
     and status is distinct from _next;

  return _next;
end;
$$;

------------------------------------------------------------
-- 1. Drop the column. LAST, after every SQL reader has moved.
------------------------------------------------------------

-- The legacy uniqueness index goes with the column it covers. Migration 110
-- RENAMED rather than dropped it (to one_active_contract_per_unit_legacy),
-- because dropping it there removed the double-booking guard from every path
-- still writing contracts.unit_id directly — bulkImportContracts.sqltest.ts
-- caught it by letting a duplicate live-unit contract through. It is safe to
-- drop only here, because after this statement no such path exists.
drop index if exists public.one_active_contract_per_unit_legacy;
drop index if exists public.contracts_unit_id_idx;
alter table public.contracts drop column if exists unit_id;
