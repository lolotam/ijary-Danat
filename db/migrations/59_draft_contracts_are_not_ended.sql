-- 59_draft_contracts_are_not_ended.sql
--
-- Fixes a mislabelling found by live testing on 2026-07-31, not by any test.
--
-- Migration 54 defined `contract_ended` as "has contracts, none active". A
-- contract in state 'draft' satisfies that, so a tenant whose only contract is a
-- draft starting next month reads **Contract ended** — a lease that has not
-- begun, labelled as finished.
--
-- This is not a corner case. It is the documented admin working order, and the
-- order docs/testing/2026-07-31-user-journeys-t1-t15.md tells staff to follow:
--
--     create the tenant -> create the portal login -> add the contract (draft)
--     -> activate it
--
-- Between steps three and four every such tenant reads "Contract ended".
--
-- `contract_ended` must mean *a lease of theirs has ended*. Of the seven states
-- in public.contract_states, 'draft' is the only one describing a lease that has
-- never run, so it is the only one excluded here. 'frozen' and 'suspended' stay
-- in — those are live leases that are paused, and the tenant genuinely has no
-- lease running today.
--
--   blocked        -> already blocked; never overwritten (manual admin override)
--   active         -> >= 1 contract in state 'active'
--   contract_ended -> has >= 1 non-draft contract, none active
--   inactive       -> no contracts at all, or only drafts

create or replace function public.compute_tenant_lifecycle(
  _tenant uuid,
  _current public.tenant_lifecycle
)
returns public.tenant_lifecycle
language sql
stable
security definer
set search_path = public
as $$
  select case
    when _current = 'blocked' then 'blocked'::public.tenant_lifecycle
    when exists (
      select 1 from public.contracts c
      where c.tenant_id = _tenant and c.state = 'active'
    ) then 'active'::public.tenant_lifecycle
    -- The only change from migration 54: `and c.state <> 'draft'`. A draft is a
    -- lease that has not started; it cannot have ended.
    when exists (
      select 1 from public.contracts c
      where c.tenant_id = _tenant and c.state <> 'draft'
    ) then 'contract_ended'::public.tenant_lifecycle
    else 'inactive'::public.tenant_lifecycle
  end;
$$;

-- Correct any tenant already wearing the wrong label. Recomputes every row
-- rather than targeting drafts, so this stays a safe no-op re-run: the rule is
-- the single source of truth and `is distinct from` keeps updated_at still for
-- rows that were already right.
update public.tenants t
   set lifecycle = public.compute_tenant_lifecycle(t.id, t.lifecycle)
 where t.lifecycle is distinct from public.compute_tenant_lifecycle(t.id, t.lifecycle);
