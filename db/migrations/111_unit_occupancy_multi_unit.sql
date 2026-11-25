-- 111_unit_occupancy_multi_unit.sql
--
-- Move unit-occupancy tracking (migration 76) onto the `contract_units` join
-- table introduced in migration 110. Supersedes the occupancy half of 76:
-- `public.unit_has_active_contract(uuid)` and the single
-- `trg_contract_sync_unit_status` trigger on `contracts`.
--
-- Why a new file, not an edit of 76 or an append to 110: supersede-by-number,
-- same reasoning as 110's own header. `public.compute_unit_status` and
-- `public.sync_unit_status_for` are NOT re-issued here — the per-unit
-- projection rule itself (occupied / keep maintenance-or-archived / vacant)
-- is unchanged; only *which table tells us a unit is occupied* changes.
--
-- Predicate asymmetry, preserved on purpose (per 110's own comment on
-- `occupies_unit`, 04:179-180-adjacent): occupancy (this file) considers
-- `archived_at`; the uniqueness predicate backing `occupies_unit` and the
-- `one_active_contract_per_unit` index does NOT. An archived-but-still-active
-- contract must stop holding its unit occupied while still being allowed to
-- block a second live contract on the same unit. Do not "fix" this into
-- consistency.
--
-- Because unit membership no longer lives on `contracts`, migration 76's
-- single trigger is split in two:
--   * `trg_contract_sync_unit_status` on `contracts`, firing on
--     `update of state, archived_at` — recomputes every unit currently on
--     that contract (read from `contract_units`).
--   * `trg_contract_units_sync_unit_status` on `contract_units`, firing on
--     `insert or delete or update of unit_id` — recomputes the unit(s) whose
--     membership just changed.
--
-- Locking discipline, carried over unchanged from 76 (see 76:191-199 for the
-- full deadlock argument: two terminal contracts may legally swap units
-- concurrently via the partial `one_active_contract_per_unit` index, and
-- recomputing old-then-new without a stable lock order deadlocks). Both
-- triggers now go through one shared helper, `sync_unit_status_many`, so the
-- "lock everything in ascending uuid order before recomputing anything" rule
-- lives in exactly one place instead of being duplicated per trigger.

-- ---------------------------------------------------------------------------
-- 1. The occupancy predicate, re-pointed at contract_units
-- ---------------------------------------------------------------------------

-- Same three-column shape as 76: state-based, not date-based, and
-- `archived_at is null` because useContracts filters archived contracts out
-- of every application list. Now joins through contract_units instead of
-- reading contracts.unit_id directly, so a contract with several units marks
-- all of them occupied, not just the first.
create or replace function public.unit_has_active_contract(_unit uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.contract_units cu
      join public.contracts c on c.id = cu.contract_id
     where cu.unit_id = _unit
       and c.state = 'active'
       and c.archived_at is null
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. Shared locking + recompute helper
-- ---------------------------------------------------------------------------

-- Lock every affected unit up front, in ascending uuid order, BEFORE
-- recomputing any of them — 76's rule, unchanged. Both triggers below call
-- this instead of each re-implementing the two-pass lock/recompute loop.
create or replace function public.sync_unit_status_many(_units uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _unit uuid;
begin
  for _unit in
    select distinct x from unnest(_units) as t(x) where x is not null order by 1
  loop
    perform 1 from public.units where id = _unit for update;
  end loop;

  for _unit in
    select distinct x from unnest(_units) as t(x) where x is not null order by 1
  loop
    perform public.sync_unit_status_for(_unit);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. contracts side: state / archived_at changes recompute every unit
--    currently on the contract
-- ---------------------------------------------------------------------------

create or replace function public.tg_contract_sync_unit_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_unit_status_many(
    array(select cu.unit_id from public.contract_units cu where cu.contract_id = new.id)
  );
  return new;
end;
$$;

drop trigger if exists trg_contract_sync_unit_status on public.contracts;
-- `update of state, archived_at` only. unit_id is gone from this trigger's
-- concern -- membership itself now lives on contract_units and is handled by
-- trg_contract_units_sync_unit_status below. If a column that affects
-- occupancy is ever added, it MUST be added here too (76's own warning,
-- still true).
create trigger trg_contract_sync_unit_status
  after update of state, archived_at on public.contracts
  for each row execute function public.tg_contract_sync_unit_status();

-- ---------------------------------------------------------------------------
-- 4. contract_units side: membership changes recompute the affected unit(s)
-- ---------------------------------------------------------------------------

create or replace function public.tg_contract_units_sync_unit_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _units uuid[] := '{}';
begin
  -- A unit moving from one contract_units row to another (UPDATE of unit_id)
  -- leaves *two* units stale, same reasoning as 76's contracts-side trigger:
  -- collected explicitly rather than a CASE over tg_op, because PL/pgSQL
  -- leaves OLD unassigned on INSERT and NEW unassigned on DELETE.
  if tg_op <> 'INSERT' then
    _units := _units || old.unit_id;
  end if;

  if tg_op <> 'DELETE' then
    _units := _units || new.unit_id;
  end if;

  perform public.sync_unit_status_many(_units);
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_contract_units_sync_unit_status on public.contract_units;
create trigger trg_contract_units_sync_unit_status
  after insert or delete or update of unit_id on public.contract_units
  for each row execute function public.tg_contract_units_sync_unit_status();

-- ---------------------------------------------------------------------------
-- 5. Security catalogue
-- ---------------------------------------------------------------------------

-- Postgres grants EXECUTE on a new function to PUBLIC by default, and a
-- `create or replace` does not reset an existing grant either way — so these
-- are belt-and-suspenders for unit_has_active_contract and
-- tg_contract_sync_unit_status (already revoked by 76 / migration 96) and the
-- actual close for the two functions this file introduces. `from public`
-- alone (76's idiom) misses an explicit Route-A `anon` grant; naming both is
-- the convention every migration since 96 follows (see 110's tail).
revoke execute on function public.unit_has_active_contract(uuid) from public, anon;
revoke execute on function public.sync_unit_status_many(uuid[]) from public, anon;
revoke execute on function public.tg_contract_sync_unit_status() from public, anon;
revoke execute on function public.tg_contract_units_sync_unit_status() from public, anon;
