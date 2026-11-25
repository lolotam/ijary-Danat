-- 76_unit_status_lifecycle.sql
--
-- Make units.status a derived projection of active contracts.
--
-- Background: nothing has ever connected the two. There is no trigger, no
-- function and no server-fn write anywhere in db/migrations or src/fns that
-- touches a unit's status when a contract is created, activated, moved, ended
-- or deleted. The column was a free-standing manual field, and most of its
-- production values came from the mock seeds: migration 15 stamps a fixed
-- seven-occupied / two-available / one-under-maintenance pattern onto every
-- property's ten units without creating a single contract to back any of it,
-- and migration 19 hardcodes five more contractless `occupied` units.
--
-- Measured in production on 2026-08-03 (70 units, 10 contracts, all active):
-- 41 units marked `occupied` with no contract behind them, and 3 units holding a
-- live contract while marked `available`. The dashboard occupancy tile
-- (src/routes/admin.index.tsx:103) counts status = 'occupied' and reported 48.
--
-- The rule, applied to one unit:
--   active contract exists                     -> 'occupied'
--   else current is under_maintenance/archived -> keep it
--   else                                       -> 'vacant'
--
-- The middle branch is the whole reason this is a three-way decision rather
-- than a boolean: a naive `else 'vacant'` would wipe an operator's maintenance
-- flag every time an unrelated contract on that unit was touched.
--
-- `available` and `reserved` are retired into `vacant`. They stay in the
-- public.unit_status enum because Postgres cannot drop an enum value; nothing
-- writes them any more.
--
-- Shaped after migration 54, which derives tenants.lifecycle from the same
-- table. Idempotent throughout.

-- ON APPLYING THIS TO A LIVE DATABASE
--
-- There is a real window inside this file: between the units guard being
-- installed (section 5) and the backfill running (section 7), an ordinary edit
-- to one of the 3 production units that is `available` *with* a live contract
-- would reach the guard's raise branch and surface to a user as an error on an
-- unrelated save. The migration must therefore run as ONE transaction that
-- holds both tables still.
--
-- The locks deliberately are NOT in this file. `LOCK TABLE` is only legal
-- inside a transaction block, and scripts/test-db.sh applies each migration
-- with plain psql in autocommit — so an in-file lock makes the whole suite
-- unrunnable. psql executes -c and -f in order under a single
-- --single-transaction, which gives production both properties:
--
--   psql -v ON_ERROR_STOP=1 --single-transaction \
--     -c "lock table public.contracts in share row exclusive mode;
--         lock table public.units    in share row exclusive mode;" \
--     -f 76_unit_status_lifecycle.sql
--
-- contract -> unit order, matching the trigger firing order so it cannot invert
-- against normal traffic. `share row exclusive` blocks writes and other DDL but
-- still permits reads, so the app keeps serving pages throughout.

-- ---------------------------------------------------------------------------
-- 1. The occupancy predicate, in exactly one place
-- ---------------------------------------------------------------------------

-- State-based, not date-based, and that is deliberate. Nothing in this codebase
-- transitions a contract to 'expired' — contractExpiryJob only sends reminders
-- — so every input to occupancy is a write to `contracts`, which makes an AFTER
-- trigger on that table sufficient and a scheduled recompute unnecessary.
--
-- `archived_at is null` is part of the predicate because useContracts filters
-- archived contracts out of every list in the application; an archived contract
-- must not go on holding a unit occupied.
create or replace function public.unit_has_active_contract(_unit uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.contracts c
     where c.unit_id = _unit
       and c.state = 'active'
       and c.archived_at is null
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. The rule, as a pure function of (unit, current status)
-- ---------------------------------------------------------------------------

create or replace function public.compute_unit_status(
  _unit uuid,
  _current public.unit_status
)
returns public.unit_status
language sql
stable
security definer
set search_path = public
as $$
  select case
           when public.unit_has_active_contract(_unit) then 'occupied'::public.unit_status
           when _current in ('under_maintenance', 'archived') then _current
           else 'vacant'::public.unit_status
         end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Recompute one unit
-- ---------------------------------------------------------------------------

-- `security definer` is load-bearing. This runs from a trigger on `contracts`
-- and writes `public.units`. Without definer rights an accountant holding
-- contracts.update but not units.update would be stopped by RLS — and RLS
-- updates zero rows *silently* rather than raising, so occupancy would stop
-- syncing for some users while every test still passed. The accountant case in
-- src/db/unitStatus.sqltest.ts is the one test that would catch its removal.
create or replace function public.sync_unit_status_for(_unit uuid)
returns public.unit_status
language plpgsql
security definer
set search_path = public
as $$
declare
  _current public.unit_status;
  _next public.unit_status;
begin
  if _unit is null then
    return null;
  end if;

  -- `for update` so two concurrent contract writes touching the same unit
  -- cannot interleave into a stale value. The trigger below has already locked
  -- every affected unit in a deterministic order; this re-lock is a no-op there
  -- and keeps the function safe when called on its own (the backfill, or by
  -- hand).
  select status into _current
    from public.units
   where id = _unit
     for update;

  -- Defensive only. `contracts.unit_id` is ON DELETE RESTRICT (migration
  -- 04:138-142), so a unit cannot vanish while a contract still points at it —
  -- but sync_unit_status_for is also called from the backfill and could be
  -- called by hand, and a null return beats an unhandled no-data error.
  if not found then
    return null;
  end if;

  _next := public.compute_unit_status(_unit, _current);

  -- Guarded so a no-op contract save does not bump units.updated_at.
  update public.units
     set status = _next
   where id = _unit
     and status is distinct from _next;

  return _next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Keep it in sync with contracts
-- ---------------------------------------------------------------------------

create or replace function public.tg_contract_sync_unit_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _units uuid[] := '{}';
  _unit uuid;
begin
  -- A contract moving between units leaves *two* units stale. Recomputing only
  -- new.unit_id would leave the origin unit claiming a tenancy it no longer has
  -- — permanently, because nothing would ever revisit it.
  --
  -- Collected explicitly rather than with a CASE over tg_op: PL/pgSQL leaves
  -- OLD unassigned on INSERT and NEW unassigned on DELETE, and referencing
  -- either raises rather than yielding null.
  if tg_op <> 'INSERT' then
    _units := _units || old.unit_id;
  end if;

  if tg_op <> 'DELETE' then
    _units := _units || new.unit_id;
  end if;

  -- Lock every affected unit up front, in ascending uuid order, BEFORE
  -- recomputing any of them. Recomputing old-then-new without this deadlocks:
  -- `one_active_contract_per_unit` (migration 04:179-180) is a PARTIAL unique
  -- index covering only draft/active/frozen/suspended, so two *terminal*
  -- contracts may legally move A->B and B->A concurrently. One transaction
  -- would hold A and wait for B while the other holds B and waits for A.
  -- trg_contract_sync_tenant_lifecycle fires first by name order and imposes a
  -- tenant->unit ordering, but that does not help when the two contracts belong
  -- to different tenants.
  for _unit in
    select distinct x
      from unnest(_units) as t(x)
     where x is not null
     order by 1
  loop
    perform 1 from public.units where id = _unit for update;
  end loop;

  if tg_op <> 'INSERT' then
    perform public.sync_unit_status_for(old.unit_id);
  end if;

  if tg_op <> 'DELETE' then
    perform public.sync_unit_status_for(new.unit_id);
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_contract_sync_unit_status on public.contracts;
-- The `update of` column list is deliberate and differs from migration 54,
-- which uses none. Occupancy depends on exactly these three columns, and every
-- firing now takes a row lock on the unit — so letting a note or amount edit
-- fire it would widen the lock exposure the ordering above exists to bound.
-- If a column that affects occupancy is ever added, it MUST be added here too.
create trigger trg_contract_sync_unit_status
  after insert or delete or update of unit_id, state, archived_at
  on public.contracts
  for each row
  execute function public.tg_contract_sync_unit_status();

-- ---------------------------------------------------------------------------
-- 5. Stop callers writing a status the contracts do not support
-- ---------------------------------------------------------------------------

-- This is what makes the fix hold for *every* writer rather than for the paths
-- someone remembered. In particular it is why `bulk_import_phase6` is NOT
-- re-issued here: that function hardcodes
-- `coalesce(nullif(status, ''), 'available')` at migration 08:219 and again at
-- its superseding definition in 16:169, and branch 1 below normalises the value
-- on the way in. Do not "fix" the import RPC later expecting a behaviour change.
create or replace function public.tg_unit_enforce_derived_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 1. Retired values fold into their modern equivalent, silently.
  if new.status in ('available', 'reserved') then
    new.status := 'vacant';
  end if;

  if public.unit_has_active_contract(new.id) then
    -- 2. Contradicting a live contract is an operator mistake worth naming.
    --    Snapping the value back silently would leave them staring at a row
    --    that refuses to change with no explanation. Unreachable on INSERT: a
    --    brand-new unit id cannot yet be referenced by any contract, which is
    --    what keeps bulk import working.
    if new.status <> 'occupied' then
      raise exception
        'Unit % has an active contract, so its status is maintained automatically and stays occupied.',
        coalesce(new.code, new.id::text)
        using errcode = 'check_violation';
    end if;
  elsif new.status = 'occupied' then
    -- 3. Occupancy is derived, never asserted by a caller.
    new.status := 'vacant';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_unit_enforce_derived_status on public.units;
create trigger trg_unit_enforce_derived_status
  before insert or update on public.units
  for each row
  execute function public.tg_unit_enforce_derived_status();

-- Postgres grants EXECUTE on a new function to PUBLIC by default, and all three
-- of these are `security definer`. Left alone, `anon` could call the two read
-- helpers to probe which units carry contracts while bypassing contracts RLS,
-- and could call the mutator outright. Nothing in the application calls any of
-- them through the typed client; the triggers reach them through the definer
-- chain as the owner, who always holds EXECUTE. So revoking costs nothing.
revoke all on function public.unit_has_active_contract(uuid) from public;
revoke all on function public.compute_unit_status(uuid, public.unit_status) from public;
revoke all on function public.sync_unit_status_for(uuid) from public;

-- ---------------------------------------------------------------------------
-- 6. A unit with no contract starts vacant, not available
-- ---------------------------------------------------------------------------

alter table public.units alter column status set default 'vacant';

-- ---------------------------------------------------------------------------
-- 7. Bring the rows that predate the triggers into line
-- ---------------------------------------------------------------------------

-- Needed on EVERY database, not only production. Every seeding migration runs
-- before this one, so none of their inserts could fire the triggers above:
-- migration 11 seeds 4 units and 2 active contracts, migration 15 stamps a fixed
-- 7-occupied/2-available/1-maintenance pattern with no contracts at all, and
-- migration 19 hardcodes 5 more contractless `occupied` units. A from-scratch
-- build is exactly as wrong as production until this statement runs.
--
-- Expected production result: occupied 10, vacant 54, under_maintenance 6.
with target as (
  select u.id,
         public.compute_unit_status(u.id, u.status) as next_status
    from public.units u
)
update public.units u
   set status = t.next_status
  from target t
 where t.id = u.id
   and u.status is distinct from t.next_status;

-- ---------------------------------------------------------------------------
-- 8. The catalog stops offering statuses nothing can hold
-- ---------------------------------------------------------------------------

-- In production `available` and `reserved` were already switched off by hand
-- through Settings > Lists. useOptionListItemsByCode filters on is_active, so
-- the units form could not offer `available` while 14 units still displayed it
-- — a status you could see but not select. Stating it here makes the intended
-- state auditable instead of resting on an unrecorded manual edit.
--
-- Scoped to the six known enum values. `is_active = (value not in (...))` over
-- the whole list would also switch ON every custom row an admin had added and
-- deliberately switched off — a silent, unrelated behaviour change in someone
-- else's data.
update public.option_list_items i
   set is_active = (i.value in ('occupied', 'vacant', 'under_maintenance', 'archived'))
  from public.option_lists l
 where l.id = i.list_id
   and l.code = 'unit_statuses'
   and i.value in ('available', 'reserved', 'occupied', 'vacant', 'under_maintenance', 'archived')
   and i.is_active
       is distinct from (i.value in ('occupied', 'vacant', 'under_maintenance', 'archived'));

-- ---------------------------------------------------------------------------
-- 9. Prove it
-- ---------------------------------------------------------------------------

-- Data-independent, so the same statement is meaningful on production and on
-- the mock-seeded test database alike. A count assertion would not be: the two
-- carry entirely different rows.
do $$
declare
  _bad integer;
begin
  select count(*) into _bad
    from public.units u
   where (u.status = 'occupied') is distinct from public.unit_has_active_contract(u.id);
  if _bad > 0 then
    raise exception 'unit status invariant violated for % unit(s)', _bad;
  end if;

  select count(*) into _bad
    from public.units
   where status in ('available', 'reserved');
  if _bad > 0 then
    raise exception '% unit(s) left on a retired status', _bad;
  end if;
end;
$$;
