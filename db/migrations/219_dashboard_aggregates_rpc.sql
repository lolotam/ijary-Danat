-- 219_dashboard_aggregates_rpc.sql
--
-- مجاميع لوحة التحكم في استدعاء واحد بدل تسعة استعلامات من المتصفح.
--
-- `fetchDashboardKpis` in src/hooks/useDashboardKpis.ts runs 9 queries (two
-- paged money reads plus 7 head counts/sums). Past ~1,000 rows PostgREST caps
-- an unranged read, so the dashboard sums would silently stop being the
-- portfolio's money (audit H10). This RPC computes the same figures
-- server-side in one call; the formulas below mirror that hook exactly,
-- including UTC month boundaries and the rule that money collected on an
-- `overdue` invoice counts toward `outstanding` but not `paid`.
--
-- `security invoker` on purpose, so RLS applies to the caller — the
-- `has_permission` guard idiom used by the definer summary RPCs cannot express
-- "dashboard is staff-only" per row, and a definer function would bypass RLS
-- entirely. Execute is granted to `authenticated` only.

create or replace function public.get_dashboard_aggregates()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'outstanding', coalesce(sum(i.balance) filter (
      where i.state in ('overdue', 'due', 'partially_paid')
    ), 0),
    'paid', coalesce(sum(i.total - i.balance) filter (
      where i.state in ('due', 'partially_paid')
    ), 0)
    + coalesce(sum(i.total) filter (where i.state = 'paid'), 0),
    'overdue_amount', coalesce(sum(i.balance) filter (
      where i.state = 'overdue'
    ), 0),
    'overdue_count', count(*) filter (where i.state = 'overdue'),
    'payments_this_month', (
      select coalesce(sum(p.amount), 0)
        from public.payments p
       where p.status = 'confirmed'
         and p.payment_date >= date_trunc('month', now() at time zone 'utc')::date
    ),
    'tenants', (
      select count(*) from public.tenants t
    ),
    'active_tenants', (
      select count(*) from public.tenants t where t.lifecycle = 'active'
    ),
    'units', (
      select count(*) from public.units u
    ),
    'occupied_units', (
      select count(*) from public.units u where u.status = 'occupied'
    ),
    'properties', (
      select count(*) from public.properties pr
    ),
    'employees', (
      select count(*) from public.employees e where e.is_active
    ),
    -- Only rows actually marked delivered count as paid — the rest are
    -- generated-but-unpaid, which is the distinction the card exists to show.
    'salaries_paid', (
      select coalesce(sum(s.amount), 0)
        from public.salaries s
       where s.year = extract(year from now() at time zone 'utc')::integer
         and s.month = extract(month from now() at time zone 'utc')::integer
         and s.delivered
    )
  )
  from public.invoices i;
$$;

revoke execute on function public.get_dashboard_aggregates() from public, anon;
grant execute on function public.get_dashboard_aggregates() to authenticated;
