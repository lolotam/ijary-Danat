-- 34_contract_expiry_delivery_retries.sql
-- Contract-expiry messages retry independently per recipient and channel.

alter table public.notifications add column if not exists delivery_key text;

create unique index if not exists notifications_contract_expiry_delivery_idx
  on public.notifications(delivery_key)
  where type = 'contract_expiry'
    and state in ('queued', 'sent')
    and delivery_key is not null;

drop function if exists public.identify_contract_expiry_reminders(date);

create function public.identify_contract_expiry_reminders(p_as_of date default null)
returns table(
  contract_id uuid,
  tenant_id uuid,
  months_until int,
  days_until int,
  milestone text,
  template_type text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_as_of date := coalesce(p_as_of, current_date);
begin
  if auth.role() = 'authenticated' and not public.has_permission(auth.uid(), 'notifications.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  select c.id, c.tenant_id, threshold.months_until, null::int,
    threshold.months_until::text || 'm', 'contract_expiry'::text
  from public.contracts c
  join public.tenants t on t.id = c.tenant_id
  cross join (values (4), (3), (2), (1)) as threshold(months_until)
  where c.state = 'active'
    and c.end_date <= (v_as_of + make_interval(months => threshold.months_until))::date
    and c.end_date > (v_as_of + make_interval(months => threshold.months_until - 1))::date

  union all

  select c.id, c.tenant_id, null::int, 7, '7d'::text, 'contract_expiry'::text
  from public.contracts c
  join public.tenants t on t.id = c.tenant_id
  where c.state = 'active'
    and c.end_date between v_as_of and v_as_of + 7

  order by 5 desc, 1;
end;
$$;

revoke all on function public.identify_contract_expiry_reminders(date) from public;
grant execute on function public.identify_contract_expiry_reminders(date) to authenticated, service_role;
