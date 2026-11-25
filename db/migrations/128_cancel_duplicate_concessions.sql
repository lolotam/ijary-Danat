-- 128_cancel_duplicate_concessions.sql
-- Cancels overlapping percentage/fixed concessions that predate unique
-- (invoice_id), keeping the oldest per overlapping pair, then recomputes
-- affected unpaid invoices from the invoice's own stored subtotal so no
-- invoice is left with a total reflecting a discount that is no longer active.
--
-- Production has been hand-cleaned: this is expected to be a no-op. Safe to
-- re-run — a second pass finds no overlapping actives and updates zero rows.
-- Only invoices under concessions cancelled in THIS run are recomputed, so a
-- historically cancelled record cannot rewrite a live invoice.

do $$
declare
  v_invoice public.invoices%rowtype;
  v_remaining public.concessions%rowtype;
  v_discount numeric(14,3);
  v_total numeric(14,3);
  v_line integer;
  v_period date;
begin
  create temporary table if not exists _dup_cancelled (
    id uuid primary key,
    contract_id uuid not null,
    start_date date not null,
    end_date date not null
  ) on commit drop;
  delete from _dup_cancelled;

  -- Pairwise: any active %/fixed that overlaps an older sibling on the same
  -- contract is cancelled. After one pass no two actives overlap.
  with cancelled as (
    update public.concessions newer
       set status = 'cancelled',
           updated_at = now()
     where newer.status = 'active'
       and newer.type <> 'free_months'
       and exists (
         select 1
           from public.concessions older
          where older.contract_id = newer.contract_id
            and older.status = 'active'
            and older.type <> 'free_months'
            and older.id <> newer.id
            and older.start_date <= newer.end_date
            and older.end_date >= newer.start_date
            and (older.created_at, older.id) < (newer.created_at, newer.id)
       )
    returning newer.id, newer.contract_id, newer.start_date, newer.end_date
  )
  insert into _dup_cancelled (id, contract_id, start_date, end_date)
  select id, contract_id, start_date, end_date from cancelled;

  if not exists (select 1 from _dup_cancelled) then
    return;
  end if;

  for v_invoice in
    select i.*
      from public.invoices i
     where i.state in ('due', 'overdue')
       and coalesce(i.paid, 0) = 0
       and exists (
         select 1
           from _dup_cancelled d
          where d.contract_id = i.contract_id
            and d.start_date <= make_date(i.period_year, i.period_month, 1)
            and d.end_date >= make_date(i.period_year, i.period_month, 1)
       )
     for update
  loop
    v_period := make_date(v_invoice.period_year, v_invoice.period_month, 1);
    v_remaining := null::public.concessions;

    select cn.* into v_remaining
      from public.concessions cn
     where cn.contract_id = v_invoice.contract_id
       and cn.status = 'active'
       and cn.type <> 'free_months'
       and cn.start_date <= v_period
       and cn.end_date >= v_period
     order by cn.created_at, cn.id
     limit 1;

    if v_remaining.id is null then
      v_discount := 0;
    elsif v_remaining.type = 'percentage_discount' then
      v_discount := least(
        v_invoice.subtotal,
        round(v_invoice.subtotal * coalesce(v_remaining.discount_percent, 0) / 100, 3)
      );
    else
      v_discount := least(v_invoice.subtotal, coalesce(v_remaining.discount_amount, 0));
    end if;
    v_total := v_invoice.subtotal - v_discount;

    if v_invoice.discount is not distinct from v_discount
      and v_invoice.total is not distinct from v_total then
      continue;
    end if;

    update public.invoices
       set discount = v_discount,
           total = v_total
     where id = v_invoice.id;

    delete from public.invoice_items
     where invoice_id = v_invoice.id
       and is_concession = true;

    if v_discount > 0 and v_remaining.id is not null then
      select coalesce(max(line), 0) + 1 into v_line
        from public.invoice_items where invoice_id = v_invoice.id;
      insert into public.invoice_items (
        invoice_id, line, description_ar, description_en, quantity,
        unit_price, discount_percent, amount, is_concession
      ) values (
        v_invoice.id, v_line,
        case v_remaining.type
          when 'percentage_discount' then 'خصم نسبة مئوية'
          else 'خصم مبلغ ثابت'
        end,
        case v_remaining.type
          when 'percentage_discount' then 'Percentage discount'
          else 'Fixed discount'
        end,
        1, 0, coalesce(v_remaining.discount_percent, 0),
        -v_discount, true
      );
    end if;
  end loop;
end;
$$;
