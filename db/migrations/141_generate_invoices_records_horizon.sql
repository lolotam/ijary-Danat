-- 141_generate_invoices_records_horizon.sql
--
-- Split out of 139 to keep both files under this repository's 500-600 line
-- ceiling (AGENTS.md). 139 owns the horizon column and the free-month and
-- schedule-sync primitives; this file owns the one existing generator that has
-- to be re-issued so it records the horizon it reached.
--
-- Ordering matters: this depends on bump_contract_invoice_horizon from 139, so
-- it must apply after it. Numeric order gives that for free.

-- ---------------------------------------------------------------------------
-- generate_invoices_for_year — copied verbatim from 127, with one addition:
-- it now records the horizon it reached.
--
-- The bump lives here rather than in generate_invoices (120) because every
-- generation path funnels through this function — the explicit admin Generate,
-- backfill_contract_invoices, and regenerate_contract_invoices' re-insert loop.
-- Recording it at the single choke point means no path can widen the schedule
-- without the horizon following.
-- ---------------------------------------------------------------------------
create or replace function public.generate_invoices_for_year(
  p_contract_id uuid default null,
  p_through_year integer default null,
  p_include_past boolean default false
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
  v_line integer;
  v_contract public.contracts%rowtype;
  v_unit record;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_year < 2000 or v_year > 2200 then
    raise exception 'Target year is outside the supported range';
  end if;

  if p_contract_id is not null then
    select c.* into v_contract from public.contracts c where c.id = p_contract_id;
    if v_contract.archived_at is not null then
      raise exception 'Contract % is archived and cannot be billed. Restore it first.',
        v_contract.code using errcode = 'check_violation';
    end if;
    if v_contract.id is not null and not exists (
      select 1 from public.contract_units cu where cu.contract_id = p_contract_id
    ) then
      raise exception 'Contract % has no units and cannot be billed. Add at least one unit first.',
        v_contract.code using errcode = 'check_violation';
    end if;
  end if;

  for v_contract in
    select c.* from public.contracts c
    where (c.state = 'active' or (p_include_past and p_contract_id is not null))
      and (p_contract_id is null or c.id = p_contract_id)
      and c.start_date <= make_date(v_year, 12, 31)
      and c.end_date >= make_date(v_year, 1, 1)
      and c.archived_at is null
      and exists (select 1 from public.contract_units cu where cu.contract_id = c.id)
    order by c.id
  loop
    v_start_month := case
      when v_year = extract(year from current_date)::integer and not p_include_past
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
        if p_include_past and v_period_start > date_trunc('month', current_date)::date then
          continue;
        end if;

        if public.period_in_free_months(v_contract.id, v_period_start) then
          continue;
        end if;

        select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
          from public.contract_units cu where cu.contract_id = v_contract.id;
        -- Discounts are bound to invoices via concession_invoices, never
        -- derived from overlapping date ranges at generation time.
        v_total := v_subtotal;
        v_discount := 0;
        v_invoice_id := null;
        insert into public.invoices (
          code, company_id, contract_id, tenant_id, unit_id, period_year, period_month,
          issue_date, due_date, subtotal, discount, total, paid, state,
          is_visible_to_tenant, idempotency_key
        )
        select public.next_invoice_code(), t.company_id, v_contract.id, v_contract.tenant_id,
          (select cu.unit_id from public.contract_units cu
            where cu.contract_id = v_contract.id
              and (select count(*) from public.contract_units c2
                     where c2.contract_id = v_contract.id) = 1),
          v_year, v_month, current_date,
          make_date(v_year, v_month, v_contract.due_day), v_subtotal, v_discount,
          v_total, 0, 'due', true,
          v_contract.id::text || ':' || v_year::text || ':' || v_month::text
        from public.tenants t where t.id = v_contract.tenant_id
        on conflict on constraint invoices_contract_id_period_year_period_month_key do nothing
        returning invoices.id, invoices.code into v_invoice_id, v_invoice_code;
        if v_invoice_id is null then continue; end if;
        v_line := 1;
        for v_unit in
          select cu.unit_id, cu.monthly_amount, u.code
            from public.contract_units cu
            join public.units u on u.id = cu.unit_id
           where cu.contract_id = v_contract.id
           order by cu.line_order, cu.unit_id
        loop
          insert into public.invoice_items (
            invoice_id, line, unit_id, description_ar, description_en, quantity,
            unit_price, discount_percent, amount, is_concession
          ) values (
            v_invoice_id, v_line, v_unit.unit_id,
            'قيمة استثمار شهرية — ' || v_unit.code,
            'Monthly investment value — ' || v_unit.code,
            1, v_unit.monthly_amount, 0, v_unit.monthly_amount, false
          );
          v_line := v_line + 1;
        end loop;
        id := v_invoice_id; code := v_invoice_code; contract_id := v_contract.id;
        period_year := v_year; period_month := v_month; total := v_total; state := 'due';
        return next;
      end loop;
    end if;

    -- The range this call was ASKED to cover, not the range it inserted rows
    -- for. A year whose every month is free inserts nothing, and a horizon
    -- derived only from surviving invoices would never record that the
    -- operator had generated through it.
    if v_start_month <= v_end_month then
      perform public.bump_contract_invoice_horizon(
        v_contract.id,
        case
          when p_include_past
            then least(make_date(v_year, v_end_month, 1),
                       date_trunc('month', current_date)::date)
          else make_date(v_year, v_end_month, 1)
        end
      );
    end if;
  end loop;
end;
$$;

revoke execute on function public.generate_invoices_for_year(uuid, integer, boolean)
  from public, anon;
grant execute on function public.generate_invoices_for_year(uuid, integer, boolean)
  to authenticated, service_role;
