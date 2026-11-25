-- 33_contract_expiry_retry_failed.sql
-- Treat only sent/queued contract_expiry rows as "already handled" so a failed
-- or skipped dispatch can be retried on the next daily run.
-- Keep candidates for tenants with reminders disabled: that preference only
-- suppresses proactive WhatsApp in the dispatch layer, not email or admin alerts.
-- Idempotent. Return type unchanged vs migration 31.

drop function if exists public.identify_contract_expiry_reminders(date);

create or replace function public.identify_contract_expiry_reminders(p_as_of date default null)
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
  select
    c.id,
    c.tenant_id,
    threshold.months_until,
    null::int as days_until,
    (threshold.months_until::text || 'm') as milestone,
    'contract_expiry'::text
  from public.contracts c
  join public.tenants t on t.id = c.tenant_id
  cross join (values (4), (3), (2), (1)) as threshold(months_until)
  where c.state = 'active'
    and c.end_date = (v_as_of + make_interval(months => threshold.months_until))::date
    and not exists (
      select 1 from public.notifications n
      where n.contract_id = c.id
        and n.type = 'contract_expiry'
        and n.state in ('sent', 'queued')
        and coalesce(n.payload->>'milestone', n.payload->>'months_until' || 'm')
            = threshold.months_until::text || 'm'
    )

  union all

  select
    c.id,
    c.tenant_id,
    null::int as months_until,
    7 as days_until,
    '7d'::text as milestone,
    'contract_expiry'::text
  from public.contracts c
  join public.tenants t on t.id = c.tenant_id
  where c.state = 'active'
    and c.end_date = (v_as_of + 7)
    and not exists (
      select 1 from public.notifications n
      where n.contract_id = c.id
        and n.type = 'contract_expiry'
        and n.state in ('sent', 'queued')
        and n.payload->>'milestone' = '7d'
    )

  order by 5 desc, 1;
end;
$$;

revoke all on function public.identify_contract_expiry_reminders(date) from public;
grant execute on function public.identify_contract_expiry_reminders(date) to authenticated, service_role;
