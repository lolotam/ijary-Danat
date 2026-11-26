-- 301_functions_summaries_finance.sql
-- T037: function audit — budget, contract, deposit and expense summaries.
-- Split from 283_functions_notifications_reports.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

/** يحسب ملخص الميزانية والتدفقات المالية والفئات والأشهر ضمن نطاق الشركة الحالية. */
create or replace function public.get_budget_summary(
  p_from date,
  p_to date,
  p_property_id uuid default null,
  p_building_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_collections numeric(14,3);
  v_expenses numeric(14,3);
  v_refunds numeric(14,3);
  v_insurance numeric(14,3);
  v_categories jsonb;
  v_months jsonb;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if p_to < p_from then raise exception 'Invalid date range'; end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'reports.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select coalesce(sum(p.amount), 0) into v_collections
    from public.payments p
    left join public.units u on u.company_id = v_company_id and u.id = p.unit_id
   where p.company_id = v_company_id and p.status = 'confirmed' and p.reversed_by_payment_id is null
     and p.payment_date between p_from and p_to
     and (p_property_id is null or u.property_id = p_property_id)
     and (p_building_id is null or u.building_id = p_building_id);

  select coalesce(sum(e.amount), 0) into v_expenses
    from public.expenses e
    left join public.units u on u.company_id = v_company_id and u.id = e.unit_id
   where e.company_id = v_company_id and e.status = 'approved' and e.expense_date between p_from and p_to
     and (p_property_id is null or e.property_id = p_property_id or u.property_id = p_property_id)
     and (p_building_id is null or e.building_id = p_building_id or u.building_id = p_building_id);

  select coalesce(sum(r.amount), 0) into v_refunds
    from public.refunds r
    left join public.units u on u.company_id = v_company_id and u.id = r.unit_id
   where r.company_id = v_company_id and r.status = 'posted' and r.reversal_of_id is null
     and r.refund_date between p_from and p_to
     and (p_property_id is null or u.property_id = p_property_id)
     and (p_building_id is null or r.building_id = p_building_id or u.building_id = p_building_id);

  select coalesce(sum(ins.amount), 0) into v_insurance
    from public.insurance_payments ins
    left join public.units u on u.company_id = v_company_id and u.id = ins.unit_id
   where ins.company_id = v_company_id and ins.collected_date between p_from and p_to
     and (p_property_id is null or u.property_id = p_property_id)
     and (p_building_id is null or ins.building_id = p_building_id or u.building_id = p_building_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'category_id', x.category_id, 'code', x.code, 'name_ar', x.name_ar, 'name_en', x.name_en, 'amount', x.amount
  ) order by x.amount desc), '[]'::jsonb)
    into v_categories
    from (
      select e.category_id, coalesce(c.code, 'uncategorized') code,
             coalesce(c.name_ar, 'غير مصنف') name_ar, coalesce(c.name_en, 'Uncategorized') name_en,
             sum(e.amount)::numeric(14,3) amount
        from public.expenses e
        left join public.expense_categories c on c.company_id = v_company_id and c.id = e.category_id
        left join public.units u on u.company_id = v_company_id and u.id = e.unit_id
       where e.company_id = v_company_id and e.status = 'approved' and e.expense_date between p_from and p_to
         and (p_property_id is null or e.property_id = p_property_id or u.property_id = p_property_id)
         and (p_building_id is null or e.building_id = p_building_id or u.building_id = p_building_id)
       group by e.category_id, c.code, c.name_ar, c.name_en
    ) x;

  select coalesce(jsonb_agg(jsonb_build_object(
    'month', to_char(m.month_start, 'YYYY-MM'), 'collections', coalesce(p.total, 0), 'expenses', coalesce(e.total, 0)
  ) order by m.month_start), '[]'::jsonb)
    into v_months
    from generate_series(date_trunc('month', p_from)::date, date_trunc('month', p_to)::date, interval '1 month') m(month_start)
    left join lateral (
      select sum(pm.amount)::numeric(14,3) total from public.payments pm
        left join public.units u on u.company_id = v_company_id and u.id = pm.unit_id
       where pm.company_id = v_company_id and pm.status = 'confirmed' and pm.reversed_by_payment_id is null
         and pm.payment_date >= m.month_start and pm.payment_date < m.month_start + interval '1 month'
         and pm.payment_date between p_from and p_to
         and (p_property_id is null or u.property_id = p_property_id)
         and (p_building_id is null or u.building_id = p_building_id)
    ) p on true
    left join lateral (
      select sum(ex.amount)::numeric(14,3) total from public.expenses ex
        left join public.units u on u.company_id = v_company_id and u.id = ex.unit_id
       where ex.company_id = v_company_id and ex.status = 'approved'
         and ex.expense_date >= m.month_start and ex.expense_date < m.month_start + interval '1 month'
         and ex.expense_date between p_from and p_to
         and (p_property_id is null or ex.property_id = p_property_id or u.property_id = p_property_id)
         and (p_building_id is null or ex.building_id = p_building_id or u.building_id = p_building_id)
    ) e on true;

  return jsonb_build_object(
    'collections', v_collections, 'deposits', 0::numeric(14,3), 'expenses', v_expenses,
    'refunds', v_refunds, 'insurance_collected', v_insurance,
    'net', v_collections - v_expenses - v_refunds, 'categories', v_categories, 'months', v_months);
end;
$$;

/** يحسب مؤشرات العقود للشركة الحالية مع دعم تصفية الأرشفة والحالة والمستأجر. */
create or replace function public.get_contracts_summary(
  p_search text default null,
  p_state text default null,
  p_tenant_id uuid default null,
  p_archive_mode text default 'current'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_total bigint; v_active bigint; v_expiring bigint; v_ended bigint;
  v_next_expiry date; v_monthly numeric(14,3); v_archived bigint; v_current bigint;
  v_mode text := coalesce(nullif(trim(p_archive_mode), ''), 'current');
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'contracts.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_mode not in ('current', 'archived', 'all') then
    raise exception 'p_archive_mode must be current, archived, or all';
  end if;

  select count(*),
         count(*) filter (where f.state = 'active'),
         count(*) filter (where f.state = 'active' and f.end_date between current_date and current_date + 60),
         count(*) filter (where f.state in ('expired', 'terminated')),
         min(f.end_date) filter (where f.state = 'active' and f.end_date >= current_date),
         coalesce(sum(f.monthly_amount) filter (where f.state = 'active'), 0)
    into v_total, v_active, v_expiring, v_ended, v_next_expiry, v_monthly
    from (
      select c.* from public.contracts c
       where c.company_id = v_company_id
         and (v_mode = 'all'
           or (v_mode = 'archived' and public.contract_is_ended(c.archived_at, c.state))
           or (v_mode = 'current' and not public.contract_is_ended(c.archived_at, c.state)))
         and (p_state is null or c.state::text = p_state)
         and (p_tenant_id is null or c.tenant_id = p_tenant_id)
         and (p_search is null or c.code ilike '%' || p_search || '%')
    ) f;

  select count(*) filter (where public.contract_is_ended(c.archived_at, c.state)),
         count(*) filter (where not public.contract_is_ended(c.archived_at, c.state))
    into v_archived, v_current
    from public.contracts c
   where c.company_id = v_company_id
     and (p_state is null or c.state::text = p_state)
     and (p_tenant_id is null or c.tenant_id = p_tenant_id)
     and (p_search is null or c.code ilike '%' || p_search || '%');

  return jsonb_build_object(
    'total', v_total, 'active', v_active, 'expiring_60d', v_expiring, 'ended', v_ended,
    'next_expiry', v_next_expiry, 'monthly_amount', v_monthly, 'annual_amount', v_monthly * 12,
    'archived_count', v_archived, 'current_count', v_current);
end;
$$;

/** يحسب إجمالي الإيداعات البنكية للشركة الحالية وفق مرشحات الفترة والبنك والحالة. */
create or replace function public.get_deposit_total(
  p_from date default null,
  p_to date default null,
  p_bank text default null,
  p_status text default null,
  p_search text default null
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_total numeric(14,3);
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'deposits.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select coalesce(sum(d.amount), 0) into v_total
    from public.deposits d
   where d.company_id = v_company_id
     and (p_from is null or d.deposit_date >= p_from)
     and (p_to is null or d.deposit_date <= p_to)
     and (p_bank is null or d.bank_name = p_bank)
     and (p_status is null or d.status = p_status)
     and (p_search is null or d.code ilike '%' || p_search || '%'
       or d.bank_name ilike '%' || p_search || '%' or coalesce(d.note, '') ilike '%' || p_search || '%');
  return v_total;
end;
$$;

/** يحسب ملخص بطاقات الإيداعات البنكية للشركة الحالية. */
create or replace function public.get_deposits_summary(
  p_search text default null,
  p_bank text default null,
  p_status text default null,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_total numeric(14,3); v_count bigint;
  v_confirmed numeric(14,3); v_confirmed_count bigint;
  v_pending numeric(14,3); v_pending_count bigint;
  v_month numeric(14,3); v_month_count bigint;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'deposits.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select coalesce(sum(f.amount), 0), count(*),
         coalesce(sum(f.amount) filter (where f.status = 'confirmed'), 0), count(*) filter (where f.status = 'confirmed'),
         coalesce(sum(f.amount) filter (where f.status = 'pending'), 0), count(*) filter (where f.status = 'pending')
    into v_total, v_count, v_confirmed, v_confirmed_count, v_pending, v_pending_count
    from (
      select d.* from public.deposits d
       where d.company_id = v_company_id
         and (p_from is null or d.deposit_date >= p_from)
         and (p_to is null or d.deposit_date <= p_to)
         and (p_bank is null or d.bank_name = p_bank)
         and (p_status is null or d.status = p_status)
         and (p_search is null or d.code ilike '%' || p_search || '%'
           or d.bank_name ilike '%' || p_search || '%' or coalesce(d.note, '') ilike '%' || p_search || '%')
    ) f;

  select coalesce(sum(d.amount), 0), count(*) into v_month, v_month_count
    from public.deposits d
   where d.company_id = v_company_id
     and d.deposit_date >= date_trunc('month', current_date)::date
     and d.deposit_date < (date_trunc('month', current_date) + interval '1 month')::date;

  return jsonb_build_object(
    'total', jsonb_build_object('amount', v_total, 'count', v_count),
    'confirmed', jsonb_build_object('amount', v_confirmed, 'count', v_confirmed_count),
    'pending', jsonb_build_object('amount', v_pending, 'count', v_pending_count),
    'this_month', jsonb_build_object('amount', v_month, 'count', v_month_count));
end;
$$;

/** يحسب ملخص بطاقات المصروفات للشركة الحالية. */
create or replace function public.get_expenses_summary(
  p_search text default null,
  p_class text default null,
  p_category_id uuid default null,
  p_property_id uuid default null,
  p_status text default null,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_total numeric(14,3); v_count bigint;
  v_approved numeric(14,3); v_approved_count bigint;
  v_pending numeric(14,3); v_pending_count bigint;
  v_month numeric(14,3); v_month_count bigint;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'expenses.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select coalesce(sum(f.amount), 0), count(*),
         coalesce(sum(f.amount) filter (where f.status = 'approved'), 0), count(*) filter (where f.status = 'approved'),
         coalesce(sum(f.amount) filter (where f.status = 'pending'), 0), count(*) filter (where f.status = 'pending')
    into v_total, v_count, v_approved, v_approved_count, v_pending, v_pending_count
    from (
      select e.* from public.expenses e
       where e.company_id = v_company_id
         and (p_class is null or e.class::text = p_class)
         and (p_category_id is null or e.category_id = p_category_id)
         and (p_property_id is null or e.property_id = p_property_id)
         and (p_status is null or e.status::text = p_status)
         and (p_from is null or e.expense_date >= p_from)
         and (p_to is null or e.expense_date <= p_to)
         and (p_search is null or e.code ilike '%' || p_search || '%'
           or coalesce(e.payee, '') ilike '%' || p_search || '%'
           or coalesce(e.cost_center, '') ilike '%' || p_search || '%'
           or coalesce(e.note, '') ilike '%' || p_search || '%')
    ) f;

  select coalesce(sum(e.amount), 0), count(*) into v_month, v_month_count
    from public.expenses e
   where e.company_id = v_company_id
     and e.expense_date >= date_trunc('month', current_date)::date
     and e.expense_date < (date_trunc('month', current_date) + interval '1 month')::date;

  return jsonb_build_object(
    'total', jsonb_build_object('amount', v_total, 'count', v_count),
    'approved', jsonb_build_object('amount', v_approved, 'count', v_approved_count),
    'pending', jsonb_build_object('amount', v_pending, 'count', v_pending_count),
    'this_month', jsonb_build_object('amount', v_month, 'count', v_month_count));
end;
$$;


revoke all on function public.get_budget_summary(date, date, uuid, uuid) from public, anon;
revoke all on function public.get_contracts_summary(text, text, uuid, text) from public, anon;
revoke all on function public.get_deposit_total(date, date, text, text, text) from public, anon;
revoke all on function public.get_deposits_summary(text, text, text, date, date) from public, anon;
revoke all on function public.get_expenses_summary(text, text, uuid, uuid, text, date, date) from public, anon;
grant execute on function public.get_budget_summary(date, date, uuid, uuid) to authenticated, company_service, service_role;
grant execute on function public.get_contracts_summary(text, text, uuid, text) to authenticated, company_service, service_role;
grant execute on function public.get_deposit_total(date, date, text, text, text) to authenticated, company_service, service_role;
grant execute on function public.get_deposits_summary(text, text, text, date, date) to authenticated, company_service, service_role;
grant execute on function public.get_expenses_summary(text, text, uuid, uuid, text, date, date) to authenticated, company_service, service_role;
