-- 283_functions_billing_pricing.sql
-- T034: function audit — extra charges, period pricing, invoice horizon.
-- Split from 280_functions_billing.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

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
  v_company_id uuid := public.current_company_id_strict();
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
  v_company_id uuid := public.current_company_id_strict();
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
