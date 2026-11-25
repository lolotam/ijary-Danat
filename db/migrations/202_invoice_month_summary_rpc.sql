-- 202_invoice_month_summary_rpc.sql
--
-- ملخّص الفواتير الشهري لسنة، اختيارياً لمبنى واحد بحصّة بنود الإيجار.
--
-- /admin/invoices summed a bare select in the browser and could not be scoped
-- to a building: a consolidated invoice covers units in several buildings and
-- invoices.unit_id is NULL for it (112). A building's share of such an invoice
-- is its rent lines over all rent lines (invoice_items with a unit, excluding
-- extra-charge and concession lines); total, paid and balance follow that
-- share, count and overdue count the invoices the building touches.
--
-- RELEASE ORDER: apply BEFORE merging PR feat/invoice-pdf-and-filters — the
-- new bundle calls this RPC on /admin/invoices; the old bundle ignores it.

create or replace function public.get_invoice_month_summary(
  p_year integer,
  p_property_id uuid default null
)
returns table (
  month integer, count bigint, total numeric, paid numeric,
  outstanding numeric, overdue bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'invoices.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  with rent as (
    -- Rent lines only: a unit, not an extra charge, not a concession line.
    select ii.invoice_id, u.property_id, ii.amount
      from public.invoice_items ii
      join public.units u on u.id = ii.unit_id
     where not ii.is_extra_charge and not ii.is_concession
  ),
  shares as (
    select i.id, i.period_month, i.total, i.paid, i.balance, i.state,
           -- touches: at least one rent line in the building, whatever its amount
           (p_property_id is null
              or exists (select 1 from rent r where r.invoice_id = i.id and r.property_id = p_property_id)) as touches,
           case
             when p_property_id is null then 1::numeric
             else coalesce(
               (select sum(r.amount) from rent r where r.invoice_id = i.id and r.property_id = p_property_id)
               / nullif((select sum(r.amount) from rent r where r.invoice_id = i.id), 0),
               0)
           end as share
      from public.invoices i
     where i.period_year = p_year
  )
  select m.month,
         count(s.id) filter (where s.touches),
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

revoke execute on function public.get_invoice_month_summary(integer, uuid) from public, anon;
grant execute on function public.get_invoice_month_summary(integer, uuid) to authenticated, service_role;
