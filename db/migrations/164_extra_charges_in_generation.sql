-- 164_extra_charges_in_generation.sql
--
-- Task 4: teach the two functions that PRICE a period from scratch to include
-- the contract's recurring extra charges (migration 163). 165 does the same
-- for the two that REPRICE an existing invoice; 166 teaches the save RPC to
-- write them.
--
-- Four functions in this database write an invoice's subtotal and its items.
-- Two of them derive the subtotal by summing contract_units inline
-- (generate_invoices_for_year, sync_contract_invoice_schedule's insert branch)
-- and two ask contract_period_amounts (regenerate_contract_invoices,
-- sync_contract_invoice_schedule's reprice branch). Missing any one of them
-- would leave a path that bills rent alone -- silently, since the invoice
-- still balances against its own items.
--
-- Supersede-by-number: SQL functions are `create or replace`, so the LIVE body
-- of each is whichever migration file with the highest number defines it.
-- Verified by grepping every migration for `create or replace function
-- public.<name>(` before copying:
--   contract_period_amounts       -> 127_concession_invoices.sql (highest)
--   generate_invoices_for_year    -> 141_generate_invoices_records_horizon.sql
-- Both bodies below are copied verbatim from those files and edited only where
-- marked. Neither signature nor `returns table (...)` row type changes, so
-- plain `create or replace` stays legal -- no `drop function` in this file.

-- ---------------------------------------------------------------------------
-- 1. append_extra_charge_items -- the one definition of an extra-charge line
-- ---------------------------------------------------------------------------
-- Three of the four pricing functions need to emit these lines, and a
-- hand-copied insert in each is three places for the description or the
-- ordering to drift. Returns the next free line number so the caller can go on
-- numbering from where this left off.
--
-- `unit_id` is null: a service charge is raised by the contract, not by one of
-- its units, and attributing it to an arbitrary unit would corrupt the
-- per-unit revenue attribution that invoice_items.unit_id exists to carry.
create or replace function public.append_extra_charge_items(
  p_invoice_id uuid,
  p_contract_id uuid,
  p_start_line integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line integer := p_start_line;
  v_charge record;
begin
  for v_charge in
    select ec.amount, cat.name_ar, cat.name_en
      from public.contract_extra_charges ec
      join public.expense_categories cat on cat.id = ec.category_id
     where ec.contract_id = p_contract_id
     order by ec.line_order, ec.category_id
  loop
    insert into public.invoice_items (
      invoice_id, line, unit_id, description_ar, description_en, quantity,
      unit_price, discount_percent, amount, is_concession
    ) values (
      p_invoice_id, v_line, null,
      v_charge.name_ar, v_charge.name_en,
      1, v_charge.amount, 0, v_charge.amount, false
    );
    v_line := v_line + 1;
  end loop;
  return v_line;
end;
$$;

-- NOT granted to `authenticated`. This is a SECURITY DEFINER function that
-- inserts into invoice_items with no permission check of its own -- correct
-- for a helper called from inside the four pricing functions, and a hole if it
-- is reachable as an RPC: any signed-in tenant could add billed lines to an
-- invoice by calling it directly with a contract id and a free line number.
--
-- The pricing functions can still call it. Inside a SECURITY DEFINER body
-- `current_user` is the owner, so EXECUTE is checked against the owner rather
-- than against whoever invoked the outer function.
revoke execute on function public.append_extra_charge_items(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.append_extra_charge_items(uuid, uuid, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. contract_period_amounts -- copied from 127, one edit
-- ---------------------------------------------------------------------------
-- The edit: the subtotal is rent plus extras. 127 deliberately stopped
-- subtracting discounts here (they bind to invoices via concession_invoices,
-- never to date ranges), and that is unchanged -- `discount` still returns 0
-- and `total` still equals `subtotal`.
--
-- Consequence worth stating: a percentage discount applied to an invoice now
-- discounts the service charges along with the rent, because it operates on
-- the invoice total. That follows from discounts binding to invoices, and it
-- is a money-semantics decision the operator should know they are making.
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

  select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
    from public.contract_units cu where cu.contract_id = v_contract.id;
  v_subtotal := v_subtotal + public.contract_extra_charges_total(p_contract_id);

  subtotal := v_subtotal;
  discount := 0;
  total := v_subtotal;
  return next;
end;
$$;

revoke execute on function public.contract_period_amounts(uuid, date) from public, anon;
grant execute on function public.contract_period_amounts(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. generate_invoices_for_year -- copied from 141, two edits
-- ---------------------------------------------------------------------------
-- Edit 1: v_subtotal gains the extras. Edit 2: the extra-charge lines follow
-- the per-unit rent lines, continuing v_line.
--
-- What is NOT changed, and is worth stating because it is money semantics the
-- operator has not been asked about: a free month (period_in_free_months)
-- still emits no invoice at all, so it now waives the service charges along
-- with the rent. Billing an extras-only invoice in a free month would be a new
-- invoice shape and a behaviour change for every existing contract, so the
-- existing behaviour stands until someone decides otherwise.

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
        -- Rent plus the contract's recurring extra charges (migration 163).
        -- 1,000 rent with a 100 cleaning charge bills 1,100, and the two are
        -- separate lines on the invoice so the tenant can see which is which.
        v_subtotal := v_subtotal + public.contract_extra_charges_total(v_contract.id);
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
        v_line := public.append_extra_charge_items(v_invoice_id, v_contract.id, v_line);
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
