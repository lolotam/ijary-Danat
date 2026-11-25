-- 95_never_touch_paid_invoices_on_regenerate.sql
--
-- Paid (and partially paid) invoices must never be deleted, cancelled, or
-- amount-rewritten by regenerate_contract_invoices — including future periods
-- a tenant already paid early.
--
-- Migration 94 already kept future unpaid rows. This hardens the money rule:
-- any row with paid > 0 or state paid/partially_paid is skipped *before*
-- should_exist is considered. Previously, an out-of-range paid invoice fell
-- into the else branch and was set to cancelled, which is wrong.
--
-- Unpaid due/overdue rows are still updated in place when the period belongs
-- on the contract, or deleted/cancelled when it does not (no money moved).

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
      insert into public.invoice_items (
        invoice_id, line, description_ar, description_en, quantity,
        unit_price, discount_percent, amount, is_concession
      ) values (
        v_invoice.id, 1, 'قيمة استثمار شهرية', 'Monthly investment value',
        1, v_amounts.subtotal, 0, v_amounts.subtotal, false
      );
      v_line := 2;
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

revoke all on function public.regenerate_contract_invoices(uuid) from public;
grant execute on function public.regenerate_contract_invoices(uuid) to authenticated, service_role;
