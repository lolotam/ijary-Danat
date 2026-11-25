-- 162_brand_contract_links.sql
--
-- Task 1: a storefront brand links to MANY contracts, not one.
--
-- `commercial_brands.contract_id` (migration 22) is a single nullable FK, so a
-- shop that occupies two leases could only ever carry the logo on one of them.
-- The read side was already shaped for this — `linkedBrandsByContract` keys the
-- result by contract — it was the cardinality that was wrong.
--
-- EXPAND half of an expand/contract pair. This file only ADDS: the join table,
-- its policies, the backfill, and the atomic save RPC. `contract_id` stays put
-- so the bundle running during the deploy window keeps working. Migration 166
-- drops it, and must be applied only once the new container is confirmed to be
-- serving — Dokploy takes minutes to build, and "merged" is not "live".

------------------------------------------------------------------------
-- 1. The join table
------------------------------------------------------------------------
create table if not exists public.commercial_brand_contracts (
  brand_id uuid not null references public.commercial_brands(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (brand_id, contract_id)
);

-- The primary key already indexes (brand_id, …). This one serves the other
-- direction: "which brand belongs to this contract" is the lookup the tenant
-- portal and the tenant-detail logo card make on every render.
create index if not exists commercial_brand_contracts_contract_idx
  on public.commercial_brand_contracts (contract_id);

------------------------------------------------------------------------
-- 2. Backfill from the column being replaced
------------------------------------------------------------------------
insert into public.commercial_brand_contracts (brand_id, contract_id)
select b.id, b.contract_id
  from public.commercial_brands b
 where b.contract_id is not null
on conflict do nothing;

------------------------------------------------------------------------
-- 3. RLS — mirrors public.commercial_brands (migration 19) exactly
------------------------------------------------------------------------
-- A link row carries no secret of its own; it is readable exactly when the
-- brand it points at is. Restating the brand's own predicate through a lateral
-- lookup keeps a deactivated shop's links from leaking its contract ids to an
-- anonymous visitor, which a bare `using (true)` would.
alter table public.commercial_brand_contracts enable row level security;

drop policy if exists "Allow public read of commercial_brand_contracts"
  on public.commercial_brand_contracts;
create policy "Allow public read of commercial_brand_contracts"
  on public.commercial_brand_contracts
  for select to public using (
    exists (
      select 1 from public.commercial_brands b
       where b.id = commercial_brand_contracts.brand_id
         and (b.is_active = true or (auth.uid() is not null and public.is_staff(auth.uid())))
    )
  );

drop policy if exists "Allow staff write of commercial_brand_contracts"
  on public.commercial_brand_contracts;
create policy "Allow staff write of commercial_brand_contracts"
  on public.commercial_brand_contracts
  for all to authenticated
  using (public.is_staff(auth.uid()))
  with check (public.is_staff(auth.uid()));

drop policy if exists "Allow service role all on commercial_brand_contracts"
  on public.commercial_brand_contracts;
create policy "Allow service role all on commercial_brand_contracts"
  on public.commercial_brand_contracts
  for all to service_role using (true) with check (true);

------------------------------------------------------------------------
-- 4. Grants
------------------------------------------------------------------------
-- REVOKE before GRANT. Supabase's default privileges hand ALL on every new
-- public table to anon and authenticated the moment it is created, so granting
-- `select` alone would leave `insert`/`update`/`delete` already granted from
-- underneath — the table would be writable by anon with only RLS standing in
-- the way. Same order migration 96 established for this database.
revoke all on public.commercial_brand_contracts from public, anon, authenticated;
grant select on public.commercial_brand_contracts to anon, authenticated;
grant insert, update, delete on public.commercial_brand_contracts to authenticated;
grant all on public.commercial_brand_contracts to service_role;

------------------------------------------------------------------------
-- 5. save_brand_contracts — replaces a brand's whole link set atomically
------------------------------------------------------------------------
-- Delete-then-insert from the client would be two round trips, and a failure
-- between them leaves a shop linked to nothing while looking merely saved. One
-- statement pair inside one function is one transaction.
--
-- `p_contract_ids` is the complete desired set, not a delta: an empty array
-- means "linked to no contract", which is a legitimate state for a shop whose
-- lease has not been signed yet.
create or replace function public.save_brand_contracts(
  p_brand_id uuid,
  p_contract_ids uuid[]
)
returns setof public.commercial_brand_contracts
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'authenticated' and not public.is_staff(auth.uid()) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if not exists (select 1 from public.commercial_brands b where b.id = p_brand_id) then
    raise exception 'Brand not found';
  end if;

  delete from public.commercial_brand_contracts cbc
   where cbc.brand_id = p_brand_id
     and not (cbc.contract_id = any(coalesce(p_contract_ids, '{}'::uuid[])));

  insert into public.commercial_brand_contracts (brand_id, contract_id)
  select p_brand_id, unnest(coalesce(p_contract_ids, '{}'::uuid[]))
  on conflict do nothing;

  return query
    select cbc.* from public.commercial_brand_contracts cbc
     where cbc.brand_id = p_brand_id
     order by cbc.contract_id;
end;
$$;

revoke execute on function public.save_brand_contracts(uuid, uuid[]) from public, anon;
grant execute on function public.save_brand_contracts(uuid, uuid[]) to authenticated, service_role;
