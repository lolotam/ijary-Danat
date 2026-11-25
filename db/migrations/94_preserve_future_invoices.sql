-- 94_preserve_future_invoices.sql
--
-- Two bugs made manually generated *future* invoices look like they were never
-- saved:
--
-- 1. regenerate_contract_invoices treated any period after the current month as
--    "should not exist" and deleted unpaid due/overdue rows. Admin Generate for
--    the rest of the year (and for later years) writes those rows via
--    generate_invoices_for_year(..., p_include_past := false). Editing a
--    contract then wiped them. The comment in migration 55/82 claimed forward
--    generation did not exist — that is no longer true.
--
-- 2. evaluate_portal_payable_invoices limited the portal "My Invoices" list to
--    companies.max_visible_unpaid_invoices (default 6). Future months beyond
--    that window stayed in the database but never appeared for the tenant.
--    Chronological pay-locking still applies via is_selectable / client order.
--
-- Fix: keep any invoice whose period is inside the contract range (and not a
-- free-month), whether or not it is past the "current month" horizon. Horizon
-- remains the limit only for *automatic* insert of missing periods in Pass 2
-- (still delegated to generate_invoices_for_year with include_past).
-- Portal lists every unpaid, tenant-visible invoice.

-- ---------------------------------------------------------------------------
-- 1. regenerate_contract_invoices — keep future unpaid invoices
-- ---------------------------------------------------------------------------
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

  ---------------------------------------------------------------------------
  -- Pass 1 — reconcile the invoices that already exist
  ---------------------------------------------------------------------------
  for v_invoice in
    select i.* from public.invoices i
    where i.contract_id = p_contract_id
    order by i.period_year, i.period_month
  loop
    v_period_start := make_date(v_invoice.period_year, v_invoice.period_month, 1);

    -- Contract range + free-months only. Do NOT require period <= current month:
    -- admin Generate deliberately creates forward months; those rows must survive
    -- a contract edit / regeneration.
    v_should_exist :=
      v_period_start >= date_trunc('month', v_contract.start_date)::date
      and v_period_start <= date_trunc('month', v_contract.end_date)::date
      and not public.period_in_free_months(p_contract_id, v_period_start);

    if v_should_exist then
      if coalesce(v_invoice.paid, 0) > 0
        or v_invoice.state in ('paid', 'partially_paid', 'cancelled', 'waived') then
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
        return next;
        continue;
      end if;

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
      if coalesce(v_invoice.paid, 0) = 0
        and v_invoice.state in ('due', 'overdue')
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
        update public.invoices as i set state = 'cancelled' where i.id = v_invoice.id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'cancelled'; action := 'cancelled';
        return next;
      end if;
    end if;
  end loop;

  ---------------------------------------------------------------------------
  -- Pass 2 — create missing periods through the current month only
  -- (same as before: generate_invoices_for_year with include_past skips future)
  ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 2. reapply_contract_invoices — after wipe+backfill, restore forward months
-- ---------------------------------------------------------------------------
-- reapply deletes all unpaid due/overdue then backfills only through today.
-- That erased admin-generated future months. Re-run the normal generator for
-- each year from the current year through the contract end so those periods
-- come back (ON CONFLICT DO NOTHING for anything still present).

create or replace function public.reapply_contract_invoices(p_contract_id uuid)
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

  if v_contract.archived_at is not null then
    raise exception 'Contract % is archived and cannot be billed. Restore it first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  delete from public.invoices i
  where i.contract_id = p_contract_id
    and coalesce(i.paid, 0) = 0
    and i.state in ('due', 'overdue')
    and not exists (
      select 1 from public.payment_allocations pa where pa.invoice_id = i.id
    );

  return query
    select * from public.backfill_contract_invoices(p_contract_id);

  -- Forward months for the rest of the contract (current year + later years).
  for v_year in
    extract(year from current_date)::integer ..
    extract(year from v_contract.end_date)::integer
  loop
    return query
      select * from public.generate_invoices_for_year(p_contract_id, v_year, false);
  end loop;
end;
$$;

revoke all on function public.reapply_contract_invoices(uuid) from public;
grant execute on function public.reapply_contract_invoices(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Portal My Invoices — show every unpaid, tenant-visible invoice
-- ---------------------------------------------------------------------------
-- Chronological payment order is unchanged (is_selectable only for the first
-- unpaid period; the client enforces sequential selection). The old LIMIT hid
-- later months that already existed in the database.

create or replace function public.evaluate_portal_payable_invoices(
  p_tenant_id uuid,
  p_company_max_visible integer default 6
)
returns table (
  invoice_id uuid,
  period_year integer,
  period_month integer,
  total numeric,
  paid numeric,
  balance numeric,
  state text,
  is_overdue boolean,
  sequence_order integer,
  is_selectable boolean,
  lock_reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_max_visible integer;
begin
  if p_tenant_id is null then
    raise exception 'Tenant is required';
  end if;

  if auth.role() = 'authenticated' and not (
    public.is_staff(auth.uid()) or (
      public.has_role(auth.uid(), 'tenant') and exists (
        select 1
        from public.profiles p
        where p.id = auth.uid() and p.tenant_id = p_tenant_id
      )
    )
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- Kept for call-site compatibility; no longer caps the result set.
  select least(
    greatest(coalesce(p_company_max_visible, 6), 1),
    coalesce(c.max_visible_unpaid_invoices, greatest(coalesce(p_company_max_visible, 6), 1))
  )
  into v_max_visible
  from public.tenants t
  left join public.companies c on c.id = t.company_id
  where t.id = p_tenant_id;

  if v_max_visible is null then
    raise exception 'Tenant not found';
  end if;

  return query
  with payable as (
    select
      i.id,
      i.period_year,
      i.period_month,
      i.total,
      i.paid,
      i.balance,
      i.state::text,
      (i.state = 'overdue' or (i.due_date + coalesce(c.grace_days, 0)) < current_date) as overdue,
      row_number() over (
        order by i.period_year, i.period_month, i.due_date, i.id
      )::integer as seq
    from public.invoices i
    left join public.contracts c on c.id = i.contract_id
    where i.tenant_id = p_tenant_id
      and i.state in ('due', 'overdue', 'partially_paid')
      and i.balance > 0
      and i.is_visible_to_tenant
  ), ordered as (
    select
      p.*,
      first_value(p.period_month) over (order by p.seq) as blocking_month,
      first_value(p.period_year) over (order by p.seq) as blocking_year
    from payable p
  )
  select
    o.id,
    o.period_year,
    o.period_month,
    o.total,
    o.paid,
    o.balance,
    o.state,
    o.overdue,
    o.seq,
    o.seq = 1,
    case
      when o.seq = 1 then null
      else 'ادفع فاتورة شهر '
        || lpad(o.blocking_month::text, 2, '0') || '/' || o.blocking_year::text
        || ' أولًا / Pay month '
        || lpad(o.blocking_month::text, 2, '0') || '/' || o.blocking_year::text
        || ' first'
    end
  from ordered o
  order by o.seq;
end;
$$;

revoke all on function public.evaluate_portal_payable_invoices(uuid, integer) from public;
grant execute on function public.evaluate_portal_payable_invoices(uuid, integer)
  to authenticated, service_role;
