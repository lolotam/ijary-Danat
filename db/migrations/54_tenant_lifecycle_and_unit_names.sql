-- 54_tenant_lifecycle_and_unit_names.sql
--
-- T8: make `tenants.lifecycle` a derived column instead of a hand-maintained one.
-- T9: give `units` an English name so the EN/AR CSV columns stop duplicating.
--
-- Until now nothing has ever maintained `tenants.lifecycle`. It was written by
-- the tenant form, the bulk importer and admin_bulk_insert, then never
-- revisited, so it drifted: on production 12 of the 17 tenants marked `active`
-- held no contract at all. After this migration the column is a pure function of
-- `public.contracts`, with exactly one exception (`blocked`).
--
--   blocked        -> already blocked; never overwritten (manual admin override)
--   active         -> >= 1 contract in state 'active'
--   contract_ended -> has contracts, none active
--   inactive       -> no contracts at all
--
-- Expected, deliberate effect of the backfill on production: the visible
-- active-tenant count drops from 17 to 5. That is the drift being corrected, not
-- data loss — `contracts` is untouched and the backfill is recomputable.

-- ---------------------------------------------------------------------------
-- 1. The rule, in one place
-- ---------------------------------------------------------------------------

-- Pure and `stable`: takes the tenant's *current* lifecycle so it can honour the
-- one sticky state without a second query. Every other object in this migration
-- delegates here, which is what keeps the trigger, the insert default, the
-- unblock RPC and the backfill from ever disagreeing.
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
    -- `blocked` means "an admin decided not to deal with this tenant". No
    -- automatic process may clear it. Deliberately the only sticky state:
    -- if `contract_ended` were sticky too, a contractless tenant would keep it
    -- forever while a newly created contractless tenant got `inactive` —
    -- identical data wearing two different labels, permanently.
    when _current = 'blocked' then 'blocked'::public.tenant_lifecycle
    when exists (
      select 1 from public.contracts c
      where c.tenant_id = _tenant and c.state = 'active'
    ) then 'active'::public.tenant_lifecycle
    when exists (
      select 1 from public.contracts c where c.tenant_id = _tenant
    ) then 'contract_ended'::public.tenant_lifecycle
    else 'inactive'::public.tenant_lifecycle
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Recompute one tenant
-- ---------------------------------------------------------------------------

-- `security definer` is load-bearing, not defensive. This runs from a trigger on
-- `contracts` and writes `public.tenants`. Without definer rights an accountant
-- holding contracts.update but not tenants.update would be stopped by RLS — and
-- RLS updates *zero rows silently* rather than raising, so lifecycle would stop
-- syncing for some users while every test still passed. src/db/lifecycle.sqltest.ts
-- pins this down by driving the update as a real accountant.
create or replace function public.sync_tenant_lifecycle_for(_tenant uuid)
returns public.tenant_lifecycle
language plpgsql
security definer
set search_path = public
as $$
declare
  _next public.tenant_lifecycle;
begin
  if _tenant is null then
    return null;
  end if;

  select public.compute_tenant_lifecycle(t.id, t.lifecycle)
    into _next
    from public.tenants t
   where t.id = _tenant;

  -- The tenant may have been deleted in the same statement that cascaded to
  -- their contracts; nothing to sync.
  if _next is null then
    return null;
  end if;

  -- Guarded so a no-op contract save does not bump tenants.updated_at.
  update public.tenants
     set lifecycle = _next
   where id = _tenant
     and lifecycle is distinct from _next;

  return _next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Keep it in sync with contracts
-- ---------------------------------------------------------------------------

create or replace function public.tg_contract_sync_tenant_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A contract moving between tenants leaves *two* tenants stale. Resolving only
  -- coalesce(old.tenant_id, new.tenant_id) — which the portal-deactivation
  -- trigger in migration 21 does — would silently leave the origin tenant
  -- claiming a contract it no longer has.
  if tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id then
    perform public.sync_tenant_lifecycle_for(old.tenant_id);
  end if;

  if tg_op = 'DELETE' then
    perform public.sync_tenant_lifecycle_for(old.tenant_id);
  else
    perform public.sync_tenant_lifecycle_for(new.tenant_id);
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_contract_sync_tenant_lifecycle on public.contracts;
-- No `when` clause, unlike migration 21's trigger: every transition matters
-- here, not only departures from 'active'.
create trigger trg_contract_sync_tenant_lifecycle
  after insert or update or delete on public.contracts
  for each row
  execute function public.tg_contract_sync_tenant_lifecycle();

-- ---------------------------------------------------------------------------
-- 4. Close the insert path
-- ---------------------------------------------------------------------------

-- The contracts trigger cannot help a tenant who has no contracts: a row
-- inserted with lifecycle = 'active' would keep that claim forever. Three paths
-- do this today — the column default, the bulk importer, and admin_bulk_insert
-- (16_admin_table_operations.sql:128).
--
-- Enforcing it on the table rather than re-issuing admin_bulk_insert here is
-- deliberate: re-issuing would copy ~110 lines of unrelated expenses/deposits/
-- properties/buildings/units SQL into this file, after which migration 16 would
-- no longer hold the live definition of that function. This covers every insert
-- path, including any not found during review, in fifteen lines.
create or replace function public.tg_tenant_default_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- At insert time no contract can reference this tenant yet, so the answer is
  -- 'inactive' unless the caller explicitly asked for 'blocked'.
  new.lifecycle := public.compute_tenant_lifecycle(new.id, new.lifecycle);
  return new;
end;
$$;

drop trigger if exists trg_tenant_default_lifecycle on public.tenants;
create trigger trg_tenant_default_lifecycle
  before insert on public.tenants
  for each row
  execute function public.tg_tenant_default_lifecycle();

-- ---------------------------------------------------------------------------
-- 5. The one manual override, gated at the RPC boundary
-- ---------------------------------------------------------------------------

-- The permission check lives *here* and never inside a trigger. Migration 52 put
-- its RBAC check inside a trigger on `contracts`, so an accountant holding
-- contracts.update but not invoices.create got a 42501 that aborted the contract
-- save itself. Gate at the boundary; let triggers run with definer rights and no
-- opinion about who called them.
create or replace function public.set_tenant_blocked(_tenant uuid, _blocked boolean)
returns public.tenant_lifecycle
language plpgsql
security definer
set search_path = public
as $$
declare
  _next public.tenant_lifecycle;
begin
  if not public.has_permission(auth.uid(), 'tenants.update') then
    raise exception 'Not authorized to change tenant lifecycle'
      using errcode = '42501';
  end if;

  if _blocked then
    update public.tenants set lifecycle = 'blocked' where id = _tenant
      returning lifecycle into _next;
    return _next;
  end if;

  -- Unblocking must recompute rather than write 'active': a tenant with no
  -- contract would otherwise read `active` until their next contract write,
  -- reintroducing exactly the drift this migration removes.
  update public.tenants set lifecycle = 'inactive'
   where id = _tenant and lifecycle = 'blocked';
  return public.sync_tenant_lifecycle_for(_tenant);
end;
$$;

revoke all on function public.compute_tenant_lifecycle(uuid, public.tenant_lifecycle) from public;
revoke all on function public.sync_tenant_lifecycle_for(uuid) from public;
revoke all on function public.set_tenant_blocked(uuid, boolean) from public;

grant execute on function public.compute_tenant_lifecycle(uuid, public.tenant_lifecycle)
  to authenticated, service_role;
grant execute on function public.sync_tenant_lifecycle_for(uuid) to authenticated, service_role;
grant execute on function public.set_tenant_blocked(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Backfill
-- ---------------------------------------------------------------------------

-- Idempotent by construction: it runs the same function that now maintains the
-- column, so a second run finds nothing to change. `blocked` rows survive
-- because compute_tenant_lifecycle returns 'blocked' for them.
update public.tenants t
   set lifecycle = public.compute_tenant_lifecycle(t.id, t.lifecycle)
 where t.lifecycle is distinct from public.compute_tenant_lifecycle(t.id, t.lifecycle);

-- ---------------------------------------------------------------------------
-- 7. T9 — units get an English name
-- ---------------------------------------------------------------------------

-- Mirrors properties.name_en. Nullable, because every existing unit has only the
-- one name; the CSV and the UI fall back to `name` so nothing renders blank.
alter table public.units add column if not exists name_en text;
