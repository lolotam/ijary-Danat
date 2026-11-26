-- 284_functions_billing_generation.sql
-- T034: function audit — invoice generation, backfill, reapply, regenerate.
-- Split from 280_functions_billing.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

------------------------------------------------------------
-- 2. Invoice generation, backfill, reapply, regenerate, sync
------------------------------------------------------------

/**
 * يولّد الفواتير لعقد معيّن أو لجميع عقود الشركة النشطة حتى سنة مستهدفة.
 */
create or replace function public.generate_invoices(
  p_contract_id uuid default null,
  p_through_year integer default null
)
returns table(id uuid, code text, contract_id uuid, period_year integer, period_month integer, total numeric, state text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_current integer := extract(year from current_date)::integer;
  v_target integer := coalesce(p_through_year, v_current);
  v_horizon integer;
  v_first integer;
  v_last integer;
  v_year integer;
begin
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if v_target < 2000 or v_target > 2200 then
    raise exception 'Target year is outside the supported range';
  end if;

  select max(extract(year from c.end_date))::integer into v_horizon
    from public.contracts c
   where c.archived_at is null
     and (v_company_id is null or c.company_id = v_company_id)
     and (p_contract_id is null or c.id = p_contract_id);

  v_first := least(v_target, v_current);
  v_last := least(v_target, coalesce(v_horizon, v_current));

  for v_year in v_first .. v_last loop
    return query
      select * from public.generate_invoices_for_year(p_contract_id, v_year, false);
  end loop;
end;
$$;

/**
 * يولّد فواتير سنة محددة لعقد أو لعقود الشركة النشطة فقط.
 */
create or replace function public.generate_invoices_for_year(
  p_contract_id uuid default null,
  p_through_year integer default null,
  p_include_past boolean default false
)
returns table(id uuid, code text, contract_id uuid, period_year integer, period_month integer, total numeric, state text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
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
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if v_year < 2000 or v_year > 2200 then
    raise exception 'Target year is outside the supported range';
  end if;

  if p_contract_id is not null then
    select c.* into v_contract
      from public.contracts c
     where c.id = p_contract_id
       and (v_company_id is null or c.company_id = v_company_id);
    if v_contract.archived_at is not null then
      raise exception 'Contract % is archived and cannot be billed. Restore it first.',
        v_contract.code using errcode = 'check_violation';
    end if;
    if v_contract.id is not null and not exists (
      select 1 from public.contract_units cu
       where cu.contract_id = p_contract_id
         and cu.company_id = v_contract.company_id
    ) then
      raise exception 'Contract % has no units and cannot be billed. Add at least one unit first.',
        v_contract.code using errcode = 'check_violation';
    end if;
  end if;

  for v_contract in
    select c.* from public.contracts c
     where (c.state = 'active' or (p_include_past and p_contract_id is not null))
       and (v_company_id is null or c.company_id = v_company_id)
       and (p_contract_id is null or c.id = p_contract_id)
       and c.start_date <= make_date(v_year, 12, 31)
       and c.end_date >= make_date(v_year, 1, 1)
       and c.archived_at is null
       and exists (
         select 1 from public.contract_units cu
          where cu.contract_id = c.id and cu.company_id = c.company_id
       )
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

        select pa.subtotal into v_subtotal
          from public.contract_period_amounts(v_contract.id, v_period_start) pa;
        v_total := v_subtotal;
        v_discount := 0;
        v_invoice_id := null;

        insert into public.invoices (
          code, company_id, contract_id, tenant_id, unit_id, period_year, period_month,
          issue_date, due_date, subtotal, discount, total, paid, state,
          is_visible_to_tenant, idempotency_key
        )
        select public.next_invoice_code(), v_contract.company_id, v_contract.id, v_contract.tenant_id,
          (select cu.unit_id from public.contract_units cu
            where cu.contract_id = v_contract.id
              and cu.company_id = v_contract.company_id
              and (select count(*) from public.contract_units c2
                    where c2.contract_id = v_contract.id and c2.company_id = v_contract.company_id) = 1),
          v_year, v_month, current_date,
          make_date(v_year, v_month, v_contract.due_day), v_subtotal, v_discount,
          v_total, 0, 'due', true,
          v_contract.id::text || ':' || v_year::text || ':' || v_month::text
        on conflict on constraint invoices_contract_id_period_year_period_month_key do nothing
        returning invoices.id, invoices.code into v_invoice_id, v_invoice_code;

        if v_invoice_id is null then continue; end if;

        v_line := 1;
        for v_unit in
          select upa.unit_id, upa.monthly_amount, upa.unit_code as code
            from public.contract_unit_period_amounts(v_contract.id, v_period_start) upa
           order by upa.line_order, upa.unit_id
        loop
          insert into public.invoice_items (
            company_id, invoice_id, line, unit_id, description_ar, description_en, quantity,
            unit_price, discount_percent, amount, is_concession
          ) values (
            v_contract.company_id, v_invoice_id, v_line, v_unit.unit_id,
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

    if v_start_month <= v_end_month then
      perform public.bump_contract_invoice_horizon(
        v_contract.id,
        case
          when p_include_past
            then least(make_date(v_year, v_end_month, 1), date_trunc('month', current_date)::date)
          else make_date(v_year, v_end_month, 1)
        end
      );
    end if;
  end loop;
end;
$$;

/**
 * يستكمل توليد الفواتير السابقة لعقد محدد ضمن الشركة الحالية.
 */
create or replace function public.backfill_contract_invoices(p_contract_id uuid)
returns table(id uuid, code text, contract_id uuid, period_year integer, period_month integer, total numeric, state text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_contract public.contracts%rowtype;
  v_year integer;
begin
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
     and (v_company_id is null or c.company_id = v_company_id);
  if not found then raise exception 'Contract not found'; end if;

  if v_contract.archived_at is not null then
    raise exception 'Contract % is archived and cannot be billed. Restore it first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  for v_year in
    extract(year from v_contract.start_date)::integer ..
    least(extract(year from current_date)::integer, extract(year from v_contract.end_date)::integer)
  loop
    return query
      select * from public.generate_invoices_for_year(p_contract_id, v_year, true);
  end loop;

  update public.invoices i
     set state = 'overdue'
    from public.contracts c
   where i.contract_id = c.id
     and i.company_id = c.company_id
     and i.contract_id = p_contract_id
     and i.company_id = v_contract.company_id
     and i.state in ('due', 'partially_paid')
     and i.balance > 0
     and (i.due_date + c.grace_days) < current_date;
end;
$$;

/**
 * يعيد تطبيق الفواتير غير المسددة لعقد محدد ضمن الشركة.
 */
create or replace function public.reapply_contract_invoices(p_contract_id uuid)
returns table(id uuid, code text, contract_id uuid, period_year integer, period_month integer, total numeric, state text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_contract public.contracts%rowtype;
begin
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
     and (v_company_id is null or c.company_id = v_company_id);
  if not found then raise exception 'Contract not found'; end if;

  if v_contract.archived_at is not null then
    raise exception 'Contract % is archived and cannot be billed. Restore it first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  delete from public.invoices i
   where i.contract_id = p_contract_id
     and i.company_id = v_contract.company_id
     and coalesce(i.paid, 0) = 0
     and i.state in ('due', 'overdue')
     and not exists (
       select 1 from public.payment_allocations pa
        where pa.invoice_id = i.id and pa.company_id = i.company_id
     )
     and make_date(i.period_year, i.period_month, 1) <= date_trunc('month', current_date)::date
     and not exists (
       select 1 from public.concession_invoices ci
        where ci.invoice_id = i.id and ci.company_id = i.company_id
     );

  return query select * from public.backfill_contract_invoices(p_contract_id);
end;
$$;

/**
 * يعيد توليد فواتير عقد محدد وإصلاح الفجوات والأسعار ضمن الشركة.
 */
create or replace function public.regenerate_contract_invoices(p_contract_id uuid)
returns table(id uuid, code text, period_year integer, period_month integer, total numeric, state text, action text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
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
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
     and (v_company_id is null or c.company_id = v_company_id);
  if not found then raise exception 'Contract not found'; end if;

  if v_contract.archived_at is not null then
    raise exception 'Contract % is archived and cannot be billed. Restore it first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  for v_invoice in
    select i.* from public.invoices i
     where i.contract_id = p_contract_id
       and i.company_id = v_contract.company_id
     order by i.period_year, i.period_month
  loop
    v_period_start := make_date(v_invoice.period_year, v_invoice.period_month, 1);

    if coalesce(v_invoice.paid, 0) > 0 or v_invoice.state in ('paid', 'partially_paid', 'cancelled', 'waived') then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    if exists (
      select 1 from public.concession_invoices ci
       where ci.invoice_id = v_invoice.id and ci.company_id = v_contract.company_id
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
                           and cu.company_id = v_contract.company_id
                           and (select count(*) from public.contract_units c2
                                 where c2.contract_id = v_contract.id and c2.company_id = v_contract.company_id) = 1),
             due_date = make_date(v_invoice.period_year, v_invoice.period_month, v_contract.due_day)
       where i.id = v_invoice.id
         and i.company_id = v_contract.company_id;

      delete from public.invoice_items
       where invoice_id = v_invoice.id and company_id = v_contract.company_id;

      v_line := 1;
      for v_unit in
        select upa.unit_id, upa.monthly_amount, upa.unit_code as code
          from public.contract_unit_period_amounts(v_contract.id, v_period_start) upa
         order by upa.line_order, upa.unit_id
      loop
        insert into public.invoice_items (
          company_id, invoice_id, line, unit_id, description_ar, description_en, quantity,
          unit_price, discount_percent, amount, is_concession
        ) values (
          v_contract.company_id, v_invoice.id, v_line, v_unit.unit_id,
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
           select 1 from public.payment_allocations pa
            where pa.invoice_id = v_invoice.id and pa.company_id = v_contract.company_id
         )
         and not public.invoice_has_pending_request(v_invoice.id)
         and not exists (
           select 1 from public.concession_invoices ci
            where ci.invoice_id = v_invoice.id and ci.company_id = v_contract.company_id
         )
      then
        delete from public.invoice_items
         where invoice_id = v_invoice.id and company_id = v_contract.company_id;
        delete from public.invoices as i
         where i.id = v_invoice.id and i.company_id = v_contract.company_id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'deleted'; action := 'deleted';
        return next;
      else
        update public.invoices as i
           set state = 'cancelled'
         where i.id = v_invoice.id and i.company_id = v_contract.company_id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'cancelled'; action := 'cancelled';
        return next;
      end if;
    end if;
  end loop;

  for v_year in
    extract(year from v_contract.start_date)::integer ..
    least(extract(year from current_date)::integer, extract(year from v_contract.end_date)::integer)
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
     and i.company_id = c.company_id
     and i.contract_id = p_contract_id
     and i.company_id = v_contract.company_id
     and i.state in ('due', 'partially_paid')
     and i.balance > 0
     and (i.due_date + c.grace_days) < current_date;
end;
$$;
