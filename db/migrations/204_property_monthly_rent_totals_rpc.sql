-- 204_property_monthly_rent_totals_rpc.sql
--
-- المستحق تحصيله هذا الشهر لكل مبنى: العقود النشطة داخل مدتها، خارج الأشهر
-- المجانية، بسعر الفترة لا بالإيجار الأساسي.
--
-- /admin/properties needs "what this building should collect this month".
-- contract_units.monthly_amount is BASE rent; a contract past its increase
-- anniversary bills more (196), and the only correct pricer,
-- contract_unit_period_amounts, is service_role-only. This definer function
-- applies the generator's own eligibility (active, unarchived, term covers the
-- month, not a free month) then sums that pricer per building. Rent only —
-- recurring extra charges were excluded by decision. A NULL period is the
-- current month: a SQL default covers only an OMITTED argument.

create or replace function public.get_property_monthly_rent_totals(
  p_period_start date default date_trunc('month', current_date)::date
)
returns table (property_id uuid, monthly_total numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_period date := coalesce(p_period_start, date_trunc('month', current_date)::date);
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'properties.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  -- Unit membership comes from contract_units (read inside the pricer).
  select u.property_id, round(sum(upa.monthly_amount), 3)
    from public.contracts c
    cross join lateral public.contract_unit_period_amounts(c.id, v_period) upa
    join public.units u on u.id = upa.unit_id
   where c.state = 'active'
     and c.archived_at is null
     and v_period >= date_trunc('month', c.start_date)::date
     and v_period <= date_trunc('month', c.end_date)::date
     and not public.period_in_free_months(c.id, v_period)
   group by u.property_id;
end;
$$;

revoke execute on function public.get_property_monthly_rent_totals(date) from public, anon;
grant execute on function public.get_property_monthly_rent_totals(date) to authenticated, service_role;
