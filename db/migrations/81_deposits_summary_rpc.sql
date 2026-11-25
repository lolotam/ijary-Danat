-- 81 — deposits summary RPC for the admin deposits list-page KPI cards.
--
-- Same pattern as migration 79's get_expenses_summary: filter args match the
-- list query (and the existing get_deposit_total), security definer with
-- has_permission guard, revoke from public+anon.

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
  v_total numeric(14,3); v_count bigint;
  v_confirmed numeric(14,3); v_confirmed_count bigint;
  v_pending numeric(14,3); v_pending_count bigint;
  v_month numeric(14,3); v_month_count bigint;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'deposits.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- Predicates match get_deposit_total / fetchDeposits in useDeposits.ts.
  select
    coalesce(sum(f.amount), 0), count(*),
    coalesce(sum(f.amount) filter (where f.status = 'confirmed'), 0),
    count(*) filter (where f.status = 'confirmed'),
    coalesce(sum(f.amount) filter (where f.status = 'pending'), 0),
    count(*) filter (where f.status = 'pending')
  into v_total, v_count, v_confirmed, v_confirmed_count, v_pending, v_pending_count
  from (
    select d.*
    from public.deposits d
    where (p_from is null or d.deposit_date >= p_from)
      and (p_to is null or d.deposit_date <= p_to)
      and (p_bank is null or d.bank_name = p_bank)
      and (p_status is null or d.status = p_status)
      and (p_search is null or d.code ilike '%' || p_search || '%'
        or d.bank_name ilike '%' || p_search || '%'
        or coalesce(d.note, '') ilike '%' || p_search || '%')
  ) f;

  -- Absolute calendar month (ignores p_from/p_to), same as expenses this_month.
  select coalesce(sum(d.amount), 0), count(*)
    into v_month, v_month_count
  from public.deposits d
  where d.deposit_date >= date_trunc('month', current_date)::date
    and d.deposit_date < (date_trunc('month', current_date) + interval '1 month')::date;

  return jsonb_build_object(
    'total',      jsonb_build_object('amount', v_total,     'count', v_count),
    'confirmed',  jsonb_build_object('amount', v_confirmed, 'count', v_confirmed_count),
    'pending',    jsonb_build_object('amount', v_pending,   'count', v_pending_count),
    'this_month', jsonb_build_object('amount', v_month,     'count', v_month_count)
  );
end;
$$;

revoke all on function public.get_deposits_summary(text, text, text, date, date)
  from public, anon;
grant execute on function public.get_deposits_summary(text, text, text, date, date)
  to authenticated, service_role;
