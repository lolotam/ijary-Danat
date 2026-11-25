-- 91_summary_archived_count.sql
--
-- Correctness fix for migration 90: re-issue get_contracts_summary and
-- get_tenants_summary so archived_count (and current_count) are computed
-- INDEPENDENTLY of p_archive_mode.
--
-- Migration 90 computed archived_count inside the mode-filtered set. On
-- p_archive_mode = 'current' that always returned 0 — useless for the
-- "Archived (n)" tab badge on the Current tab, which is the whole point of
-- the field.
--
-- *** SAME 4-ARG SIGNATURE AS MIGRATION 90 — NO DROP NEEDED. ***
--
-- Migration 90 needed `drop function if exists …(3-arg)` only because it
-- changed the signature (3-arg → 4-arg). `create or replace` cannot replace a
-- different arity. Here the identity is unchanged (text, text, uuid, text) /
-- (text, text, text, text), so body-only create or replace is correct and
-- safe. Do not "harmonise" this file with 90 by adding drops.

------------------------------------------------------------
-- Contracts summary
------------------------------------------------------------

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
  v_total bigint; v_active bigint; v_expiring bigint; v_ended bigint;
  v_next_expiry date; v_monthly numeric(14,3);
  v_archived bigint;
  v_current bigint;
  v_mode text := coalesce(nullif(trim(p_archive_mode), ''), 'current');
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'contracts.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if v_mode not in ('current', 'archived', 'all') then
    raise exception 'p_archive_mode must be current, archived, or all';
  end if;

  -- Mode-scoped KPIs (total/active/… honour p_archive_mode).
  select
    count(*),
    count(*) filter (where f.state = 'active'),
    -- There is no `expiring` state. Migration 76: nothing in this codebase
    -- transitions a contract to `expired`, so the window is computed from
    -- end_date over live contracts.
    count(*) filter (
      where f.state = 'active'
        and f.end_date between current_date and current_date + 60
    ),
    count(*) filter (where f.state in ('expired', 'terminated')),
    min(f.end_date) filter (
      where f.state = 'active' and f.end_date >= current_date
    ),
    coalesce(sum(f.monthly_amount) filter (where f.state = 'active'), 0)
  into v_total, v_active, v_expiring, v_ended, v_next_expiry, v_monthly
  from (
    select c.*
    from public.contracts c
    where (
        v_mode = 'all'
        or (v_mode = 'archived' and c.archived_at is not null)
        or (v_mode = 'current'  and c.archived_at is null)
      )
      and (p_state is null or c.state::text = p_state)
      and (p_tenant_id is null or c.tenant_id = p_tenant_id)
      and (p_search is null or c.code ilike '%' || p_search || '%')
  ) f;

  -- Mode-independent archive slice counts. Honour search / state / tenant so
  -- the tab badge still matches the filtered list, but never apply p_archive_mode.
  select
    count(*) filter (where c.archived_at is not null),
    count(*) filter (where c.archived_at is null)
  into v_archived, v_current
  from public.contracts c
  where (p_state is null or c.state::text = p_state)
    and (p_tenant_id is null or c.tenant_id = p_tenant_id)
    and (p_search is null or c.code ilike '%' || p_search || '%');

  return jsonb_build_object(
    'total', v_total,
    'active', v_active,
    'expiring_60d', v_expiring,
    'ended', v_ended,
    'next_expiry', v_next_expiry,
    'monthly_amount', v_monthly,
    'annual_amount', v_monthly * 12,
    'archived_count', v_archived,
    'current_count', v_current
  );
end;
$$;

revoke all on function public.get_contracts_summary(text, text, uuid, text) from public, anon;
grant execute on function public.get_contracts_summary(text, text, uuid, text)
  to authenticated, service_role;

------------------------------------------------------------
-- Tenants summary
------------------------------------------------------------

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
  v_total bigint; v_active bigint; v_blocked bigint;
  v_arrears numeric(14,3); v_arrears_tenants bigint;
  v_archived bigint;
  v_current bigint;
  v_mode text := coalesce(nullif(trim(p_archive_mode), ''), 'current');
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'tenants.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if v_mode not in ('current', 'archived', 'all') then
    raise exception 'p_archive_mode must be current, archived, or all';
  end if;

  -- Two statements rather than one: joining `invoices` into the same select
  -- would multiply the tenant rows and corrupt the count(*) aggregates.
  select
    count(*),
    count(*) filter (where t.lifecycle = 'active'),
    count(*) filter (where t.lifecycle in ('blocked', 'inactive'))
  into v_total, v_active, v_blocked
  from public.tenants t
  where (
      v_mode = 'all'
      or (v_mode = 'archived' and t.archived_at is not null)
      or (v_mode = 'current'  and t.archived_at is null)
    )
    and (p_category is null or t.category::text = p_category)
    and (p_lifecycle is null or t.lifecycle::text = p_lifecycle)
    and (p_search is null or t.code ilike '%' || p_search || '%'
      or t.name ilike '%' || p_search || '%'
      or coalesce(t.mobile, '') ilike '%' || p_search || '%'
      or coalesce(t.email, '') ilike '%' || p_search || '%');

  -- Mode-independent archive slice counts (same non-archive filters only).
  select
    count(*) filter (where t.archived_at is not null),
    count(*) filter (where t.archived_at is null)
  into v_archived, v_current
  from public.tenants t
  where (p_category is null or t.category::text = p_category)
    and (p_lifecycle is null or t.lifecycle::text = p_lifecycle)
    and (p_search is null or t.code ilike '%' || p_search || '%'
      or t.name ilike '%' || p_search || '%'
      or coalesce(t.mobile, '') ilike '%' || p_search || '%'
      or coalesce(t.email, '') ilike '%' || p_search || '%');

  select coalesce(sum(i.balance), 0), count(distinct i.tenant_id)
  into v_arrears, v_arrears_tenants
  from public.invoices i
  join public.tenants t on t.id = i.tenant_id
  where i.state = 'overdue' and i.balance > 0
    and (
      v_mode = 'all'
      or (v_mode = 'archived' and t.archived_at is not null)
      or (v_mode = 'current'  and t.archived_at is null)
    )
    and (p_category is null or t.category::text = p_category)
    and (p_lifecycle is null or t.lifecycle::text = p_lifecycle)
    and (p_search is null or t.code ilike '%' || p_search || '%'
      or t.name ilike '%' || p_search || '%'
      or coalesce(t.mobile, '') ilike '%' || p_search || '%'
      or coalesce(t.email, '') ilike '%' || p_search || '%');

  return jsonb_build_object(
    'total', v_total,
    'active', v_active,
    'blocked_inactive', v_blocked,
    'arrears', jsonb_build_object('amount', v_arrears, 'tenants', v_arrears_tenants),
    'archived_count', v_archived,
    'current_count', v_current
  );
end;
$$;

revoke all on function public.get_tenants_summary(text, text, text, text) from public, anon;
grant execute on function public.get_tenants_summary(text, text, text, text)
  to authenticated, service_role;
