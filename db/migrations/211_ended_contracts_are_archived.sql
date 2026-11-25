-- 211_ended_contracts_are_archived.sql
--
-- العقود المنتهية والمفسوخة تُحسب ضمن «المؤرشفة» لا «الحالية».
--
-- `close_out_contract` stamps `archived_at` only when the outcome is
-- `archive` (migration 114, and it says so in its own comment). The
-- `keep_terminated` and `freeze` outcomes change `state` and deliberately
-- leave `archived_at` NULL. The archive tabs, however, split purely on
-- `archived_at is null`, so a contract closed out as terminated stayed in
-- "Current" forever — four of them are sitting there in production right now,
-- still offering a Close-out action for a contract that is already closed.
--
-- The fix is a read-side rule, not a data migration: a contract is archived
-- when it has been archived OR when its state says it has ended. That
-- reclassifies the existing rows with nothing to backfill, and it does not
-- touch what `close_out_contract` writes — `archived_at` keeps its narrower
-- meaning of "an admin chose the archive outcome".
--
-- `expired` is in the set even though nothing in this codebase transitions a
-- contract to it (migration 76 established that, and 91's own comment repeats
-- it). It is a legal value of `contract_states` that a hand-run UPDATE or a
-- future job can produce, and the rule should not have to be revisited then.
--
-- The matching client-side filter lives in `src/hooks/useContracts.ts`; both
-- read `ENDED_CONTRACT_STATES`, so the list and the tab badge cannot drift.

begin;

-- هل انتهى العقد: بالأرشفة أو بحالته (منتهي أو مفسوخ).
--
-- One definition of "ended", so the list filter, the tab badge and the KPIs
-- cannot answer the question differently. Immutable and inlinable, so the
-- planner still uses the index on `state` in the counts below.
create or replace function public.contract_is_ended(
  p_archived_at timestamptz,
  p_state public.contract_states
)
returns boolean
language sql
immutable
parallel safe
set search_path = public
as $$
  select p_archived_at is not null
      or p_state in ('expired'::public.contract_states, 'terminated'::public.contract_states);
$$;

comment on function public.contract_is_ended(timestamptz, public.contract_states) is
  'يُرجع صحيحًا إذا انتهى العقد: إمّا لأنه أُرشِف، وإمّا لأن حالته منتهي أو مفسوخ. A contract is ended when it was archived, or when its state says it ended. close_out_contract stamps archived_at only for the archive outcome, so state alone carries the keep_terminated and freeze outcomes.';

revoke all on function public.contract_is_ended(timestamptz, public.contract_states) from public, anon;
grant execute on function public.contract_is_ended(timestamptz, public.contract_states)
  to authenticated, service_role;

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
        or (v_mode = 'archived' and public.contract_is_ended(c.archived_at, c.state))
        or (v_mode = 'current'  and not public.contract_is_ended(c.archived_at, c.state))
      )
      and (p_state is null or c.state::text = p_state)
      and (p_tenant_id is null or c.tenant_id = p_tenant_id)
      and (p_search is null or c.code ilike '%' || p_search || '%')
  ) f;

  -- Mode-independent archive slice counts. Honour search / state / tenant so
  -- the tab badge still matches the filtered list, but never apply p_archive_mode.
  select
    count(*) filter (where public.contract_is_ended(c.archived_at, c.state)),
    count(*) filter (where not public.contract_is_ended(c.archived_at, c.state))
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

comment on function public.get_contracts_summary(text, text, uuid, text) is
  'يُرجع مؤشرات صفحة العقود وعدّادي تبويبي «الحالية» و«المؤرشفة»، ويعدّ العقد المنتهي أو المفسوخ ضمن المؤرشفة. Returns the contracts-page KPIs plus the two archive-tab counts. Ended contracts count as archived via contract_is_ended, because close_out_contract stamps archived_at only for the archive outcome.';

-- Re-issued with the function. `create or replace` does preserve the existing
-- grants, but migration 96's rule is that every definition states them: the
-- next person to copy this body forward gets them for free, and a `revoke all
-- from public` alone would miss anon, which holds its own grant from
-- Supabase's default privileges.
revoke all on function public.get_contracts_summary(text, text, uuid, text) from public, anon;
grant execute on function public.get_contracts_summary(text, text, uuid, text)
  to authenticated, service_role;

commit;
