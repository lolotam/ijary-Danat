-- 110_multi_unit_contracts.sql
--
-- Promote the unit from a column on `contracts` to a join table, so one
-- contract can hold several units across several properties.
--
-- Why a new file, not an edit of 04/76/82/87: supersede-by-number. SQL
-- functions are `create or replace` and the LIVE definition of any function is
-- the one in the HIGHEST-numbered migration file. Patching an old file would
-- leave the suite asserting against text that never re-applies.
--
-- Section 1 (this task): table, backfill, constraints, totals.

create table if not exists public.contract_units (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete restrict,
  monthly_amount numeric(14,3) not null check (monthly_amount >= 0),
  line_order integer not null default 1,
  -- NOT a business field. It exists only to carry the double-booking
  -- constraint, which cannot follow `unit_id` to this table: a Postgres index
  -- predicate cannot reference `contracts.state` in another table.
  occupies_unit boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_id, unit_id)
);

create index if not exists contract_units_contract_id_idx on public.contract_units (contract_id);
create index if not exists contract_units_unit_id_idx on public.contract_units (unit_id);

drop trigger if exists set_updated_at on public.contract_units;
create trigger set_updated_at before update on public.contract_units
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Backfill. Must run BEFORE the unique index below, or the index is built
-- against an empty table and enforces nothing on existing rows.
-- ---------------------------------------------------------------------------
insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order, occupies_unit)
select c.id, c.unit_id, c.monthly_amount, 1,
       c.state in ('draft', 'active', 'frozen', 'suspended')
  from public.contracts c
 where not exists (select 1 from public.contract_units cu where cu.contract_id = c.id);

-- ---------------------------------------------------------------------------
-- occupies_unit mirrors the UNIQUENESS predicate from 04:179-180 exactly:
--   state in ('draft','active','frozen','suspended')
--
-- `archived_at` is DELIBERATELY absent, and must stay absent. It looks like an
-- omission; it is not. The uniqueness index has never considered archived_at,
-- and adding it here would let a second live contract be created on a unit an
-- archived contract still holds. Occupancy (units.status, migration 76) uses a
-- DIFFERENT predicate that does consider archived_at. The two differ on
-- purpose. Do not "make them consistent".
-- ---------------------------------------------------------------------------
create or replace function public.tg_contract_units_seed_occupies()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select c.state in ('draft', 'active', 'frozen', 'suspended')
    into new.occupies_unit
    from public.contracts c
   where c.id = new.contract_id;
  return new;
end;
$$;

drop trigger if exists trg_contract_units_seed_occupies on public.contract_units;
create trigger trg_contract_units_seed_occupies
  before insert or update of contract_id on public.contract_units
  for each row execute function public.tg_contract_units_seed_occupies();

-- Hygiene only, per 96_revoke_anon_execute_on_definer_functions.sql Group 2:
-- `returns trigger` functions cannot be invoked directly ("trigger functions
-- can only be called as triggers"), so this closes no exploit path — but
-- anonExecute.sqltest.ts asserts the SECURITY DEFINER catalogue exactly, and
-- Postgres grants EXECUTE to PUBLIC on every new function unless revoked here.
revoke execute on function public.tg_contract_units_seed_occupies() from public, anon;

create or replace function public.tg_contract_propagate_occupies()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.contract_units
     set occupies_unit = new.state in ('draft', 'active', 'frozen', 'suspended')
   where contract_id = new.id
     and occupies_unit <> (new.state in ('draft', 'active', 'frozen', 'suspended'));
  return new;
end;
$$;

drop trigger if exists trg_contract_propagate_occupies on public.contracts;
-- `update of state` only: occupies_unit is a pure function of state.
create trigger trg_contract_propagate_occupies
  after update of state on public.contracts
  for each row execute function public.tg_contract_propagate_occupies();

revoke execute on function public.tg_contract_propagate_occupies() from public, anon;

update public.contract_units cu
   set occupies_unit = c.state in ('draft', 'active', 'frozen', 'suspended')
  from public.contracts c
 where c.id = cu.contract_id;

-- RENAME, not drop: application code (bulk import, the admin contract form,
-- src/fns) still writes `contracts` directly and does not yet write
-- contract_units — that wiring is a later task. Dropping the old index here
-- would leave every one of those paths free to double-book a unit until that
-- task lands. Keeping it under a new name preserves that guard unchanged
-- (bulkImportContracts.sqltest.ts "a second live contract on the same unit is
-- refused" still passes) while the new index below adds the analogous guard
-- for contract_units. The `pg_indexes` guard makes this a one-time rename:
-- on a second application the old name no longer exists on `contracts` (it
-- was already renamed, or the name now belongs to the new index on
-- contract_units), so the block is a no-op.
do $$
begin
  if exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'one_active_contract_per_unit'
       and tablename = 'contracts'
  ) then
    alter index public.one_active_contract_per_unit
      rename to one_active_contract_per_unit_legacy;
  end if;
end;
$$;

create unique index if not exists one_active_contract_per_unit
  on public.contract_units (unit_id) where occupies_unit;

-- ---------------------------------------------------------------------------
-- contracts.monthly_amount becomes the trigger-maintained total. Application
-- code must never write it again.
-- ---------------------------------------------------------------------------
create or replace function public.tg_contract_units_sync_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _contract uuid := coalesce(new.contract_id, old.contract_id);
begin
  update public.contracts c
     set monthly_amount = coalesce(
           (select sum(cu.monthly_amount) from public.contract_units cu
             where cu.contract_id = _contract), 0)
   where c.id = _contract;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_contract_units_sync_total on public.contract_units;
create trigger trg_contract_units_sync_total
  after insert or delete or update of monthly_amount, contract_id
  on public.contract_units
  for each row execute function public.tg_contract_units_sync_total();

revoke execute on function public.tg_contract_units_sync_total() from public, anon;

alter table public.contracts alter column monthly_amount set default 0;

-- REVOKE FIRST — load-bearing (see file header / migrations 53 and 78, and
-- 84_contract_closeouts.sql for the same pattern on a new table): Postgres
-- grants ALL on a freshly created public table to anon and authenticated by
-- default, so a bare `grant ... to authenticated` below would leave anon with
-- the default-privilege grant still standing underneath it.
revoke all on public.contract_units from public, anon, authenticated;
grant select, insert, update, delete on public.contract_units to authenticated;
alter table public.contract_units enable row level security;

-- Per-operation split, mirroring contracts_select_allowed /
-- contracts_insert_permitted / contracts_update_permitted /
-- contracts_delete_permitted (04:269-284) rather than one `for all` policy,
-- because that is the shape every other policy on this table family uses.
drop policy if exists contract_units_select_permitted on public.contract_units;
create policy contract_units_select_permitted on public.contract_units for select to authenticated
  using (public.has_permission(auth.uid(), 'contracts.read'));
drop policy if exists contract_units_insert_permitted on public.contract_units;
create policy contract_units_insert_permitted on public.contract_units for insert to authenticated
  with check (public.has_permission(auth.uid(), 'contracts.create'));
drop policy if exists contract_units_update_permitted on public.contract_units;
create policy contract_units_update_permitted on public.contract_units for update to authenticated
  using (public.has_permission(auth.uid(), 'contracts.update'))
  with check (public.has_permission(auth.uid(), 'contracts.update'));
drop policy if exists contract_units_delete_permitted on public.contract_units;
create policy contract_units_delete_permitted on public.contract_units for delete to authenticated
  using (public.has_permission(auth.uid(), 'contracts.delete'));
