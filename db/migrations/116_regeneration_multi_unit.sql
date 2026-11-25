-- 116_regeneration_multi_unit.sql
--
-- Task 11 (multi-unit contracts, follow-up): regenerating a multi-unit
-- contract's invoices must keep rebuilding one rent line per unit, not
-- collapse them into a single un-attributed line.
--
-- Migration 112 taught generate_invoices_for_year to price a period from
-- public.contract_units and emit one invoice_items rent line per unit. It
-- deliberately left contract_period_amounts and regenerate_contract_invoices
-- alone (see 112's trailing note) because both still read the retired
-- `contracts.monthly_amount` column and both write a single, un-attributed
-- rent line directly instead of delegating to generate_invoices_for_year for
-- that part of their work.
--
-- Left alone, regenerating a three-unit contract's invoice replaces its
-- three attributed rent lines with one line carrying the correct total and a
-- NULL unit_id. Nothing errors — the total still balances — so this defect
-- is invisible until someone tries to build per-property revenue reporting
-- from invoice_items.unit_id and finds it silently empty for every
-- regenerated invoice.
--
-- Why a new file, not an edit of 55 or 95: supersede-by-number. SQL
-- functions are `create or replace`; the LIVE definition of a function is
-- the one in the highest-numbered migration that touches it.
--   - contract_period_amounts: live in 55_invoice_regeneration.sql (no
--     later migration redefines it; 96 only revokes EXECUTE, it does not
--     recreate the function).
--   - regenerate_contract_invoices: live in
--     95_never_touch_paid_invoices_on_regenerate.sql, which itself carries
--     a header saying it supersedes 82 and 94 by re-issuing the same
--     function with the paid-invoice guard hardened. Confirmed by grepping
--     every migration for `create or replace function
--     public.regenerate_contract_invoices` (hits: 55, 82, 94, 95 — 95 is the
--     highest) and for `create or replace function
--     public.contract_period_amounts` (hits: 55 only). No migration between
--     95 and 115 touches either function; 112 explicitly says it does not.
--
-- Both bodies below are copied verbatim from their live source file and then
-- edited only where noted. Neither function's signature nor its
-- `returns table (...)` row type changes, so plain `create or replace`
-- stays legal for both — no `drop function` anywhere in this file.

-- ---------------------------------------------------------------------------
-- 1. contract_period_amounts — copied from 55_invoice_regeneration.sql
-- ---------------------------------------------------------------------------
-- The only edit: v_subtotal now sums public.contract_units.monthly_amount for
-- the contract instead of reading the retired contracts.monthly_amount
-- column — the same source migration 112 already switched
-- generate_invoices_for_year to. Everything else, including the concession
-- ordering (percentage before fixed, matching migration 37) and the OUT
-- parameter assignment, is byte-identical to migration 55.
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
  v_total numeric(14,3);
  v_concession public.concessions%rowtype;
begin
  select c.* into v_contract from public.contracts c where c.id = p_contract_id;
  if not found then
    raise exception 'Contract not found';
  end if;

  select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
    from public.contract_units cu where cu.contract_id = v_contract.id;
  v_total := v_subtotal;

  -- Percentage discounts apply before fixed ones, matching migration 37's
  -- ordering. Changing this order changes what tenants are billed.
  for v_concession in
    select cn.* from public.concessions cn
    where cn.contract_id = p_contract_id and cn.status = 'active'
      and cn.type <> 'free_months'
      and cn.start_date <= p_period_start and cn.end_date >= p_period_start
    order by case cn.type when 'percentage_discount' then 1 else 2 end,
      cn.created_at, cn.id
  loop
    if v_concession.type = 'percentage_discount' then
      v_total := greatest(
        0,
        v_total - round(v_total * coalesce(v_concession.discount_percent, 0) / 100, 3)
      );
    else
      v_total := greatest(0, v_total - coalesce(v_concession.discount_amount, 0));
    end if;
  end loop;

  subtotal := v_subtotal;
  discount := v_subtotal - v_total;
  total := v_total;
  return next;
end;
$$;

revoke execute on function public.contract_period_amounts(uuid, date) from public, anon;
grant execute on function public.contract_period_amounts(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. regenerate_contract_invoices — copied from
--    95_never_touch_paid_invoices_on_regenerate.sql
-- ---------------------------------------------------------------------------
-- Every guard is unchanged: the permission check, the archived-contract
-- raise, the "settled money is sacred" skip (paid > 0 or state in
-- paid/partially_paid), the terminal-state skip (cancelled/waived), the
-- should_exist window with no current-month horizon (migration 94), the
-- unpaid-only delete/cancel branch for periods no longer on the contract,
-- and Pass 2's delegation to generate_invoices_for_year for missing periods.
--
-- The only edit is in the "unpaid, should exist" branch: the single
-- un-attributed rent-line insert becomes a loop over the contract's units —
-- the same shape migration 112 used for generate_invoices_for_year — one
-- invoice_items row per unit, each carrying that unit's own unit_id and
-- monthly_amount, ordered by cu.line_order, cu.unit_id. The concession loop
-- that follows is unchanged except that it now continues numbering from
-- wherever the rent-line loop left v_line, instead of hardcoding
-- `v_line := 2` (which assumed exactly one rent line), and v_item_total is
-- still seeded from v_amounts.subtotal (the contract's combined subtotal),
-- so concessions keep applying to the whole invoice rather than per unit.
create or replace function public.regenerate_contract_invoices(p_contract_id uuid)
returns table (
  id uuid, code text, period_year integer, period_month integer,
  total numeric, state text, action text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract public.contracts%rowtype;
  v_invoice public.invoices%rowtype;
  v_period_start date;
  v_should_exist boolean;
  v_amounts record;
  v_line integer;
  v_item_total numeric(14,3);
  v_concession public.concessions%rowtype;
  v_concession_amount numeric(14,3);
  v_year integer;
  v_generated record;
  v_unit record;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select c.* into v_contract from public.contracts c where c.id = p_contract_id;
  if not found then raise exception 'Contract not found'; end if;

  if v_contract.archived_at is not null then
    raise exception 'Contract % is archived and cannot be billed. Restore it first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  for v_invoice in
    select i.* from public.invoices i
    where i.contract_id = p_contract_id
    order by i.period_year, i.period_month
  loop
    v_period_start := make_date(v_invoice.period_year, v_invoice.period_month, 1);

    -----------------------------------------------------------------------
    -- Settled money is sacred: never delete, cancel, or overwrite amounts.
    -- Applies to past and future periods alike (early pay of a future month).
    -----------------------------------------------------------------------
    if coalesce(v_invoice.paid, 0) > 0
      or v_invoice.state in ('paid', 'partially_paid') then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    -- Already terminal without balance: leave alone.
    if v_invoice.state in ('cancelled', 'waived') then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    -- Contract range + free-months. No current-month horizon (migration 94).
    v_should_exist :=
      v_period_start >= date_trunc('month', v_contract.start_date)::date
      and v_period_start <= date_trunc('month', v_contract.end_date)::date
      and not public.period_in_free_months(p_contract_id, v_period_start);

    if v_should_exist then
      -- Unpaid only (paid already skipped above): rewrite amounts/items.
      select * into v_amounts
        from public.contract_period_amounts(p_contract_id, v_period_start);

      update public.invoices i
         set subtotal = v_amounts.subtotal,
             discount = v_amounts.discount,
             total = v_amounts.total,
             due_date = make_date(
               v_invoice.period_year, v_invoice.period_month, v_contract.due_day
             )
       where i.id = v_invoice.id;

      delete from public.invoice_items where invoice_id = v_invoice.id;
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
          v_invoice.id, v_line, v_unit.unit_id,
          'قيمة استثمار شهرية — ' || v_unit.code,
          'Monthly investment value — ' || v_unit.code,
          1, v_unit.monthly_amount, 0, v_unit.monthly_amount, false
        );
        v_line := v_line + 1;
      end loop;
      v_item_total := v_amounts.subtotal;
      for v_concession in
        select cn.* from public.concessions cn
        where cn.contract_id = p_contract_id and cn.status = 'active'
          and cn.type <> 'free_months'
          and cn.start_date <= v_period_start and cn.end_date >= v_period_start
        order by case cn.type when 'percentage_discount' then 1 else 2 end,
          cn.created_at, cn.id
      loop
        if v_concession.type = 'percentage_discount' then
          v_concession_amount := round(
            v_item_total * coalesce(v_concession.discount_percent, 0) / 100, 3
          );
        else
          v_concession_amount := least(
            v_item_total, coalesce(v_concession.discount_amount, 0)
          );
        end if;
        v_item_total := greatest(0, v_item_total - v_concession_amount);
        insert into public.invoice_items (
          invoice_id, line, description_ar, description_en, quantity,
          unit_price, discount_percent, amount, is_concession
        ) values (
          v_invoice.id, v_line,
          case v_concession.type
            when 'percentage_discount' then 'خصم نسبة مئوية' else 'خصم مبلغ ثابت' end,
          case v_concession.type
            when 'percentage_discount' then 'Percentage discount' else 'Fixed discount' end,
          1, 0, coalesce(v_concession.discount_percent, 0),
          -v_concession_amount, true
        );
        v_line := v_line + 1;
      end loop;

      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_amounts.total; state := v_invoice.state::text; action := 'updated';
      return next;

    else
      -- Period no longer on the contract (or free-months). Unpaid only.
      if v_invoice.state in ('due', 'overdue')
        and not exists (
          select 1 from public.payment_allocations pa where pa.invoice_id = v_invoice.id
        )
        and not public.invoice_has_pending_request(v_invoice.id)
      then
        delete from public.invoice_items where invoice_id = v_invoice.id;
        delete from public.invoices as i where i.id = v_invoice.id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'deleted'; action := 'deleted';
        return next;
      else
        -- Live payment link (or other unpaid protection): cancel, do not destroy.
        update public.invoices as i set state = 'cancelled' where i.id = v_invoice.id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'cancelled'; action := 'cancelled';
        return next;
      end if;
    end if;
  end loop;

  -- Pass 2: missing periods through current month only (include_past skips future).
  for v_year in
    extract(year from v_contract.start_date)::integer ..
    least(
      extract(year from current_date)::integer,
      extract(year from v_contract.end_date)::integer
    )
  loop
    for v_generated in
      select gi.id, gi.code, gi.period_year, gi.period_month, gi.total
        from public.generate_invoices_for_year(p_contract_id, v_year, true) gi
    loop
      id := v_generated.id; code := v_generated.code;
      period_year := v_generated.period_year; period_month := v_generated.period_month;
      total := v_generated.total; state := 'due'; action := 'inserted';
      return next;
    end loop;
  end loop;

  update public.invoices i
     set state = 'overdue'
    from public.contracts c
   where i.contract_id = c.id
     and i.contract_id = p_contract_id
     and i.state in ('due', 'partially_paid')
     and i.balance > 0
     and (i.due_date + c.grace_days) < current_date;
end;
$$;

revoke execute on function public.regenerate_contract_invoices(uuid) from public, anon;
grant execute on function public.regenerate_contract_invoices(uuid) to authenticated, service_role;
