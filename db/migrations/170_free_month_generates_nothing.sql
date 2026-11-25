-- 170_free_month_generates_nothing.sql
--
-- Money-semantics revision, taken by the operator on 2026-08-30: a free month
-- bills NOTHING. Not the rent, and not the recurring service charges of
-- migration 163 either. "The total of these free months will be zero."
--
-- This REVERTS migration 168, which had made a free month emit an extras-only
-- invoice. Every free month is in scope, wherever it falls in the term: the
-- operator chose one uniform rule over the narrower "only free months at the
-- start of the contract", which would have differed on exactly one of the 56
-- free-month concessions live in production.
--
-- Nothing existing changes. `contract_extra_charges` is empty in production, so
-- no invoice carries a service charge and no free month has ever emitted one.
--
-- WHAT THIS FILE IS: a byte-for-byte restore of the four function bodies that
-- migrations 164 and 165 shipped. There are NO edits. Diff any section below
-- against its source and the diff is empty -- that is the property that makes a
-- revert of four money-path functions reviewable, and scripts/build170 asserts
-- it rather than trusting it.
--
--   contract_period_amounts        <- 164
--   generate_invoices_for_year     <- 164
--   regenerate_contract_invoices   <- 165
--   sync_contract_invoice_schedule <- 165
--
-- NOT re-issued, deliberately: `append_extra_charge_items`. 169 re-issued it to
-- set `invoice_items.is_extra_charge`, and that must survive -- restoring 164's
-- copy would silently stop flagging service-charge lines and break the discount
-- base in 169/171.
--
-- WHAT THE INVARIANT IS NOT: "a free month has no invoice". The restored bodies
-- protect money and human decisions, so a period that BECOMES free keeps:
--   * paid and partially-paid invoices, untouched (165:74 regenerate, 165:291 sync);
--   * concession-linked invoices, never deleted (165:91), reported `blocked` by
--     sync (165:316) for a human to settle;
--   * invoices with an allocation or a pending payment request -- cancelled,
--     not deleted.
-- The invariant is: NO NEW invoice is generated for a free period, and only a
-- clean, fully-unpaid, undiscounted invoice is removed.
--
-- Known pre-existing gap, NOT fixed here: sync checks for closeout references
-- before deleting (165:376, because contract_closeout_invoice_actions.invoice_id
-- is ON DELETE RESTRICT and an unguarded delete raises 23503); regenerate has no
-- such check (165:152). That defect ships in 165 today and is unrelated to free
-- months. Fixing it here would put an edit inside a verbatim restore and destroy
-- the only property that makes this file reviewable. It needs its own migration.
--
-- No signature or row-type changes, so `create or replace` stays legal.

-- ---------------------------------------------------------------------------
-- contract_period_amounts -- restored verbatim from 164
-- ---------------------------------------------------------------------------
-- The shared pricer. 168 taught it to read p_period_start and zero the rent
-- in a free month; restoring 164 makes it period-agnostic again, which is
-- correct once a free month has no invoice to price.
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
-- generate_invoices_for_year -- restored verbatim from 164
-- ---------------------------------------------------------------------------
-- 168 made the free-month `continue` conditional on the contract having no
-- extra charges, and skipped the rent lines when it was free. Both are gone:
-- a free month `continue`s unconditionally, as it did before 168.
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

-- ---------------------------------------------------------------------------
-- regenerate_contract_invoices -- restored verbatim from 165
-- ---------------------------------------------------------------------------
-- 168 made `v_should_exist` true for a free month carrying extras, so such an
-- invoice was repriced rather than removed. Restored: free means the period
-- should hold no invoice, and the existing protections decide what happens to
-- one that is already there.
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

    if coalesce(v_invoice.paid, 0) > 0
      or v_invoice.state in ('paid', 'partially_paid') then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    if v_invoice.state in ('cancelled', 'waived') then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    -- An applied discount is as sacred as a payment: regenerating must not
    -- wipe the link or reprice the invoice against today's rent.
    if exists (
      select 1 from public.concession_invoices ci where ci.invoice_id = v_invoice.id
    ) then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    v_should_exist :=
      v_period_start >= date_trunc('month', v_contract.start_date)::date
      and v_period_start <= date_trunc('month', v_contract.end_date)::date
      and not public.period_in_free_months(p_contract_id, v_period_start);

    if v_should_exist then
      select * into v_amounts
        from public.contract_period_amounts(p_contract_id, v_period_start);

      update public.invoices i
         set subtotal = v_amounts.subtotal,
             discount = v_amounts.discount,
             total = v_amounts.total,
             unit_id = (select cu.unit_id from public.contract_units cu
                         where cu.contract_id = v_contract.id
                           and (select count(*) from public.contract_units c2
                                  where c2.contract_id = v_contract.id) = 1),
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
      v_line := public.append_extra_charge_items(v_invoice.id, v_contract.id, v_line);

      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_amounts.total; state := v_invoice.state::text; action := 'updated';
      return next;

    else
      if v_invoice.state in ('due', 'overdue')
        and not exists (
          select 1 from public.payment_allocations pa where pa.invoice_id = v_invoice.id
        )
        and not public.invoice_has_pending_request(v_invoice.id)
        and not exists (
          select 1 from public.concession_invoices ci where ci.invoice_id = v_invoice.id
        )
      then
        delete from public.invoice_items where invoice_id = v_invoice.id;
        delete from public.invoices as i where i.id = v_invoice.id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'deleted'; action := 'deleted';
        return next;
      else
        update public.invoices as i set state = 'cancelled' where i.id = v_invoice.id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'cancelled'; action := 'cancelled';
        return next;
      end if;
    end if;
  end loop;

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

-- ---------------------------------------------------------------------------
-- sync_contract_invoice_schedule -- restored verbatim from 165
-- ---------------------------------------------------------------------------
-- The one with two independent halves, and the one 168 had to edit four times.
-- Both halves are restored together. This is the live edit path —
-- ContractFormDialog saves through it.
create or replace function public.sync_contract_invoice_schedule(p_contract_id uuid)
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
  v_unit record;
  v_horizon date;
  v_cursor date;
  v_invoice_id uuid;
  v_invoice_code text;
  v_subtotal numeric(14,3);
  v_this_month date;
  v_blocker public.invoices%rowtype;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- `for update` holds the contract row for the whole reconciliation. Without
  -- it a payment allocation or a KNET request can land between the
  -- "provably inert" test and the delete that trusts it, and the money would
  -- reference a row that no longer exists.
  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
     for update;
  if not found then raise exception 'Contract not found'; end if;

  if v_contract.archived_at is not null then
    raise exception 'Contract % is archived and cannot be billed. Restore it first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.contract_units cu where cu.contract_id = p_contract_id
  ) then
    raise exception 'Contract % has no units and cannot be billed. Add at least one unit first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  -- Read before anything is deleted. The column ratchets, so this is stable
  -- even across a free-month cycle that removes the furthest invoices.
  v_horizon := public.contract_invoice_horizon(p_contract_id);
  v_this_month := date_trunc('month', current_date)::date;

  -- ---------------- prune / reprice ----------------
  for v_invoice in
    select i.* from public.invoices i
    where i.contract_id = p_contract_id
    order by i.period_year, i.period_month
  loop
    v_period_start := make_date(v_invoice.period_year, v_invoice.period_month, 1);

    v_should_exist :=
      v_period_start >= date_trunc('month', v_contract.start_date)::date
      and v_period_start <= date_trunc('month', v_contract.end_date)::date
      and not public.period_in_free_months(p_contract_id, v_period_start);

    if coalesce(v_invoice.paid, 0) > 0
      or v_invoice.state in ('paid', 'partially_paid') then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    -- A cancelled or waived invoice is never touched. It is only REPORTED here
    -- when its month is genuinely finished with — out of term, or now free. If
    -- the month is still billable, the fill pass below reports the same row as
    -- `blocked` instead, because the real problem is that a billable month has
    -- no live invoice. Emitting from both loops would return one invoice twice
    -- and let a caller reading the first row conclude all was well.
    if v_invoice.state in ('cancelled', 'waived') then
      if not v_should_exist then
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
        return next;
      end if;
      continue;
    end if;

    -- An applied discount is as sacred as a payment: never repriced, never
    -- deleted. But if the month it sits on is no longer billable at all, the
    -- two settings contradict each other and only a human can say which wins —
    -- silently leaving a discounted invoice standing inside a free month would
    -- charge a tenant for a month they were told was free.
    if exists (
      select 1 from public.concession_invoices ci where ci.invoice_id = v_invoice.id
    ) then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text;
      action := case when v_should_exist then 'skipped' else 'blocked' end;
      return next;
      continue;
    end if;

    if v_should_exist then
      select * into v_amounts
        from public.contract_period_amounts(p_contract_id, v_period_start);

      update public.invoices i
         set subtotal = v_amounts.subtotal,
             discount = v_amounts.discount,
             total = v_amounts.total,
             unit_id = (select cu.unit_id from public.contract_units cu
                         where cu.contract_id = v_contract.id
                           and (select count(*) from public.contract_units c2
                                  where c2.contract_id = v_contract.id) = 1),
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
      v_line := public.append_extra_charge_items(v_invoice.id, v_contract.id, v_line);

      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_amounts.total; state := v_invoice.state::text; action := 'updated';
      return next;

    else
      -- `contract_closeout_invoice_actions.invoice_id` is ON DELETE RESTRICT
      -- (84:198). Without this check the delete raises 23503 and takes the
      -- whole reconciliation down with it, on a contract whose only sin is
      -- having been closed out once.
      if v_invoice.state in ('due', 'overdue')
        and not exists (
          select 1 from public.payment_allocations pa where pa.invoice_id = v_invoice.id
        )
        and not public.invoice_has_pending_request(v_invoice.id)
        and not exists (
          select 1 from public.contract_closeout_invoice_actions ca
           where ca.invoice_id = v_invoice.id
        )
      then
        delete from public.invoice_items where invoice_id = v_invoice.id;
        delete from public.invoices as i where i.id = v_invoice.id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'deleted'; action := 'deleted';
        return next;
      else
        update public.invoices as i set state = 'cancelled' where i.id = v_invoice.id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'cancelled'; action := 'cancelled';
        return next;
      end if;
    end if;
  end loop;

  -- ---------------- fill ----------------
  -- A month is only filled when it has no invoice row at all. Any row, in any
  -- state, means the month is spoken for — which is what keeps this idempotent
  -- and what stops a cancelled or waived invoice being resurrected behind a
  -- human's back (55:313). A month whose only row is cancelled therefore stays
  -- unbilled: it is reported as `blocked` rather than quietly left out, because
  -- "the schedule matches the contract" is false for that month and the caller
  -- has to know.
  v_cursor := date_trunc('month', v_contract.start_date)::date;
  while v_cursor <= v_horizon loop
    if not public.period_in_free_months(p_contract_id, v_cursor) then
      select i.* into v_blocker
        from public.invoices i
       where i.contract_id = p_contract_id
         and i.period_year = extract(year from v_cursor)::integer
         and i.period_month = extract(month from v_cursor)::integer;

      if found then
        if v_blocker.state in ('cancelled', 'waived') then
          id := v_blocker.id; code := v_blocker.code;
          period_year := v_blocker.period_year; period_month := v_blocker.period_month;
          total := v_blocker.total; state := v_blocker.state::text; action := 'blocked';
          return next;
        end if;
        v_cursor := (v_cursor + interval '1 month')::date;
        continue;
      end if;

      -- Creating a *future* invoice for a contract that is not active would be
      -- a billing expansion nobody asked for; generate_invoices_for_year admits
      -- future periods only for active contracts (127:97) and this must not be
      -- the back door around that. Past and current months are still repaired
      -- for any state, matching backfill_contract_invoices.
      if v_cursor > v_this_month and v_contract.state <> 'active' then
        v_cursor := (v_cursor + interval '1 month')::date;
        continue;
      end if;

      select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
        from public.contract_units cu where cu.contract_id = p_contract_id;
      -- This branch prices a missing period from scratch rather than asking
      -- contract_period_amounts, so it needs the extras added here too.
      v_subtotal := v_subtotal + public.contract_extra_charges_total(p_contract_id);

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
        extract(year from v_cursor)::integer,
        extract(month from v_cursor)::integer,
        current_date,
        make_date(
          extract(year from v_cursor)::integer,
          extract(month from v_cursor)::integer,
          v_contract.due_day
        ),
        v_subtotal, 0, v_subtotal, 0, 'due', true,
        v_contract.id::text || ':' || extract(year from v_cursor)::integer::text
          || ':' || extract(month from v_cursor)::integer::text
      from public.tenants t where t.id = v_contract.tenant_id
      on conflict on constraint invoices_contract_id_period_year_period_month_key do nothing
      returning invoices.id, invoices.code into v_invoice_id, v_invoice_code;

      if v_invoice_id is not null then
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
        v_line := public.append_extra_charge_items(v_invoice_id, p_contract_id, v_line);

        id := v_invoice_id; code := v_invoice_code;
        period_year := extract(year from v_cursor)::integer;
        period_month := extract(month from v_cursor)::integer;
        total := v_subtotal; state := 'due'; action := 'inserted';
        return next;
      end if;
    end if;

    v_cursor := (v_cursor + interval '1 month')::date;
  end loop;

  -- Overdue is recomputed in BOTH directions. The existing paths only ever
  -- promote due → overdue, so moving a contract's due_day or grace_days
  -- forward left invoices sitting in `overdue` for a deadline that no longer
  -- exists — a tenant chased for a month that is not late.
  update public.invoices i
     set state = 'overdue'
    from public.contracts c
   where i.contract_id = c.id
     and i.contract_id = p_contract_id
     and i.state in ('due', 'partially_paid')
     and i.balance > 0
     and (i.due_date + c.grace_days) < current_date;

  update public.invoices i
     set state = 'due'
    from public.contracts c
   where i.contract_id = c.id
     and i.contract_id = p_contract_id
     and i.state = 'overdue'
     and coalesce(i.paid, 0) = 0
     and (i.due_date + c.grace_days) >= current_date;

  perform public.bump_contract_invoice_horizon(p_contract_id);
end;
$$;

revoke execute on function public.sync_contract_invoice_schedule(uuid) from public, anon;
grant execute on function public.sync_contract_invoice_schedule(uuid)
  to authenticated, service_role;

