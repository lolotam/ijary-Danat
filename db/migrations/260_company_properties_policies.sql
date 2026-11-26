-- 260_company_properties_policies.sql
-- T023 (RLS policies): Properties group
--   properties, buildings, units, maintenance_requests.
-- Idempotent.

do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in ('properties', 'buildings', 'units', 'maintenance_requests')
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

------------------------------------------------------------
-- 1. properties
------------------------------------------------------------
alter table public.properties enable row level security;
alter table public.properties force row level security;

create policy properties_select_staff on public.properties
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy properties_select_tenant on public.properties
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and exists (
      select 1
        from public.contract_units cu
        join public.units u on u.id = cu.unit_id
        join public.contracts c on c.id = cu.contract_id
        join public.profiles p on p.tenant_id = c.tenant_id
       where p.id = (select auth.uid())
         and u.property_id = properties.id
    )
  );

create policy properties_write_admin on public.properties
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  );

create policy properties_company_service_all on public.properties
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy properties_service_role_all on public.properties
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 2. buildings
------------------------------------------------------------
alter table public.buildings enable row level security;
alter table public.buildings force row level security;

create policy buildings_select_staff on public.buildings
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy buildings_write_admin on public.buildings
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  );

create policy buildings_company_service_all on public.buildings
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy buildings_service_role_all on public.buildings
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 3. units
------------------------------------------------------------
alter table public.units enable row level security;
alter table public.units force row level security;

create policy units_select_staff on public.units
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy units_select_tenant on public.units
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and exists (
      select 1
        from public.contract_units cu
        join public.contracts c on c.id = cu.contract_id
        join public.profiles p on p.tenant_id = c.tenant_id
       where p.id = (select auth.uid())
         and cu.unit_id = units.id
    )
  );

create policy units_write_admin on public.units
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  );

create policy units_company_service_all on public.units
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy units_service_role_all on public.units
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 4. maintenance_requests
------------------------------------------------------------
alter table public.maintenance_requests enable row level security;
alter table public.maintenance_requests force row level security;

create policy maintenance_requests_select_permitted on public.maintenance_requests
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'maintenance.read'))
  );

create policy maintenance_requests_insert_permitted on public.maintenance_requests
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'maintenance.create'))
  );

create policy maintenance_requests_update_permitted on public.maintenance_requests
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'maintenance.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'maintenance.update'))
  );

create policy maintenance_requests_delete_permitted on public.maintenance_requests
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'maintenance.delete'))
  );

create policy maintenance_requests_company_service_all on public.maintenance_requests
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy maintenance_requests_service_role_all on public.maintenance_requests
  for all to service_role
  using (true)
  with check (true);
