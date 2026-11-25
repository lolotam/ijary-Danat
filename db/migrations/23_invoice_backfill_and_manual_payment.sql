-- 23_invoice_backfill_and_manual_payment.sql
-- Back-dated invoice generation on contract creation, and the two-way link
-- between "invoice marked paid" and a payment record.
--
--   1. generate_invoices_for_year(...) — the existing generator with the
--      "never invoice a past month" clamp made optional.
--   2. backfill_contract_invoices(contract) — every month from the contract
--      start through the current month, then overdue evaluation.
--   3. set_invoice_paid(invoice, paid) — marking an invoice paid creates a
--      confirmed payment for its remaining balance in that invoice's period;
--      reverting deletes the payment that was created this way.
-- Idempotent.


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
    -- A backfill is an explicit request for one contract, so it also covers a
    -- contract still in draft; the scheduled run stays active-only.
    where (c.state = 'active' or (p_include_past and p_contract_id is not null))
      and (p_contract_id is null or c.id = p_contract_id)
      and c.start_date <= make_date(v_year, 12, 31)
      and c.end_date >= make_date(v_year, 1, 1)
    order by c.id
  loop
    -- Normally the current year starts at the current month so past periods
    -- are never invoiced retroactively. p_include_past lifts that clamp for
    -- the back-dated backfill run when a contract is created.
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
        -- A backfill covers history up to today, never future periods.
        if p_include_past and v_period_start > date_trunc('month', current_date)::date then
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
        -- Named constraint, not the column list: `contract_id` is also an OUT
        -- parameter of this function and would be ambiguous here.
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
revoke all on function public.generate_invoices_for_year(uuid, integer, boolean) from public;
grant execute on function public.generate_invoices_for_year(uuid, integer, boolean)
  to authenticated, service_role;

-- 2. Backfill every period of a contract's history --------------------------
create or replace function public.backfill_contract_invoices(p_contract_id uuid)
returns table (
  id uuid, code text, contract_id uuid, period_year integer,
  period_month integer, total numeric, state text
)
language plpgsql security definer set search_path = public
as $$
declare
  v_contract public.contracts%rowtype;
  v_year integer;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  select c.* into v_contract from public.contracts c where c.id = p_contract_id;
  if not found then raise exception 'Contract not found'; end if;

  for v_year in
    extract(year from v_contract.start_date)::integer ..
    least(
      extract(year from current_date)::integer,
      extract(year from v_contract.end_date)::integer
    )
  loop
    return query
      select * from public.generate_invoices_for_year(p_contract_id, v_year, true);
  end loop;

  -- Anything already past its due date + grace becomes overdue immediately,
  -- so a back-dated contract lands in the state the admin expects.
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
revoke all on function public.backfill_contract_invoices(uuid) from public;
grant execute on function public.backfill_contract_invoices(uuid) to authenticated, service_role;

-- 3. Invoice paid state <-> payment record ----------------------------------
-- Payments created by this function carry an AUTO-INV: reference so the
-- reverse direction can find and remove exactly what it created, and never
-- touches a manually recorded or gateway payment.
create or replace function public.set_invoice_paid(p_invoice_id uuid, p_paid boolean)
returns table (payment_id uuid, invoice_state text)
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_tenant public.tenants%rowtype;
  v_reference text;
  v_payment_id uuid;
  v_payment record;
  v_new_paid numeric(14,3);
  v_new_state public.invoice_states;
  v_grace integer;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select i.* into v_invoice from public.invoices i where i.id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  select t.* into v_tenant from public.tenants t where t.id = v_invoice.tenant_id;
  v_reference := 'AUTO-INV:' || v_invoice.code;

  if p_paid then
    if v_invoice.balance <= 0 then
      return query select null::uuid, v_invoice.state::text;
      return;
    end if;
    insert into public.payments (
      code, company_id, tenant_id, unit_id, account_type, method, amount, currency,
      payment_date, reference, note, status
    ) values (
      public.next_payment_code(), v_tenant.company_id, v_invoice.tenant_id, v_invoice.unit_id,
      'commercial_account', 'cash', v_invoice.balance, 'KWD',
      -- Dated inside the invoice's own period so month-by-month reporting lines up.
      least(v_invoice.due_date, current_date),
      v_reference, 'Marked paid from invoice ' || v_invoice.code, 'confirmed'
    )
    returning payments.id into v_payment_id;

    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (v_payment_id, v_invoice.id, v_invoice.balance);
  else
    -- Remove only the auto-created payments for this invoice.
    for v_payment in
      select p.id from public.payments p
      where p.tenant_id = v_invoice.tenant_id and p.reference = v_reference
    loop
      -- A confirmed payment gets a receipt from a trigger; drop it first or
      -- the receipts FK blocks the delete.
      delete from public.receipts r where r.payment_id = v_payment.id;
      delete from public.payment_allocations pa where pa.payment_id = v_payment.id;
      delete from public.payments p where p.id = v_payment.id;
    end loop;
    v_payment_id := null;
  end if;

  -- Recompute the invoice from its surviving allocations.
  select coalesce(sum(pa.amount), 0) into v_new_paid
  from public.payment_allocations pa where pa.invoice_id = v_invoice.id;
  select c.grace_days into v_grace from public.contracts c where c.id = v_invoice.contract_id;

  v_new_state := case
    when v_new_paid >= v_invoice.total then 'paid'
    when v_new_paid > 0 then 'partially_paid'
    when (v_invoice.due_date + coalesce(v_grace, 0)) < current_date then 'overdue'
    else 'due'
  end;

  -- `balance` is a generated column (total - paid); assigning it is rejected.
  update public.invoices i
    set paid = v_new_paid,
        state = v_new_state
    where i.id = v_invoice.id;

  return query select v_payment_id, v_new_state::text;
end;
$$;
revoke all on function public.set_invoice_paid(uuid, boolean) from public;
grant execute on function public.set_invoice_paid(uuid, boolean) to authenticated, service_role;
