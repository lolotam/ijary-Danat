-- 17_tenant_portal_units_rls.sql
-- Tenants could not load their lease or payable invoices in the portal:
-- units/properties/companies SELECT was staff-only, so the portal's unit
-- lookup and the company payment-settings lookup returned 0 rows
-- (PostgREST 406). Tenants may read only the units they hold a contract
-- for, the properties those units belong to, and their own company row.

drop policy if exists units_select_tenant on public.units;
create policy units_select_tenant on public.units
  for select
  using (
    exists (
      select 1
      from public.contracts c
      join public.profiles p on p.tenant_id = c.tenant_id
      where p.id = auth.uid()
        and c.unit_id = units.id
    )
  );

drop policy if exists companies_select_tenant on public.companies;
create policy companies_select_tenant on public.companies
  for select
  using (
    exists (
      select 1
      from public.tenants tn
      join public.profiles p on p.tenant_id = tn.id
      where p.id = auth.uid()
        and tn.company_id = companies.id
    )
  );

drop policy if exists properties_select_tenant on public.properties;
create policy properties_select_tenant on public.properties
  for select
  using (
    exists (
      select 1
      from public.contracts c
      join public.units u on u.id = c.unit_id
      join public.profiles p on p.tenant_id = c.tenant_id
      where p.id = auth.uid()
        and u.property_id = properties.id
    )
  );
