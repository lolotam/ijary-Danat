-- 280_functions_billing.sql
-- T034: Function audit for invoice generation, schedule sync, concessions,
-- contract save/visibility, portal payable invoices, and contract triggers.
-- Every SECURITY DEFINER function enforces `public.current_company_id()` (or
-- moves to `SECURITY INVOKER`) and accepts `company_service` for permission skip.
-- Idempotent.

------------------------------------------------------------
-- 1. Extra charges, pricing, and invoice horizon
------------------------------------------------------------

/**
 * يحسب إجمالي الرسوم الإضافية الدورية للعقد ضمن الشركة.
 */
create or replace function public.contract_extra_charges_total(p_contract_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(ec.amount), 0)::numeric(14,3)
    from public.contract_extra_charges ec
   where ec.contract_id = p_contract_id
     and (
       coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '') not in ('authenticated', 'company_service')
       or ec.company_id = public.current_company_id()
     );
$$;

/**
 * يعيد أفق الفوترة المحدّد للعقد ضمن الشركة.
 */
create or replace function public.contract_invoice_horizon(p_contract_id uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select least(
    greatest(
      coalesce(c.invoices_generated_through, date_trunc('month', current_date)::date),
      date_trunc('month', current_date)::date
    ),
    date_trunc('month', c.end_date)::date
  )
    from public.contracts c
   where c.id = p_contract_id
     and (
       coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '') not in ('authenticated', 'company_service')
       or c.company_id = public.current_company_id()
     );
$$;

/**
 * يضيف بنود الرسوم الإضافية الدورية إلى الفاتورة المحددة مع ربطها بنفس الشركة.
 */
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
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_line integer := p_start_line;
  v_charge record;
begin
  if v_company_id is null and v_eff_role not in ('authenticated', 'company_service') then
    select c.company_id into v_company_id from public.contracts c where c.id = p_contract_id;
  end if;
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  for v_charge in
    select ec.amount, cat.name_ar, cat.name_en
      from public.contract_extra_charges ec
      join public.expense_categories cat
        on cat.id = ec.category_id
       and cat.company_id = ec.company_id
     where ec.contract_id = p_contract_id
       and ec.company_id = v_company_id
     order by ec.line_order, ec.category_id
  loop
    insert into public.invoice_items (
      company_id, invoice_id, line, unit_id, description_ar, description_en, quantity,
      unit_price, discount_percent, amount, is_concession, is_extra_charge
    ) values (
      v_company_id, p_invoice_id, v_line, null,
      v_charge.name_ar, v_charge.name_en,
      1, v_charge.amount, 0, v_charge.amount, false, true
    );
    v_line := v_line + 1;
  end loop;
  return v_line;
end;
$$;

/**
 * يحسب إيجارات الوحدات لفترة محددة مع مراعاة الزيادة الإيجارية ضمن الشركة.
 */
create or replace function public.contract_unit_period_amounts(
  p_contract_id uuid,
  p_period_start date
)
returns table(unit_id uuid, unit_code text, line_order integer, monthly_amount numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_contract public.contracts%rowtype;
  v_effective date;
  v_base_total numeric(14,3);
  v_total_fils bigint;
begin
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
     and (v_company_id is null or c.company_id = v_company_id);
  if not found then
    raise exception 'Contract not found';
  end if;

  v_company_id := v_contract.company_id;
  v_effective := public.contract_increase_effective_period(v_contract);

  if v_effective is null or p_period_start < v_effective then
    return query
      select cu.unit_id, u.code, cu.line_order, cu.monthly_amount
        from public.contract_units cu
        join public.units u
          on u.id = cu.unit_id
         and u.company_id = cu.company_id
       where cu.contract_id = p_contract_id
         and cu.company_id = v_company_id
       order by cu.line_order, cu.unit_id;
    return;
  end if;

  if v_contract.increase_type = 'percent' then
    return query
      select cu.unit_id, u.code, cu.line_order,
             round(cu.monthly_amount * (1 + v_contract.increase_value / 100), 3)
        from public.contract_units cu
        join public.units u
          on u.id = cu.unit_id
         and u.company_id = cu.company_id
       where cu.contract_id = p_contract_id
         and cu.company_id = v_company_id
       order by cu.line_order, cu.unit_id;
    return;
  end if;

  select coalesce(sum(cu.monthly_amount), 0) into v_base_total
    from public.contract_units cu
   where cu.contract_id = p_contract_id
     and cu.company_id = v_company_id;
  v_total_fils := round(v_contract.increase_value * 1000)::bigint;

  return query
    with exact as (
      select cu.unit_id, u.code, cu.line_order, cu.monthly_amount,
             (v_total_fils * cu.monthly_amount / nullif(v_base_total, 0)) as share
        from public.contract_units cu
        join public.units u
          on u.id = cu.unit_id
         and u.company_id = cu.company_id
       where cu.contract_id = p_contract_id
         and cu.company_id = v_company_id
    ),
    floored as (
      select e.*, floor(e.share)::bigint as fils, (e.share - floor(e.share)) as frac
        from exact e
    ),
    ranked as (
      select f.*, row_number() over (order by f.frac desc, f.line_order, f.unit_id) as rn,
             (v_total_fils - sum(f.fils) over ()) as leftover
        from floored f
    )
    select r.unit_id, r.code, r.line_order,
           r.monthly_amount + (r.fils + case when r.rn <= r.leftover then 1 else 0 end) / 1000.0
      from ranked r
     order by r.line_order, r.unit_id;
end;
$$;

/**
 * يحسب المبالغ الشهرية للعقد لفترة محددة (الإيجار + الرسوم الدورية) ضمن الشركة.
 */
create or replace function public.contract_period_amounts(
  p_contract_id uuid,
  p_period_start date
)
returns table(subtotal numeric, discount numeric, total numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_contract public.contracts%rowtype;
  v_subtotal numeric(14,3);
begin
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
     and (v_company_id is null or c.company_id = v_company_id);
  if not found then
    raise exception 'Contract not found';
  end if;

  if not exists (
    select 1 from public.contract_units cu
     where cu.contract_id = v_contract.id
       and cu.company_id = v_contract.company_id
  ) then
    raise exception 'Contract % has no units and cannot be priced. Add at least one unit first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  select coalesce(sum(upa.monthly_amount), 0) into v_subtotal
    from public.contract_unit_period_amounts(v_contract.id, p_period_start) upa;
  v_subtotal := v_subtotal + public.contract_extra_charges_total(p_contract_id);

  subtotal := v_subtotal;
  discount := 0;
  total := v_subtotal;
  return next;
end;
$$;

/**
 * يحدّث أفق الفوترة للعقد إلى أقصى شهر مفوتر أو مطلوب ضمن نفس الشركة.
 */
create or replace function public.bump_contract_invoice_horizon(
  p_contract_id uuid,
  p_through date default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_max date;
begin
  if v_company_id is null and v_eff_role not in ('authenticated', 'company_service') then
    select c.company_id into v_company_id from public.contracts c where c.id = p_contract_id;
  end if;
  if v_company_id is null then return; end if;

  select max(make_date(i.period_year, i.period_month, 1))
    into v_max
    from public.invoices i
   where i.contract_id = p_contract_id
     and i.company_id = v_company_id;

  v_max := greatest(v_max, date_trunc('month', p_through)::date);
  if v_max is null then return; end if;

  update public.contracts c
     set invoices_generated_through = v_max
   where c.id = p_contract_id
     and c.company_id = v_company_id
     and (c.invoices_generated_through is null or c.invoices_generated_through < v_max);
end;
$$;

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
  v_company_id uuid := public.current_company_id();
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
  v_company_id uuid := public.current_company_id();
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
  v_company_id uuid := public.current_company_id();
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
  v_company_id uuid := public.current_company_id();
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
  v_company_id uuid := public.current_company_id();
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

/**
 * يزامن جدول فواتير العقد بالكامل عبر إعادة تسعير الفترات المفتوحة وسدّ الفجوات ضمن الشركة.
 */
create or replace function public.sync_contract_invoice_schedule(p_contract_id uuid)
returns table(id uuid, code text, period_year integer, period_month integer, total numeric, state text, action text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
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
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
     and (v_company_id is null or c.company_id = v_company_id)
   for update;
  if not found then raise exception 'Contract not found'; end if;

  if v_contract.archived_at is not null then
    raise exception 'Contract % is archived and cannot be billed. Restore it first.',
      v_contract.code using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.contract_units cu
     where cu.contract_id = p_contract_id and cu.company_id = v_contract.company_id
  ) then
    raise exception 'Contract % has no units and cannot be billed. Add at least one unit first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  v_horizon := public.contract_invoice_horizon(p_contract_id);
  v_this_month := date_trunc('month', current_date)::date;

  for v_invoice in
    select i.* from public.invoices i
     where i.contract_id = p_contract_id
       and i.company_id = v_contract.company_id
     order by i.period_year, i.period_month
  loop
    v_period_start := make_date(v_invoice.period_year, v_invoice.period_month, 1);
    v_should_exist :=
      v_period_start >= date_trunc('month', v_contract.start_date)::date
      and v_period_start <= date_trunc('month', v_contract.end_date)::date
      and not public.period_in_free_months(p_contract_id, v_period_start);

    if coalesce(v_invoice.paid, 0) > 0 or v_invoice.state in ('paid', 'partially_paid') then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    if v_invoice.state in ('cancelled', 'waived') then
      if not v_should_exist then
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
        return next;
      end if;
      continue;
    end if;

    if exists (
      select 1 from public.concession_invoices ci
       where ci.invoice_id = v_invoice.id and ci.company_id = v_contract.company_id
    ) then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text;
      action := case when v_should_exist then 'skipped' else 'blocked' end;
      return next;
      continue;
    end if;

    if v_should_exist then
      select * into v_amounts from public.contract_period_amounts(p_contract_id, v_period_start);

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
       where i.id = v_invoice.id and i.company_id = v_contract.company_id;

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
           select 1 from public.contract_closeout_invoice_actions ca
            where ca.invoice_id = v_invoice.id and ca.company_id = v_contract.company_id
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

  v_cursor := date_trunc('month', v_contract.start_date)::date;
  while v_cursor <= v_horizon loop
    if not public.period_in_free_months(p_contract_id, v_cursor) then
      select i.* into v_blocker
        from public.invoices i
       where i.contract_id = p_contract_id
         and i.company_id = v_contract.company_id
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

      if v_cursor > v_this_month and v_contract.state <> 'active' then
        v_cursor := (v_cursor + interval '1 month')::date;
        continue;
      end if;

      select pa.subtotal into v_subtotal
        from public.contract_period_amounts(p_contract_id, v_cursor) pa;

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
        extract(year from v_cursor)::integer,
        extract(month from v_cursor)::integer,
        current_date,
        make_date(extract(year from v_cursor)::integer, extract(month from v_cursor)::integer, v_contract.due_day),
        v_subtotal, 0, v_subtotal, 0, 'due', true,
        v_contract.id::text || ':' || extract(year from v_cursor)::integer::text
          || ':' || extract(month from v_cursor)::integer::text
      on conflict on constraint invoices_contract_id_period_year_period_month_key do nothing
      returning invoices.id, invoices.code into v_invoice_id, v_invoice_code;

      if v_invoice_id is not null then
        v_line := 1;
        for v_unit in
          select upa.unit_id, upa.monthly_amount, upa.unit_code as code
            from public.contract_unit_period_amounts(v_contract.id, v_cursor) upa
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

  update public.invoices i
     set state = 'overdue'
    from public.contracts c
   where i.contract_id = c.id and i.company_id = c.company_id
     and i.contract_id = p_contract_id and i.company_id = v_contract.company_id
     and i.state in ('due', 'partially_paid') and i.balance > 0
     and (i.due_date + c.grace_days) < current_date;

  update public.invoices i
     set state = 'due'
    from public.contracts c
   where i.contract_id = c.id and i.company_id = c.company_id
     and i.contract_id = p_contract_id and i.company_id = v_contract.company_id
     and i.state = 'overdue' and coalesce(i.paid, 0) = 0
     and (i.due_date + c.grace_days) >= current_date;

  perform public.bump_contract_invoice_horizon(p_contract_id);
end;
$$;

------------------------------------------------------------
-- 3. Overdue, portal payable, concessions, contract save
------------------------------------------------------------

/**
 * يقيّم الفواتير المستحقة المتأخرة ويحوّلها إلى متأخرة داخل الشركة الحالية.
 */
create or replace function public.evaluate_overdue(p_as_of date default null)
returns table(invoice_id uuid, old_state text, new_state text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
begin
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'invoices.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  return query
  with eligible as (
    select i.id, i.company_id, i.state::text as previous_state
      from public.invoices i
      join public.contracts c
        on c.id = i.contract_id and c.company_id = i.company_id
     where (v_company_id is null or i.company_id = v_company_id)
       and i.state in ('due', 'partially_paid')
       and i.balance > 0
       and (i.due_date + c.grace_days) < coalesce(p_as_of, current_date)
       and c.archived_at is null
     for update of i
  ),
  changed as (
    update public.invoices i
       set state = 'overdue'
      from eligible e
     where i.id = e.id and i.company_id = e.company_id
    returning i.id, e.previous_state
  )
  select changed.id, changed.previous_state, 'overdue'::text from changed;
end;
$$;

/**
 * يتحقق من وجود طلب دفع إلكتروني قيد الانتظار لفاتورة معينة ضمن الشركة.
 */
create or replace function public.invoice_has_pending_request(_invoice uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.payment_requests pr
     where pr.status = 'pending'
       and _invoice = any (pr.requested_invoice_ids)
       and (
         coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '') not in ('authenticated', 'company_service')
         or pr.company_id = public.current_company_id()
       )
  );
$$;

/**
 * يقيّم الفواتير القابلة للدفع في بوابة المستأجر مع ترتيب الأقدمية ضمن الشركة الحالية.
 */
create or replace function public.evaluate_portal_payable_invoices(
  p_tenant_id uuid,
  p_contract_id uuid default null,
  p_include_hidden boolean default false
)
returns table(
  invoice_id uuid, period_year integer, period_month integer, total numeric,
  paid numeric, balance numeric, state text, is_overdue boolean,
  sequence_order integer, is_selectable boolean, lock_reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_include_hidden boolean := coalesce(p_include_hidden, false)
    and (v_eff_role <> 'authenticated' or coalesce(public.is_staff(auth.uid()), false));
begin
  if p_tenant_id is null then raise exception 'Tenant is required'; end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  if v_eff_role = 'authenticated' and not (
    public.is_staff(auth.uid()) or (
      public.has_role(auth.uid(), 'tenant'::public.app_role) and exists (
        select 1 from public.profiles p
         where p.id = auth.uid() and p.company_id = v_company_id and p.tenant_id = p_tenant_id
      )
    )
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.tenants t
     where t.id = p_tenant_id and (v_company_id is null or t.company_id = v_company_id)
  ) then
    raise exception 'Tenant not found';
  end if;

  if p_contract_id is not null and not exists (
    select 1 from public.contracts c
     where c.id = p_contract_id
       and (v_company_id is null or c.company_id = v_company_id)
       and c.tenant_id = p_tenant_id
  ) then
    raise exception 'Contract does not belong to this tenant' using errcode = '42501';
  end if;

  return query
  with payable as (
    select i.id, i.period_year, i.period_month, i.total, i.paid, i.balance, i.state::text,
           (i.state = 'overdue' or (i.due_date + coalesce(c.grace_days, 0)) < current_date) as overdue,
           row_number() over (order by i.period_year, i.period_month, i.due_date, i.id)::integer as seq
      from public.invoices i
      left join public.contracts c
        on c.id = i.contract_id and c.company_id = i.company_id
     where i.tenant_id = p_tenant_id
       and (v_company_id is null or i.company_id = v_company_id)
       and i.state in ('due', 'overdue', 'partially_paid')
       and i.balance > 0
       and i.is_visible_to_tenant
       and (p_contract_id is null or i.contract_id = p_contract_id)
       and (v_include_hidden or not coalesce(c.hide_from_portal, false))
  ), ordered as (
    select p.*,
           first_value(p.period_month) over (order by p.seq) as blocking_month,
           first_value(p.period_year) over (order by p.seq) as blocking_year
      from payable p
  )
  select o.id, o.period_year, o.period_month, o.total, o.paid, o.balance, o.state,
         o.overdue, o.seq, o.seq = 1,
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

/**
 * يطبّق خصم الإعفاء على الفواتير المختارة ضمن نفس الشركة فقط.
 */
create or replace function public.apply_concession_to_invoices(
  p_concession_id uuid,
  p_invoice_ids uuid[],
  p_waive_extra_charge_invoice_ids uuid[] default '{}'::uuid[]
)
returns table(invoice_id uuid, code text, discount numeric, total numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_company uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_concession public.concessions%rowtype;
  v_company_id uuid;
  v_invoice public.invoices%rowtype;
  v_id uuid;
  v_discount numeric(14,3);
  v_rent_base numeric(14,3);
  v_extras numeric(14,3);
  v_total numeric(14,3);
  v_line integer;
begin
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'contracts.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_caller_company is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if p_invoice_ids is null or cardinality(p_invoice_ids) = 0 then
    raise exception 'Select at least one invoice' using errcode = 'check_violation';
  end if;

  select cn.* into v_concession
    from public.concessions cn
   where cn.id = p_concession_id
     and (v_caller_company is null or cn.company_id = v_caller_company)
   for update;
  if not found then raise exception 'Concession not found'; end if;
  if v_concession.status is distinct from 'active' then
    raise exception 'Concession is not active' using errcode = 'check_violation';
  end if;
  if v_concession.type = 'free_months' then
    raise exception 'Free months cannot be bound to invoices' using errcode = 'check_violation';
  end if;

  v_company_id := v_concession.company_id;

  for v_id in select distinct x from unnest(p_invoice_ids) as x order by x loop
    select i.* into v_invoice
      from public.invoices i
     where i.id = v_id
       and i.company_id = v_company_id
     for update;
    if not found then raise exception 'Invoice not found'; end if;

    if v_invoice.contract_id is distinct from v_concession.contract_id
       or v_invoice.company_id is distinct from v_company_id then
      raise exception 'Invoice % does not belong to this concession''s contract',
        v_invoice.code using errcode = 'check_violation';
    end if;
    if coalesce(v_invoice.paid, 0) <> 0 then
      raise exception 'Invoice % is not fully unpaid', v_invoice.code using errcode = 'check_violation';
    end if;
    if v_invoice.state not in ('due', 'overdue') then
      raise exception 'Invoice % is not in a live unpaid state', v_invoice.code using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from public.concession_invoices ci
       where ci.invoice_id = v_invoice.id and ci.company_id = v_company_id
    ) or coalesce(v_invoice.discount, 0) <> 0 then
      raise exception 'Invoice % already has a discount', v_invoice.code using errcode = 'check_violation';
    end if;

    v_extras := coalesce((
      select sum(ii.amount) from public.invoice_items ii
       where ii.invoice_id = v_invoice.id and ii.company_id = v_company_id and ii.is_extra_charge
    ), 0);
    v_rent_base := greatest(v_invoice.subtotal - v_extras, 0);

    if v_concession.type = 'percentage_discount' then
      v_discount := least(v_rent_base, round(v_rent_base * coalesce(v_concession.discount_percent, 0) / 100, 3));
    else
      v_discount := least(v_rent_base, coalesce(v_concession.discount_amount, 0));
    end if;

    if v_invoice.id = any(coalesce(p_waive_extra_charge_invoice_ids, '{}'::uuid[]))
       and v_extras > 0 and v_rent_base - v_discount = 0 then
      v_discount := v_discount + v_extras;
    end if;
    v_total := v_invoice.subtotal - v_discount;

    update public.invoices
       set discount = v_discount, total = v_total
     where id = v_invoice.id and company_id = v_company_id;

    insert into public.concession_invoices (company_id, concession_id, invoice_id)
    values (v_company_id, p_concession_id, v_invoice.id);

    select coalesce(max(ii.line), 0) + 1 into v_line
      from public.invoice_items ii
     where ii.invoice_id = v_invoice.id and ii.company_id = v_company_id;

    insert into public.invoice_items (
      company_id, invoice_id, line, description_ar, description_en, quantity,
      unit_price, discount_percent, amount, is_concession
    ) values (
      v_company_id, v_invoice.id, v_line,
      case v_concession.type when 'percentage_discount' then 'خصم نسبة مئوية' else 'خصم مبلغ ثابت' end,
      case v_concession.type when 'percentage_discount' then 'Percentage discount' else 'Fixed discount' end,
      1, 0, coalesce(v_concession.discount_percent, 0), -v_discount, true
    );

    invoice_id := v_invoice.id; code := v_invoice.code; discount := v_discount; total := v_total;
    return next;
  end loop;
end;
$$;

/**
 * يربط الفواتير المخفّضة تاريخياً بإعفاءاتها المطابقة ضمن الشركة الحالية فقط.
 */
create or replace function public.backfill_concession_invoice_links()
returns table(linked integer, left_for_review integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_invoice record;
  v_concession_id uuid;
  v_match_count integer;
begin
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  linked := 0;
  left_for_review := 0;

  for v_invoice in
    select i.id, i.company_id, i.code, i.contract_id, i.period_year, i.period_month
      from public.invoices i
     where (v_company_id is null or i.company_id = v_company_id)
       and coalesce(i.discount, 0) > 0
       and not exists (
         select 1 from public.concession_invoices ci
          where ci.invoice_id = i.id and ci.company_id = i.company_id
       )
     order by i.code
  loop
    select count(*), (array_agg(cn.id))[1]
      into v_match_count, v_concession_id
      from public.concessions cn
     where cn.contract_id = v_invoice.contract_id
       and cn.company_id = v_invoice.company_id
       and cn.status = 'active'
       and cn.type <> 'free_months'
       and cn.start_date <= make_date(v_invoice.period_year, v_invoice.period_month, 1)
       and cn.end_date >= make_date(v_invoice.period_year, v_invoice.period_month, 1);

    if v_match_count = 1 then
      insert into public.concession_invoices (company_id, concession_id, invoice_id)
      values (v_invoice.company_id, v_concession_id, v_invoice.id)
      on conflict do nothing;
      linked := linked + 1;
    else
      left_for_review := left_for_review + 1;
    end if;
  end loop;
  return next;
end;
$$;

/**
 * يستعيد قيمة الفواتير المرتبطة عند حذف الإعفاء ضمن نفس الشركة.
 */
create or replace function public.tg_restore_invoices_on_concession_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := coalesce(public.current_company_id(), old.company_id);
  v_link record;
  v_invoice public.invoices%rowtype;
begin
  if old.type = 'free_months' then return old; end if;

  for v_link in
    select ci.invoice_id
      from public.concession_invoices ci
     where ci.concession_id = old.id
       and ci.company_id = v_company_id
  loop
    select i.* into v_invoice
      from public.invoices i
     where i.id = v_link.invoice_id
       and i.company_id = v_company_id
     for update;
    if not found then continue; end if;

    update public.invoices
       set discount = 0, total = subtotal
     where id = v_invoice.id and company_id = v_company_id;

    perform public.recompute_invoice_from_confirmed(v_invoice.id);

    delete from public.invoice_items
     where invoice_id = v_invoice.id
       and company_id = v_company_id
       and is_concession = true;
  end loop;
  return old;
end;
$$;

/**
 * يحفظ العقد ووحداته ورسومه الدورية ذرياً داخل الشركة الحالية.
 */
create or replace function public.save_contract_with_units(
  p_contract jsonb,
  p_units jsonb,
  p_contract_id uuid default null
)
returns public.contracts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_contract public.contracts;
  v_unit jsonb;
  v_line integer := 1;
  v_charge jsonb;
  v_charge_order integer := 1;
  v_before public.contracts%rowtype;
  v_candidate public.contracts%rowtype;
  v_old_effective date;
  v_new_effective date;
  v_lock_from date;
begin
  if v_eff_role = 'authenticated' and not public.has_permission(
       auth.uid(),
       case when p_contract_id is null then 'contracts.create' else 'contracts.update' end
     ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if jsonb_array_length(p_units) = 0 then
    raise exception 'A contract must have at least one unit';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_units) u where nullif(u ->> 'unit_id', '') is null
  ) then
    raise exception 'Every unit entry must carry a unit_id';
  end if;

  if v_company_id is null and v_eff_role not in ('authenticated', 'company_service') then
    if p_contract_id is not null then
      select c.company_id into v_company_id from public.contracts c where c.id = p_contract_id;
    else
      select t.company_id into v_company_id from public.tenants t where t.id = (p_contract ->> 'tenant_id')::uuid;
    end if;
  end if;
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  if p_contract_id is null then
    insert into public.contracts
      (company_id, tenant_id, type, state, commercial_activity, start_date, end_date,
       duration_months, end_date_override_reason, due_day, grace_days,
       deposit, notes, suppress_tenant_billing_docs,
       increase_after_years, increase_type, increase_value)
    values (
      v_company_id,
      (p_contract ->> 'tenant_id')::uuid,
      coalesce((p_contract ->> 'type')::public.contract_types, 'investment'),
      coalesce((p_contract ->> 'state')::public.contract_states, 'draft'),
      p_contract ->> 'commercial_activity',
      (p_contract ->> 'start_date')::date,
      (p_contract ->> 'end_date')::date,
      (p_contract ->> 'duration_months')::integer,
      p_contract ->> 'end_date_override_reason',
      coalesce((p_contract ->> 'due_day')::integer, 1),
      coalesce((p_contract ->> 'grace_days')::integer, 1),
      coalesce((p_contract ->> 'deposit')::numeric, 0),
      p_contract ->> 'notes',
      coalesce((p_contract ->> 'suppress_tenant_billing_docs')::boolean, false),
      (p_contract ->> 'increase_after_years')::integer,
      p_contract ->> 'increase_type',
      (p_contract ->> 'increase_value')::numeric
    )
    returning * into v_contract;
  else
    select c.* into v_before
      from public.contracts c
     where c.id = p_contract_id and c.company_id = v_company_id
     for update;
    if not found then raise exception 'Contract not found'; end if;

    v_candidate := v_before;
    v_candidate.start_date := coalesce((p_contract ->> 'start_date')::date, v_before.start_date);
    if p_contract ? 'increase_after_years' then v_candidate.increase_after_years := (p_contract ->> 'increase_after_years')::integer; end if;
    if p_contract ? 'increase_type' then v_candidate.increase_type := p_contract ->> 'increase_type'; end if;
    if p_contract ? 'increase_value' then v_candidate.increase_value := (p_contract ->> 'increase_value')::numeric; end if;

    v_old_effective := public.contract_increase_effective_period(v_before);
    v_new_effective := public.contract_increase_effective_period(v_candidate);
    if v_before.increase_after_years is not null
       and (v_candidate.increase_after_years is distinct from v_before.increase_after_years
            or v_candidate.increase_type is distinct from v_before.increase_type
            or v_candidate.increase_value is distinct from v_before.increase_value
            or v_new_effective is distinct from v_old_effective) then
      v_lock_from := least(v_old_effective, v_new_effective);
      if v_lock_from is not null then
        perform 1 from public.invoices i
         where i.contract_id = p_contract_id
           and i.company_id = v_company_id
           and make_date(i.period_year, i.period_month, 1) >= v_lock_from
           and (i.state in ('paid', 'partially_paid') or coalesce(i.paid, 0) > 0)
         for update;
        if found then
          raise exception 'Rent increase is locked: an invoice on or after its effective period has been paid'
            using errcode = '22023';
        end if;
      end if;
    end if;

    update public.contracts c set
      tenant_id = coalesce((p_contract ->> 'tenant_id')::uuid, c.tenant_id),
      type = coalesce((p_contract ->> 'type')::public.contract_types, c.type),
      state = coalesce((p_contract ->> 'state')::public.contract_states, c.state),
      commercial_activity = p_contract ->> 'commercial_activity',
      start_date = coalesce((p_contract ->> 'start_date')::date, c.start_date),
      end_date = coalesce((p_contract ->> 'end_date')::date, c.end_date),
      duration_months = (p_contract ->> 'duration_months')::integer,
      end_date_override_reason = p_contract ->> 'end_date_override_reason',
      due_day = coalesce((p_contract ->> 'due_day')::integer, c.due_day),
      grace_days = coalesce((p_contract ->> 'grace_days')::integer, c.grace_days),
      deposit = coalesce((p_contract ->> 'deposit')::numeric, c.deposit),
      notes = p_contract ->> 'notes',
      suppress_tenant_billing_docs = coalesce((p_contract ->> 'suppress_tenant_billing_docs')::boolean, c.suppress_tenant_billing_docs),
      increase_after_years = case when p_contract ? 'increase_after_years' then (p_contract ->> 'increase_after_years')::integer else c.increase_after_years end,
      increase_type = case when p_contract ? 'increase_type' then p_contract ->> 'increase_type' else c.increase_type end,
      increase_value = case when p_contract ? 'increase_value' then (p_contract ->> 'increase_value')::numeric else c.increase_value end
     where c.id = p_contract_id and c.company_id = v_company_id
     returning * into v_contract;
    if not found then raise exception 'Contract not found'; end if;

    delete from public.contract_units cu
     where cu.contract_id = v_contract.id
       and cu.company_id = v_company_id
       and not exists (
         select 1 from jsonb_array_elements(p_units) u where (u ->> 'unit_id')::uuid = cu.unit_id
       );
  end if;

  for v_unit in select * from jsonb_array_elements(p_units) loop
    insert into public.contract_units (company_id, contract_id, unit_id, monthly_amount, line_order)
    values (v_company_id, v_contract.id, (v_unit ->> 'unit_id')::uuid, (v_unit ->> 'monthly_amount')::numeric, v_line)
    on conflict (contract_id, unit_id)
      do update set monthly_amount = excluded.monthly_amount, line_order = excluded.line_order;
    v_line := v_line + 1;
  end loop;

  if p_contract ? 'extra_charges' then
    delete from public.contract_extra_charges ec
     where ec.contract_id = v_contract.id
       and ec.company_id = v_company_id
       and not exists (
         select 1 from jsonb_array_elements(p_contract -> 'extra_charges') c
          where (c ->> 'category_id')::uuid = ec.category_id
       );
    for v_charge in select * from jsonb_array_elements(p_contract -> 'extra_charges') loop
      insert into public.contract_extra_charges (company_id, contract_id, category_id, amount, line_order)
      values (v_company_id, v_contract.id, (v_charge ->> 'category_id')::uuid, (v_charge ->> 'amount')::numeric, v_charge_order)
      on conflict (contract_id, category_id)
        do update set amount = excluded.amount, line_order = excluded.line_order;
      v_charge_order := v_charge_order + 1;
    end loop;
  end if;

  select * into v_contract from public.contracts where id = v_contract.id and company_id = v_company_id;
  return v_contract;
end;
$$;

/**
 * يبدّل ظهور العقد في بوابة المستأجر مع تسجيل التدقيق ضمن الشركة الحالية.
 */
create or replace function public.update_contract_portal_visibility(
  p_contract_id uuid,
  p_hide_from_portal boolean
)
returns public.contracts
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_row public.contracts;
begin
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'contracts.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if p_hide_from_portal is null then
    raise exception 'p_hide_from_portal is required';
  end if;

  update public.contracts
     set hide_from_portal = p_hide_from_portal, updated_at = now()
   where id = p_contract_id
     and (v_company_id is null or company_id = v_company_id)
  returning * into v_row;
  if v_row.id is null then raise exception 'Contract not found'; end if;

  perform public.write_audit(
    'contract.portal_visibility',
    'contract',
    p_contract_id,
    null,
    jsonb_build_object('company_id', v_row.company_id, 'hide_from_portal', p_hide_from_portal)
  );
  return v_row;
end;
$$;

------------------------------------------------------------
-- 4. Contract & receipt propagation triggers (company-scoped / invoker)
------------------------------------------------------------

/**
 * ينقل الفواتير والدفعات والإيصالات عند تغيير المستأجر على العقد ضمن نفس الشركة.
 *
 * Trigger-only helper: the company comes from the contract row the trigger
 * fired on (that row already passed RLS), never from a lookup inside this
 * security definer function. Callable by no API role, so a staff session with
 * a null company context cannot reach another company's ledgers through it.
 */
drop function if exists public.reassign_contract_tenant_records(uuid, uuid, uuid);
create or replace function public.reassign_contract_tenant_records(
  _company uuid,
  _contract uuid,
  _old_tenant uuid,
  _new_tenant uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := _company;
  v_context_company uuid := public.current_company_id();
  _settling_payments uuid[];
begin
  -- A request with a company context may only touch its own company; a
  -- context-free platform update (service_role) relies on the row's company.
  if v_company_id is null
     or (v_context_company is not null and v_context_company <> v_company_id) then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select array_agg(distinct pa.payment_id)
    into _settling_payments
    from public.payment_allocations pa
    join public.invoices i on i.id = pa.invoice_id and i.company_id = pa.company_id
   where i.contract_id = _contract and i.company_id = v_company_id;

  update public.invoices set tenant_id = _new_tenant
   where contract_id = _contract and company_id = v_company_id and tenant_id = _old_tenant;
  update public.payments set tenant_id = _new_tenant
   where company_id = v_company_id and tenant_id = _old_tenant and id = any(_settling_payments);
  update public.receipts set tenant_id = _new_tenant
   where company_id = v_company_id and tenant_id = _old_tenant and payment_id = any(_settling_payments);
end;
$$;

/**
 * ينفّذ نقل سجلات المستأجر عند تعديل `tenant_id` في العقد.
 */
create or replace function public.tg_contract_propagate_tenant_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := new.company_id;
  v_context_company uuid := public.current_company_id();
begin
  if v_company_id is null
     or (v_context_company is not null and v_context_company <> v_company_id) then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  perform public.reassign_contract_tenant_records(v_company_id, new.id, old.tenant_id, new.tenant_id);
  return new;
end;
$$;

/**
 * يضبط حقل إشغال الوحدة عند إدراج أو تعديل صف في `contract_units`.
 */
create or replace function public.tg_contract_units_seed_occupies()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
begin
  select c.state in ('draft', 'active', 'frozen', 'suspended')
    into new.occupies_unit
    from public.contracts c
   where c.id = new.contract_id
     and c.company_id = v_company_id;
  return new;
end;
$$;

/**
 * يحدّث `occupies_unit` في `contract_units` عند تغيّر حالة العقد.
 */
create or replace function public.tg_contract_propagate_occupies()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
begin
  update public.contract_units
     set occupies_unit = new.state in ('draft', 'active', 'frozen', 'suspended')
   where contract_id = new.id
     and company_id = v_company_id
     and occupies_unit <> (new.state in ('draft', 'active', 'frozen', 'suspended'));
  return new;
end;
$$;

/**
 * يعيد احتساب الإيجار الشهري الإجمالي للعقد من جدول `contract_units`.
 */
create or replace function public.tg_contract_units_sync_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _new uuid := new.contract_id;
  _old uuid := old.contract_id;
  _company uuid := coalesce(public.current_company_id(), new.company_id, old.company_id);
begin
  update public.contracts c
     set monthly_amount = coalesce(
           (select sum(cu.monthly_amount) from public.contract_units cu
             where cu.contract_id = c.id and cu.company_id = c.company_id), 0)
   where c.company_id = _company
     and (c.id = _new or c.id = _old);
  return coalesce(new, old);
end;
$$;

/**
 * يزامن حالات الوحدات المرتبطة عند تعديل `contract_units`.
 */
create or replace function public.tg_contract_units_sync_unit_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _company uuid := coalesce(public.current_company_id(), new.company_id, old.company_id);
  _units uuid[] := '{}';
begin
  if _company is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if tg_op <> 'INSERT' then _units := _units || old.unit_id; end if;
  if tg_op <> 'DELETE' then _units := _units || new.unit_id; end if;
  perform public.sync_unit_status_many(_units);
  return coalesce(new, old);
end;
$$;

revoke execute on function public.tg_contract_propagate_tenant_change() from public, anon;
revoke execute on function public.reassign_contract_tenant_records(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, company_service;
revoke execute on function public.tg_contract_units_seed_occupies() from public, anon;
revoke execute on function public.tg_contract_propagate_occupies() from public, anon;
revoke execute on function public.tg_contract_units_sync_total() from public, anon;
revoke execute on function public.tg_contract_units_sync_unit_status() from public, anon;


------------------------------------------------------------
-- 5. Invoice recompute, dispute, write-off, manual paid, bulk import
------------------------------------------------------------

/**
 * يعيد احتساب المبلغ المدفوع وحالة الفاتورة من الدفعات المؤكدة فقط ضمن الشركة.
 */
create or replace function public.recompute_invoice_from_confirmed(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_invoice public.invoices%rowtype;
  v_paid numeric(14,3);
  v_grace integer;
begin
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select i.* into v_invoice
    from public.invoices i
   where i.id = p_invoice_id
     and (v_company_id is null or i.company_id = v_company_id)
   for update;
  if not found then return; end if;
  if v_invoice.state in ('cancelled', 'waived') then return; end if;

  select coalesce(sum(pa.amount), 0) into v_paid
    from public.payment_allocations pa
    join public.payments p
      on p.id = pa.payment_id
     and p.company_id = pa.company_id
   where pa.invoice_id = v_invoice.id
     and pa.company_id = v_invoice.company_id
     and p.status = 'confirmed';

  select c.grace_days into v_grace
    from public.contracts c
   where c.id = v_invoice.contract_id
     and c.company_id = v_invoice.company_id;

  update public.invoices i
     set paid = v_paid,
         state = case
           when v_paid >= v_invoice.total then 'paid'::public.invoice_states
           when (v_invoice.due_date + coalesce(v_grace, 0)) < current_date
             then 'overdue'::public.invoice_states
           when v_paid > 0 then 'partially_paid'::public.invoice_states
           else 'due'::public.invoice_states
         end
   where i.id = v_invoice.id
     and i.company_id = v_invoice.company_id;
end;
$fn$;

revoke execute on function public.recompute_invoice_from_confirmed(uuid)
  from public, anon, authenticated, service_role;

/**
 * يشطب الرصيد المتبقي من الفاتورة ويحوّل حالتها إلى مُعفاة ضمن الشركة الحالية.
 */
create or replace function public.write_off_invoice(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_invoice public.invoices%rowtype;
begin
  if v_eff_role = 'authenticated'
     and not public.has_permission(auth.uid(), 'invoices.write_off') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A write-off reason is required';
  end if;

  select i.* into v_invoice
    from public.invoices i
   where i.id = p_invoice_id
     and (v_company_id is null or i.company_id = v_company_id)
   for update;
  if not found then raise exception 'Invoice not found'; end if;

  if v_invoice.state in ('paid', 'cancelled', 'waived') then
    raise exception 'Invoice cannot be written off in its current state';
  end if;
  if v_invoice.balance <= 0 then
    raise exception 'Invoice has no remaining balance to write off';
  end if;

  update public.invoices i
     set state = 'waived'::public.invoice_states
   where i.id = v_invoice.id
     and i.company_id = v_invoice.company_id;

  perform public.write_audit(
    'invoice.write_off',
    'invoice',
    v_invoice.id,
    to_jsonb(v_invoice),
    jsonb_build_object(
      'company_id', v_invoice.company_id,
      'state', 'waived',
      'reason', trim(p_reason),
      'balance_written_off', v_invoice.balance
    ),
    'success',
    null
  );

  insert into public.contract_operational_events (
    company_id, contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    v_invoice.company_id,
    v_invoice.contract_id,
    v_invoice.tenant_id,
    'invoice_written_off',
    auth.uid(),
    jsonb_build_object(
      'invoice_id', v_invoice.id,
      'balance_written_off', v_invoice.balance
    ),
    trim(p_reason)
  );
end;
$$;

revoke all on function public.write_off_invoice(uuid, text) from public, anon;
grant execute on function public.write_off_invoice(uuid, text)
  to authenticated, company_service, service_role;

/**
 * يضع علامة نزاع على الفاتورة دون تغيير حالتها أو رصيدها ضمن الشركة الحالية.
 */
create or replace function public.set_invoice_dispute(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_invoice public.invoices%rowtype;
begin
  if v_eff_role = 'authenticated'
     and not public.has_permission(auth.uid(), 'invoices.dispute') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A dispute reason is required';
  end if;

  select i.* into v_invoice
    from public.invoices i
   where i.id = p_invoice_id
     and (v_company_id is null or i.company_id = v_company_id)
   for update;
  if not found then raise exception 'Invoice not found'; end if;

  update public.invoices i
     set disputed_at = now(),
         dispute_reason = trim(p_reason),
         disputed_by = auth.uid()
   where i.id = v_invoice.id
     and i.company_id = v_invoice.company_id;

  perform public.write_audit(
    'invoice.dispute',
    'invoice',
    v_invoice.id,
    to_jsonb(v_invoice),
    jsonb_build_object(
      'company_id', v_invoice.company_id,
      'disputed', true,
      'dispute_reason', trim(p_reason)
    ),
    'success',
    null
  );

  insert into public.contract_operational_events (
    company_id, contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    v_invoice.company_id,
    v_invoice.contract_id,
    v_invoice.tenant_id,
    'invoice_disputed',
    auth.uid(),
    jsonb_build_object('invoice_id', v_invoice.id),
    trim(p_reason)
  );
end;
$$;

revoke all on function public.set_invoice_dispute(uuid, text) from public, anon;
grant execute on function public.set_invoice_dispute(uuid, text)
  to authenticated, company_service, service_role;

/**
 * يزيل علامة النزاع عن الفاتورة دون تغيير حالتها أو رصيدها ضمن الشركة الحالية.
 */
create or replace function public.clear_invoice_dispute(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_invoice public.invoices%rowtype;
begin
  if v_eff_role = 'authenticated'
     and not public.has_permission(auth.uid(), 'invoices.dispute') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select i.* into v_invoice
    from public.invoices i
   where i.id = p_invoice_id
     and (v_company_id is null or i.company_id = v_company_id)
   for update;
  if not found then raise exception 'Invoice not found'; end if;

  if v_invoice.disputed_at is null then
    raise exception 'Invoice is not disputed';
  end if;

  update public.invoices i
     set disputed_at = null,
         dispute_reason = null,
         disputed_by = null
   where i.id = v_invoice.id
     and i.company_id = v_invoice.company_id;

  perform public.write_audit(
    'invoice.dispute_clear',
    'invoice',
    v_invoice.id,
    to_jsonb(v_invoice),
    jsonb_build_object('company_id', v_invoice.company_id, 'disputed', false),
    'success',
    null
  );

  insert into public.contract_operational_events (
    company_id, contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    v_invoice.company_id,
    v_invoice.contract_id,
    v_invoice.tenant_id,
    'dispute_cleared',
    auth.uid(),
    jsonb_build_object('invoice_id', v_invoice.id),
    null
  );
end;
$$;

revoke all on function public.clear_invoice_dispute(uuid) from public, anon;
grant execute on function public.clear_invoice_dispute(uuid)
  to authenticated, company_service, service_role;

/**
 * يسجّل أو يلغي سداد الفاتورة يدوياً بترتيب الأقدمية ضمن الشركة الحالية فقط.
 */
create or replace function public.set_invoice_paid(
  p_invoice_id uuid,
  p_paid boolean,
  p_manual_payment_reason text default null,
  p_method text default null
)
returns table (payment_id uuid, invoice_state text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_invoice public.invoices%rowtype;
  v_tenant public.tenants%rowtype;
  v_reference text;
  v_payment_id uuid;
  v_payment record;
  v_new_paid numeric(14,3);
  v_new_state public.invoice_states;
  v_grace integer;
  v_method public.payment_methods;
begin
  if v_eff_role = 'authenticated'
     and not public.has_permission(auth.uid(), 'invoices.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select i.* into v_invoice
    from public.invoices i
   where i.id = p_invoice_id
     and (v_company_id is null or i.company_id = v_company_id)
   for update;
  if not found then raise exception 'Invoice not found'; end if;

  if v_invoice.state in ('cancelled', 'waived') then
    raise exception 'Invoice % cannot be marked paid or unpaid in its current state',
      v_invoice.code using errcode = '22023';
  end if;

  select t.* into v_tenant
    from public.tenants t
   where t.id = v_invoice.tenant_id
     and t.company_id = v_invoice.company_id;
  v_reference := 'AUTO-INV:' || v_invoice.code;

  if p_paid then
    if v_invoice.balance <= 0 then
      return query select null::uuid, v_invoice.state::text;
      return;
    end if;

    if exists (
      select 1
        from public.invoices earlier
       where earlier.contract_id = v_invoice.contract_id
         and earlier.company_id = v_invoice.company_id
         and earlier.id <> v_invoice.id
         and earlier.balance > 0
         and earlier.state in ('due', 'overdue', 'partially_paid')
         and (earlier.period_year, earlier.period_month)
             < (v_invoice.period_year, v_invoice.period_month)
    ) then
      raise exception 'Invoices must be paid in chronological order.';
    end if;

    if p_method is not null
       and p_method in ('payment_link', 'knet', 'card', 'applepay', 'googlepay') then
      raise exception 'Gateway payment methods cannot be recorded manually: %', p_method
        using errcode = '22023';
    end if;

    if p_method is not null then
      v_method := p_method::public.payment_methods;
    else
      select (oli.metadata ->> 'payment_method')::public.payment_methods
        into v_method
        from public.option_list_items oli
        join public.option_lists ol
          on ol.id = oli.list_id
         and ol.company_id = oli.company_id
       where ol.company_id = v_invoice.company_id
         and ol.code = 'manual_payment_reasons'
         and oli.value = p_manual_payment_reason
         and oli.is_active;
    end if;
    v_method := coalesce(v_method, 'cash'::public.payment_methods);

    insert into public.payments (
      code, company_id, tenant_id, unit_id, account_type, method, amount, currency,
      payment_date, reference, note, status
    ) values (
      public.next_payment_code(), v_invoice.company_id, v_invoice.tenant_id, v_invoice.unit_id,
      'commercial_account', v_method, v_invoice.balance, 'KWD',
      current_date,
      v_reference, 'Marked paid from invoice ' || v_invoice.code, 'confirmed'
    )
    returning payments.id into v_payment_id;

    insert into public.payment_allocations (company_id, payment_id, invoice_id, amount)
    values (v_invoice.company_id, v_payment_id, v_invoice.id, v_invoice.balance);
  else
    for v_payment in
      select p.id
        from public.payments p
       where p.company_id = v_invoice.company_id
         and p.tenant_id = v_invoice.tenant_id
         and p.reference = v_reference
    loop
      delete from public.receipts r
       where r.payment_id = v_payment.id and r.company_id = v_invoice.company_id;
      delete from public.payment_allocations pa
       where pa.payment_id = v_payment.id and pa.company_id = v_invoice.company_id;
      delete from public.payments p
       where p.id = v_payment.id and p.company_id = v_invoice.company_id;
    end loop;
    v_payment_id := null;
  end if;

  select coalesce(sum(pa.amount), 0) into v_new_paid
    from public.payment_allocations pa
    join public.payments p
      on p.id = pa.payment_id
     and p.company_id = pa.company_id
   where pa.invoice_id = v_invoice.id
     and pa.company_id = v_invoice.company_id
     and p.status = 'confirmed';

  select c.grace_days into v_grace
    from public.contracts c
   where c.id = v_invoice.contract_id
     and c.company_id = v_invoice.company_id;

  v_new_state := case
    when v_new_paid >= v_invoice.total then 'paid'
    when v_new_paid > 0 then 'partially_paid'
    when (v_invoice.due_date + coalesce(v_grace, 0)) < current_date then 'overdue'
    else 'due'
  end;

  update public.invoices i
     set paid = v_new_paid,
         state = v_new_state,
         manual_payment_reason = case
           when p_paid then coalesce(p_manual_payment_reason, p_method)
           else null
         end
   where i.id = v_invoice.id
     and i.company_id = v_invoice.company_id;

  return query select v_payment_id, v_new_state::text;
end;
$$;

revoke all on function public.set_invoice_paid(uuid, boolean, text, text) from public, anon;
grant execute on function public.set_invoice_paid(uuid, boolean, text, text)
  to authenticated, company_service, service_role;

/**
 * يستورد صفوف كيان واحد بالجملة ضمن الشركة الحالية أو المحددة لمزود الخدمة الموثوق.
 */
create or replace function public.bulk_import_phase6(
  p_entity text,
  p_rows jsonb,
  p_created_by uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_count integer;
  v_contract_ids uuid[];
  v_resolved jsonb;
begin
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a JSON array';
  end if;

  if p_entity = 'expenses' then
    insert into public.expenses (code, company_id, class, category_id, payee, amount, currency, property_id,
      building_id, unit_id, cost_center, start_date, end_date, recurrence, expense_date, status, note, created_by)
    select coalesce(nullif(row_data.code, ''), public.next_expense_code()),
      coalesce(v_company_id, row_data.company_id),
      coalesce(row_data.class, 'regular_recurring')::public.expense_classes, row_data.category_id, nullif(row_data.payee, ''),
      row_data.amount, coalesce(nullif(row_data.currency, ''), 'KWD'), row_data.property_id, row_data.building_id, row_data.unit_id,
      nullif(row_data.cost_center, ''), row_data.start_date, row_data.end_date, nullif(row_data.recurrence, ''), row_data.expense_date,
      coalesce(nullif(row_data.status, ''), 'approved'), nullif(row_data.note, ''), p_created_by
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, class text, category_id uuid,
      payee text, amount numeric, currency text, property_id uuid, building_id uuid, unit_id uuid,
      cost_center text, start_date date, end_date date, recurrence text, expense_date date, status text, note text);
  elsif p_entity = 'deposits' then
    insert into public.deposits (code, company_id, deposit_date, bank_name, amount, currency, note, status, created_by)
    select coalesce(nullif(row_data.code, ''), public.next_deposit_code()),
      coalesce(v_company_id, row_data.company_id), row_data.deposit_date,
      row_data.bank_name, row_data.amount, coalesce(nullif(row_data.currency, ''), 'KWD'), nullif(row_data.note, ''),
      coalesce(nullif(row_data.status, ''), 'confirmed'), p_created_by
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, deposit_date date, bank_name text,
      amount numeric, currency text, note text, status text);
  elsif p_entity = 'tenants' then
    insert into public.tenants (code, company_id, name, category, lifecycle, nationality, preferred_language,
      mobile, whatsapp, email, commercial_name, authorized_manager, owner_name,
      authorized_manager_civil_id, owner_civil_id, commercial_address, notes,
      tenant_portal_enabled, reminders_enabled, receipt_visible_to_tenant)
    select coalesce(nullif(row_data.code, ''), public.next_tenant_code()),
      coalesce(v_company_id, row_data.company_id), row_data.name,
      coalesce(nullif(row_data.category, ''), 'standard')::public.tenant_categories,
      coalesce(nullif(row_data.lifecycle, ''), 'active')::public.tenant_lifecycle, nullif(row_data.nationality, ''),
      coalesce(nullif(row_data.preferred_language, ''), 'ar')::public.locale_code, nullif(row_data.mobile, ''),
      nullif(row_data.whatsapp, ''), nullif(row_data.email, '')::citext, nullif(row_data.commercial_name, ''),
      nullif(row_data.authorized_manager, ''), nullif(row_data.owner_name, ''),
      nullif(row_data.authorized_manager_civil_id, ''), nullif(row_data.owner_civil_id, ''),
      nullif(row_data.commercial_address, ''), nullif(row_data.notes, ''),
      coalesce(row_data.tenant_portal_enabled, false), coalesce(row_data.reminders_enabled, true),
      coalesce(row_data.receipt_visible_to_tenant, true)
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, name text, category text,
      lifecycle text, nationality text, preferred_language text, mobile text, whatsapp text, email text,
      commercial_name text, authorized_manager text, owner_name text,
      authorized_manager_civil_id text, owner_civil_id text, commercial_address text, notes text,
      tenant_portal_enabled boolean, reminders_enabled boolean, receipt_visible_to_tenant boolean);
  elsif p_entity = 'properties' then
    insert into public.properties (code, company_id, name_ar, name_en, type, address_ar, address_en, location_url,
      area, description_ar, description_en, image_url, status)
    select coalesce(nullif(row_data.code, ''), public.next_property_code()),
      coalesce(v_company_id, row_data.company_id), row_data.name_ar,
      nullif(row_data.name_en, ''), coalesce(nullif(row_data.type, ''), 'compound'),
      nullif(row_data.address_ar, ''), nullif(row_data.address_en, ''), nullif(row_data.location_url, ''), row_data.area,
      nullif(row_data.description_ar, ''), nullif(row_data.description_en, ''), nullif(row_data.image_url, ''),
      coalesce(nullif(row_data.status, ''), 'active')
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, name_ar text, name_en text, type text,
      address_ar text, address_en text, location_url text, area numeric, description_ar text, description_en text,
      image_url text, status text);
  elsif p_entity = 'buildings' then
    insert into public.buildings (code, company_id, property_id, category_id, name_ar, name_en, address_ar, address_en, area,
      floors, image_url, description_ar, description_en, status)
    select coalesce(nullif(row_data.code, ''), public.next_building_code()),
      coalesce(v_company_id, (select p.company_id from public.properties p where p.id = row_data.property_id)),
      row_data.property_id, row_data.category_id,
      row_data.name_ar, nullif(row_data.name_en, ''), nullif(row_data.address_ar, ''), nullif(row_data.address_en, ''),
      row_data.area, row_data.floors, nullif(row_data.image_url, ''), nullif(row_data.description_ar, ''),
      nullif(row_data.description_en, ''), coalesce(nullif(row_data.status, ''), 'active')
    from jsonb_to_recordset(p_rows) as row_data(code text, property_id uuid, category_id uuid, name_ar text,
      name_en text, address_ar text, address_en text, area numeric, floors integer, image_url text,
      description_ar text, description_en text, status text);
  elsif p_entity = 'units' then
    insert into public.units (code, company_id, property_id, building_id, name, type, area, status,
      electricity_meter_ownership, default_rent, description_ar, description_en)
    select coalesce(nullif(row_data.code, ''), public.next_unit_code()),
      coalesce(
        v_company_id,
        (select b.company_id from public.buildings b where b.id = row_data.building_id),
        (select p.company_id from public.properties p where p.id = row_data.property_id)
      ),
      row_data.property_id, row_data.building_id,
      row_data.name, coalesce(nullif(row_data.type, ''), 'apartment'), row_data.area,
      coalesce(nullif(row_data.status, ''), 'available')::public.unit_status,
      coalesce(nullif(row_data.electricity_meter_ownership, ''), 'company_owned')::public.electricity_meter_ownership,
      row_data.default_rent, nullif(row_data.description_ar, ''), nullif(row_data.description_en, '')
    from jsonb_to_recordset(p_rows) as row_data(code text, property_id uuid, building_id uuid, name text,
      type text, area numeric, status text, electricity_meter_ownership text, default_rent numeric,
      description_ar text, description_en text);
  elsif p_entity = 'maintenance' then
    insert into public.maintenance_requests (code, company_id, property_id, building_id, unit_id, title, description,
      priority, status, created_by)
    select coalesce(nullif(row_data.code, ''), public.next_maintenance_request_code()),
      coalesce(v_company_id, row_data.company_id),
      row_data.property_id, row_data.building_id, row_data.unit_id, row_data.title, nullif(row_data.description, ''),
      coalesce(nullif(row_data.priority, ''), 'medium')::public.maintenance_priority,
      coalesce(nullif(row_data.status, ''), 'open')::public.maintenance_status, p_created_by
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, property_id uuid, building_id uuid,
      unit_id uuid, title text, description text, priority text, status text);
  elsif p_entity = 'contracts' then
    select jsonb_agg(to_jsonb(rd)) into v_resolved
      from (
        select coalesce(nullif(t.code, ''), public.next_contract_code()) as code,
               coalesce(v_company_id, (select tn.company_id from public.tenants tn where tn.id = t.tenant_id)) as company_id,
               t.tenant_id, t.unit_id, t.type, t.state, t.entry_date, t.start_date,
               t.end_date, t.duration_months, t.monthly_amount, t.due_day,
               t.grace_days, t.deposit, t.notes
          from jsonb_to_recordset(p_rows) as t(code text, tenant_id uuid, unit_id uuid,
            type text, state text, entry_date date, start_date date, end_date date,
            duration_months integer, monthly_amount numeric, due_day integer, grace_days integer,
            deposit numeric, notes text)
      ) rd;

    insert into public.contracts (company_id, code, tenant_id, type, state, entry_date, start_date,
      end_date, duration_months, due_day, grace_days, deposit, notes)
    select r.company_id, r.code, r.tenant_id,
      coalesce(nullif(r.type, ''), 'investment')::public.contract_types,
      coalesce(nullif(r.state, ''), 'draft')::public.contract_states, r.entry_date,
      r.start_date, r.end_date, r.duration_months,
      coalesce(r.due_day, 1), coalesce(r.grace_days, 1),
      coalesce(r.deposit, 0), nullif(r.notes, '')
      from jsonb_to_recordset(coalesce(v_resolved, '[]'::jsonb)) as r(
        company_id uuid, code text, tenant_id uuid, unit_id uuid, type text, state text,
        entry_date date, start_date date, end_date date, duration_months integer,
        monthly_amount numeric, due_day integer, grace_days integer,
        deposit numeric, notes text
      );

    select array_agg(c.id) into v_contract_ids
      from public.contracts c
      join jsonb_to_recordset(coalesce(v_resolved, '[]'::jsonb)) as r(company_id uuid, code text)
        on r.code = c.code
       and r.company_id = c.company_id;

    insert into public.contract_units (company_id, contract_id, unit_id, monthly_amount, line_order)
    select c.company_id, c.id, r.unit_id, r.monthly_amount, 1
      from public.contracts c
      join jsonb_to_recordset(coalesce(v_resolved, '[]'::jsonb)) as r(
        company_id uuid, code text, unit_id uuid, monthly_amount numeric
      ) on r.code = c.code and r.company_id = c.company_id
     where c.id = any(v_contract_ids);

    insert into public.insurance_payments (company_id, contract_id, tenant_id, unit_id, building_id, amount,
      collected_date)
    select c.company_id, c.id, c.tenant_id, cu.unit_id, u.building_id, c.deposit, c.start_date
      from public.contracts c
      join public.contract_units cu
        on cu.contract_id = c.id
       and cu.company_id = c.company_id
      join public.units u
        on u.id = cu.unit_id
       and u.company_id = c.company_id
     where c.id = any(v_contract_ids) and c.deposit > 0
    on conflict (contract_id) do nothing;

    return coalesce(array_length(v_contract_ids, 1), 0);
  else
    raise exception 'Unsupported import entity: %', p_entity;
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.bulk_import_phase6(text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.bulk_import_phase6(text, jsonb, uuid) to company_service, service_role;
