-- 198_regenerate_uses_period_pricer.sql
--
-- إعادة التوليد تسعّر البنود عبر المسرّع المشترك فتطابق الترويسة بعد الزيادة.
--
-- regenerate_contract_invoices repriced the header through
-- contract_period_amounts (period-aware since 196) but rebuilt the lines from
-- base contract_units, so a repriced invoice carried the increase in its
-- header and base rent in its lines. The line loop now reads the same pricer
-- for the same period, and the two can never disagree.

-- ---------------------------------------------------------------------------
-- regenerate_contract_invoices -- re-issued from 170, line loop via the unit pricer
-- ---------------------------------------------------------------------------
-- Copied verbatim from db/migrations/170_free_month_generates_nothing.sql:272-446
-- except the line-loop source (hunk below).
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
        select upa.unit_id, upa.monthly_amount, upa.unit_code as code
          from public.contract_unit_period_amounts(v_contract.id, v_period_start) upa
         order by upa.line_order, upa.unit_id
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
