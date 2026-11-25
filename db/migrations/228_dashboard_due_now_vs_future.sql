-- 228_dashboard_due_now_vs_future.sql
--
-- يفصل رصيد لوحة التحكم المستحق الآن عن فواتير العقود المستقبلية التي لم يحن
-- موعدها بعد.
--
-- Found in the 2026-09-24 production walk: the "Outstanding balance" card read
-- 10,994,780 KWD while the invoices page showed 770,920 KWD outstanding for
-- 2026. Migration 219's `outstanding` summed the balance of EVERY unpaid
-- invoice, and contracts pre-generate their invoices up to 2044 — 3,238 `due`
-- invoices worth 10,789,585 KWD, none of them due yet. Only the 106 overdue
-- invoices (205,195 KWD) were actually owed.
--
-- `outstanding` now counts only invoices whose due date has arrived on the
-- Kuwait calendar (`due_date <= today in Asia/Kuwait`). The database runs in
-- UTC, the same reason migration 188 renders dates in Kuwait time; Codex
-- review on PR #253. That includes an invoice inside its grace period, which
-- `evaluate_overdue` (migration 82: `due_date + grace_days < current_date`)
-- has not flipped to overdue yet — it is owed, just not late.
-- The not-yet-due remainder is reported separately as `future_outstanding` /
-- `future_count`, so the contracted pipeline stays visible rather than
-- disappearing. Every other key is unchanged from 219.
--
-- Re-issued with `create or replace`, which keeps 219's grants; they are
-- restated at the end so this file is correct applied on its own.

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
        and i.due_date <= k.today
    ), 0),
    'future_outstanding', coalesce(sum(i.balance) filter (
      where i.state in ('overdue', 'due', 'partially_paid')
        and i.due_date > k.today
    ), 0),
    'future_count', count(*) filter (
      where i.state in ('overdue', 'due', 'partially_paid')
        and i.due_date > k.today
    ),
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
  from public.invoices i
  -- The business day is Kuwait's; the database runs in UTC, so a bare
  -- current_date would call an invoice due today "not yet due" until 03:00.
  cross join (select (now() at time zone 'Asia/Kuwait')::date as today) k;
$$;

revoke execute on function public.get_dashboard_aggregates() from public, anon;
grant execute on function public.get_dashboard_aggregates() to authenticated;
