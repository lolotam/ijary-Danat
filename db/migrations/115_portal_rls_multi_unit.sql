-- 115_portal_rls_multi_unit.sql
--
-- Supersedes the tenant-portal SELECT policies on public.units and
-- public.properties from 17_tenant_portal_units_rls.sql.
--
-- Those policies gated visibility through contracts.unit_id — the single-unit
-- column that migration 110 (public.contract_units) demoted to "still written
-- for legacy readers" rather than the source of truth for which units a
-- contract holds. A tenant on a multi-unit contract would see only whichever
-- unit contracts.unit_id happened to point at, not the other rows in
-- contract_units.
--
-- No later migration had already touched these two policies (verified via
-- `grep -rn "on public.units" / "on public.properties" db/migrations/*.sql`
-- for `create policy` hits) — 17's definitions were still live, so this file
-- is the correct one to replace them.
--
-- All-or-nothing: get either policy wrong and a tenant logging into the
-- portal sees NO units and NO properties at all, not a partial result.
--
-- contract_units itself needs a tenant-reachable SELECT policy too. Its only
-- existing policy (110, contract_units_select_permitted) requires
-- has_permission(auth.uid(), 'contracts.read'), which a portal tenant never
-- holds — RLS is enforced on every table a policy's USING clause touches, not
-- just the table the policy is attached to, so without this addition the
-- `exists (select 1 from public.contract_units ...)` subqueries below would
-- always see zero rows for a tenant and both policies above would silently
-- deny everything. This mirrors contracts_select_allowed (04:269-274), the
-- same tenant-reachable shape migration 17 already relied on.
drop policy if exists contract_units_select_tenant on public.contract_units;
create policy contract_units_select_tenant on public.contract_units
  for select
  using (
    exists (
      select 1
        from public.contracts c
        join public.profiles p on p.tenant_id = c.tenant_id
       where p.id = auth.uid()
         and c.id = contract_units.contract_id
    )
  );

drop policy if exists units_select_tenant on public.units;
create policy units_select_tenant on public.units
  for select
  using (
    exists (
      select 1
      from public.contract_units cu
      join public.contracts c on c.id = cu.contract_id
      join public.profiles p on p.tenant_id = c.tenant_id
      where p.id = auth.uid()
        and cu.unit_id = units.id
    )
  );

drop policy if exists properties_select_tenant on public.properties;
create policy properties_select_tenant on public.properties
  for select
  using (
    exists (
      select 1
      from public.contract_units cu
      join public.units u on u.id = cu.unit_id
      join public.contracts c on c.id = cu.contract_id
      join public.profiles p on p.tenant_id = c.tenant_id
      where p.id = auth.uid()
        and u.property_id = properties.id
    )
  );
