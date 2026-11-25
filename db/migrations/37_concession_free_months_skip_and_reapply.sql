-- 37_concession_free_months_skip_and_reapply.sql
-- Free months: do not create invoices for those periods (skip, not zero-total).
-- Discount types still reduce totals within their date range.
-- reapply_contract_invoices: after concession create/delete, drop unpaid
-- unallocated invoices and regenerate so concessions take effect
-- (generate uses ON CONFLICT DO NOTHING, so re-run alone is not enough).

-- Month-aware free-period check: free months always cover whole calendar
-- months that overlap [start_date, end_date], even if the contract starts mid-month.
create or replace function public.period_in_free_months(
  p_contract_id uuid,
  p_period_start date
) returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.concessions cn
    where cn.contract_id = p_contract_id
      and cn.status = 'active'
      and cn.type = 'free_months'
      and date_trunc('month', cn.start_date)::date <= p_period_start
      and date_trunc('month', cn.end_date)::date >= p_period_start
  );
$$;
revoke all on function public.period_in_free_months(uuid, date) from public;
grant execute on function public.period_in_free_months(uuid, date)
  to authenticated, service_role;

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
    where (c.state = 'active' or (p_include_past and p_contract_id is not null))
      and (p_contract_id is null or c.id = p_contract_id)
      and c.start_date <= make_date(v_year, 12, 31)
      and c.end_date >= make_date(v_year, 1, 1)
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

        -- Product rule: free months at the start of the period → no invoice.
        if public.period_in_free_months(v_contract.id, v_period_start) then
          continue;
        end if;

        v_subtotal := v_contract.monthly_amount;
        v_total := v_subtotal;
        for v_concession in
          select cn.* from public.concessions cn
          where cn.contract_id = v_contract.id and cn.status = 'active'
            and cn.type <> 'free_months'
            and cn.start_date <= v_period_start and cn.end_date >= v_period_start
          order by case cn.type when 'percentage_discount' then 1 else 2 end,
            cn.created_at, cn.id
        loop
          if v_concession.type = 'percentage_discount' then
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
            and cn.type <> 'free_months'
            and cn.start_date <= v_period_start and cn.end_date >= v_period_start
          order by case cn.type when 'percentage_discount' then 1 else 2 end,
            cn.created_at, cn.id
        loop
          if v_concession.type = 'percentage_discount' then
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
            case v_concession.type
              when 'percentage_discount' then 'خصم نسبة مئوية'
              else 'خصم مبلغ ثابت'
            end,
            case v_concession.type
              when 'percentage_discount' then 'Percentage discount'
              else 'Fixed discount'
            end,
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

-- Keep the legacy entry point in sync (no past clamp by default).
create or replace function public.generate_invoices(
  p_contract_id uuid default null,
  p_through_year integer default null
)
returns table (
  id uuid, code text, contract_id uuid, period_year integer,
  period_month integer, total numeric, state text
)
language plpgsql security definer set search_path = public
as $$
begin
  return query
    select * from public.generate_invoices_for_year(p_contract_id, p_through_year, false);
end;
$$;
revoke all on function public.generate_invoices(uuid, integer) from public;
grant execute on function public.generate_invoices(uuid, integer) to authenticated, service_role;

-- Drop unpaid, unallocated invoices and regenerate with current concessions.
create or replace function public.reapply_contract_invoices(p_contract_id uuid)
returns table (
  id uuid, code text, contract_id uuid, period_year integer,
  period_month integer, total numeric, state text
)
language plpgsql security definer set search_path = public
as $$
declare
  v_contract public.contracts%rowtype;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select c.* into v_contract from public.contracts c where c.id = p_contract_id;
  if not found then raise exception 'Contract not found'; end if;

  -- Never touch paid / partially paid / allocated invoices.
  delete from public.invoices i
  where i.contract_id = p_contract_id
    and coalesce(i.paid, 0) = 0
    and i.state in ('due', 'overdue')
    and not exists (
      select 1 from public.payment_allocations pa where pa.invoice_id = i.id
    );

  return query
    select * from public.backfill_contract_invoices(p_contract_id);
end;
$$;
revoke all on function public.reapply_contract_invoices(uuid) from public;
grant execute on function public.reapply_contract_invoices(uuid) to authenticated, service_role;
