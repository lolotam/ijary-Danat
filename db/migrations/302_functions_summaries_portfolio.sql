-- 302_functions_summaries_portfolio.sql
-- T037: function audit — invoice, payment, rent, tenant and unit summaries.
-- Split from 283_functions_notifications_reports.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

/** يحسب الملخص الشهري للفواتير ضمن سنة محددة للشركة الحالية. */
create or replace function public.get_invoice_month_summary(p_year integer, p_property_id uuid default null)
returns table(month integer, count bigint, total numeric, paid numeric, outstanding numeric, overdue bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'invoices.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  with rent as (
    select ii.invoice_id, u.property_id, ii.amount
      from public.invoice_items ii
      join public.units u on u.company_id = v_company_id and u.id = ii.unit_id
     where ii.company_id = v_company_id and not ii.is_extra_charge and not ii.is_concession
  ),
  shares as (
    select i.id, i.period_month, i.total, i.paid, i.balance, i.state,
           (p_property_id is null or exists (select 1 from rent r where r.invoice_id = i.id and r.property_id = p_property_id)) as touches,
           case when p_property_id is null then 1::numeric
                else coalesce((select sum(r.amount) from rent r where r.invoice_id = i.id and r.property_id = p_property_id)
                              / nullif((select sum(r.amount) from rent r where r.invoice_id = i.id), 0), 0)
           end as share
      from public.invoices i
     where i.company_id = v_company_id and i.period_year = p_year
  )
  select m.month, count(s.id) filter (where s.touches),
         round(coalesce(sum(s.total * s.share), 0), 3),
         round(coalesce(sum(s.paid * s.share), 0), 3),
         round(coalesce(sum(s.balance * s.share), 0), 3),
         count(s.id) filter (where s.touches and s.state = 'overdue')
    from generate_series(1, 12) as m(month)
    left join shares s on s.period_month = m.month
   group by m.month
   order by m.month;
end;
$$;

/** يحسب ملخص المدفوعات والجزئيات والتأمين والمستردات للشركة الحالية. */
create or replace function public.get_payments_summary(
  p_search text default null,
  p_method text default null,
  p_status text default null,
  p_tenant_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_full_total numeric(14,3); v_full_count bigint;
  v_partial_total numeric(14,3); v_partial_count bigint;
  v_insurance_total numeric(14,3); v_insurance_count bigint;
  v_refund_total numeric(14,3); v_refund_count bigint;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'payments.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select coalesce(sum(p.amount), 0), count(*) into v_full_total, v_full_count
    from public.payments p
   where p.company_id = v_company_id and p.status = 'confirmed' and p.reversed_by_payment_id is null
     and (p_method is null or p.method::text = p_method)
     and (p_status is null or p.status::text = p_status)
     and (p_tenant_id is null or p.tenant_id = p_tenant_id)
     and (p_search is null or p.code ilike '%' || p_search || '%'
       or coalesce(p.reference, '') ilike '%' || p_search || '%'
       or exists (select 1 from public.tenants t where t.company_id = v_company_id and t.id = p.tenant_id
                     and (t.code ilike '%' || p_search || '%' or t.name ilike '%' || p_search || '%')));

  select coalesce(sum(x.amount), 0), count(*) into v_partial_total, v_partial_count
    from public.partial_payments x
   where x.company_id = v_company_id and (p_tenant_id is null or x.tenant_id = p_tenant_id);

  select coalesce(sum(x.amount), 0), count(*) into v_insurance_total, v_insurance_count
    from public.insurance_payments x
   where x.company_id = v_company_id and (p_tenant_id is null or x.tenant_id = p_tenant_id);

  select coalesce(sum(x.amount), 0), count(*) into v_refund_total, v_refund_count
    from public.refunds x
   where x.company_id = v_company_id and x.status = 'posted' and x.reversal_of_id is null
     and (p_tenant_id is null or x.tenant_id = p_tenant_id);

  return jsonb_build_object(
    'full', jsonb_build_object('total', v_full_total, 'count', v_full_count),
    'partial', jsonb_build_object('total', v_partial_total, 'count', v_partial_count),
    'insurance', jsonb_build_object('total', v_insurance_total, 'count', v_insurance_count),
    'refunds', jsonb_build_object('total', v_refund_total, 'count', v_refund_count),
    'net', v_full_total - v_refund_total);
end;
$$;

/** يحسب إجمالي الإيجار الشهري لكل عقار للشركة الحالية ضمن الفترة المحددة. */
create or replace function public.get_property_monthly_rent_totals(
  p_period_start date default (date_trunc('month', current_date))::date
)
returns table(property_id uuid, monthly_total numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_period date := coalesce(p_period_start, date_trunc('month', current_date)::date);
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'properties.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  select u.property_id, round(sum(upa.monthly_amount), 3)
    from public.contracts c
    cross join lateral public.contract_unit_period_amounts(c.id, v_period) upa
    join public.units u on u.company_id = v_company_id and u.id = upa.unit_id
   where c.company_id = v_company_id and c.state = 'active' and c.archived_at is null
     and v_period >= date_trunc('month', c.start_date)::date
     and v_period <= date_trunc('month', c.end_date)::date
     and not public.period_in_free_months(c.id, v_period)
   group by u.property_id;
end;
$$;

/** يحسب مؤشرات المستأجرين والمتأخرات الخاصة بهم ضمن نطاق الشركة الحالية. */
create or replace function public.get_tenants_summary(
  p_search text default null,
  p_category text default null,
  p_lifecycle text default null,
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
  v_total bigint; v_active bigint; v_blocked bigint;
  v_arrears numeric(14,3); v_arrears_tenants bigint;
  v_archived bigint; v_current bigint;
  v_mode text := coalesce(nullif(trim(p_archive_mode), ''), 'current');
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'tenants.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_mode not in ('current', 'archived', 'all') then
    raise exception 'p_archive_mode must be current, archived, or all';
  end if;

  select count(*), count(*) filter (where t.lifecycle = 'active'),
         count(*) filter (where t.lifecycle in ('blocked', 'inactive'))
    into v_total, v_active, v_blocked
    from public.tenants t
   where t.company_id = v_company_id
     and (v_mode = 'all' or (v_mode = 'archived' and t.archived_at is not null) or (v_mode = 'current' and t.archived_at is null))
     and (p_category is null or t.category::text = p_category)
     and (p_lifecycle is null or t.lifecycle::text = p_lifecycle)
     and (p_search is null or t.code ilike '%' || p_search || '%' or t.name ilike '%' || p_search || '%'
       or coalesce(t.mobile, '') ilike '%' || p_search || '%' or coalesce(t.email, '') ilike '%' || p_search || '%');

  select count(*) filter (where t.archived_at is not null), count(*) filter (where t.archived_at is null)
    into v_archived, v_current
    from public.tenants t
   where t.company_id = v_company_id
     and (p_category is null or t.category::text = p_category)
     and (p_lifecycle is null or t.lifecycle::text = p_lifecycle)
     and (p_search is null or t.code ilike '%' || p_search || '%' or t.name ilike '%' || p_search || '%'
       or coalesce(t.mobile, '') ilike '%' || p_search || '%' or coalesce(t.email, '') ilike '%' || p_search || '%');

  select coalesce(sum(i.balance), 0), count(distinct i.tenant_id)
    into v_arrears, v_arrears_tenants
    from public.invoices i
    join public.tenants t on t.company_id = v_company_id and t.id = i.tenant_id
   where i.company_id = v_company_id and i.state = 'overdue' and i.balance > 0
     and (v_mode = 'all' or (v_mode = 'archived' and t.archived_at is not null) or (v_mode = 'current' and t.archived_at is null))
     and (p_category is null or t.category::text = p_category)
     and (p_lifecycle is null or t.lifecycle::text = p_lifecycle)
     and (p_search is null or t.code ilike '%' || p_search || '%' or t.name ilike '%' || p_search || '%'
       or coalesce(t.mobile, '') ilike '%' || p_search || '%' or coalesce(t.email, '') ilike '%' || p_search || '%');

  return jsonb_build_object(
    'total', v_total, 'active', v_active, 'blocked_inactive', v_blocked,
    'arrears', jsonb_build_object('amount', v_arrears, 'tenants', v_arrears_tenants),
    'archived_count', v_archived, 'current_count', v_current);
end;
$$;

/** يحسب مؤشرات الوحدات العقارية وإمكاناتها الإيجارية ضمن نطاق الشركة الحالية. */
create or replace function public.get_units_summary(
  p_search text default null,
  p_property_id uuid default null,
  p_building_id uuid default null,
  p_status text default null,
  p_type text default null,
  p_meter text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_total bigint; v_occupied bigint; v_vacant bigint; v_maintenance bigint; v_rent numeric(14,3);
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'units.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select count(*),
         count(*) filter (where u.status = 'occupied'),
         count(*) filter (where u.status = 'vacant'),
         count(*) filter (where u.status = 'under_maintenance'),
         coalesce(sum(coalesce(u.default_rent, 0)), 0)
    into v_total, v_occupied, v_vacant, v_maintenance, v_rent
    from public.units u
   where u.company_id = v_company_id
     and (p_property_id is null or u.property_id = p_property_id)
     and (p_building_id is null or u.building_id = p_building_id)
     and (p_status is null or u.status::text = p_status)
     and (p_type is null or u.type = p_type)
     and (p_meter is null or u.electricity_meter_ownership::text = p_meter)
     and (p_search is null or u.code ilike '%' || p_search || '%' or u.name ilike '%' || p_search || '%');

  return jsonb_build_object(
    'total', v_total, 'occupied', v_occupied, 'vacant', v_vacant,
    'under_maintenance', v_maintenance, 'rent_potential', v_rent);
end;
$$;


revoke all on function public.get_invoice_month_summary(integer, uuid) from public, anon;
revoke all on function public.get_payments_summary(text, text, text, uuid) from public, anon;
revoke all on function public.get_property_monthly_rent_totals(date) from public, anon;
revoke all on function public.get_tenants_summary(text, text, text, text) from public, anon;
revoke all on function public.get_units_summary(text, uuid, uuid, text, text, text) from public, anon;
grant execute on function public.get_invoice_month_summary(integer, uuid) to authenticated, company_service, service_role;
grant execute on function public.get_payments_summary(text, text, text, uuid) to authenticated, company_service, service_role;
grant execute on function public.get_property_monthly_rent_totals(date) to authenticated, company_service, service_role;
grant execute on function public.get_tenants_summary(text, text, text, text) to authenticated, company_service, service_role;
grant execute on function public.get_units_summary(text, uuid, uuid, text, text, text) to authenticated, company_service, service_role;
