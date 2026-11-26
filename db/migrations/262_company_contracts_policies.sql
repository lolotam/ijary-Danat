-- 262_company_contracts_policies.sql
-- T024 (RLS policies): Renters & Contracts group
--   tenants, tenant_documents, contracts, contract_units,
--   contract_extra_charges, concessions, concession_invoices,
--   commercial_brands, commercial_brand_contracts, contract_operational_events.
-- Idempotent.

do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename in (
         'tenants',
         'tenant_documents',
         'contracts',
         'contract_units',
         'contract_extra_charges',
         'concessions',
         'concession_invoices',
         'commercial_brands',
         'commercial_brand_contracts',
         'contract_operational_events'
       )
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

------------------------------------------------------------
-- 1. tenants
------------------------------------------------------------
alter table public.tenants enable row level security;
alter table public.tenants force row level security;

create policy tenants_select_allowed on public.tenants
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select public.is_staff((select auth.uid())))
      or exists (
        select 1
          from public.profiles p
         where p.id = (select auth.uid())
           and p.tenant_id = tenants.id
      )
    )
  );

create policy tenants_insert_permitted on public.tenants
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'tenants.create'))
  );

create policy tenants_update_permitted on public.tenants
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'tenants.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'tenants.update'))
  );

create policy tenants_delete_permitted on public.tenants
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'tenants.delete'))
  );

create policy tenants_company_service_all on public.tenants
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy tenants_service_role_all on public.tenants
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 2. tenant_documents
------------------------------------------------------------
alter table public.tenant_documents enable row level security;
alter table public.tenant_documents force row level security;

create policy tenant_documents_select_allowed on public.tenant_documents
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select public.is_staff((select auth.uid())))
      or exists (
        select 1
          from public.profiles p
         where p.id = (select auth.uid())
           and p.tenant_id = tenant_documents.tenant_id
      )
    )
  );

create policy tenant_documents_insert_permitted on public.tenant_documents
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'tenants.update'))
  );

create policy tenant_documents_update_permitted on public.tenant_documents
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'tenants.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'tenants.update'))
  );

create policy tenant_documents_delete_permitted on public.tenant_documents
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'tenants.update'))
  );

create policy tenant_documents_company_service_all on public.tenant_documents
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy tenant_documents_service_role_all on public.tenant_documents
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 3. contracts
------------------------------------------------------------
alter table public.contracts enable row level security;
alter table public.contracts force row level security;

create policy contracts_select_allowed on public.contracts
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select public.is_staff((select auth.uid())))
      or (
        not coalesce(hide_from_portal, false)
        and exists (
          select 1
            from public.profiles p
           where p.id = (select auth.uid())
             and p.tenant_id = contracts.tenant_id
        )
      )
    )
  );

create policy contracts_insert_permitted on public.contracts
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.create'))
  );

create policy contracts_update_permitted on public.contracts
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.update'))
  );

create policy contracts_delete_permitted on public.contracts
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.delete'))
  );

create policy contracts_company_service_all on public.contracts
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy contracts_service_role_all on public.contracts
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 4. contract_units
------------------------------------------------------------
alter table public.contract_units enable row level security;
alter table public.contract_units force row level security;

create policy contract_units_select_permitted on public.contract_units
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.read'))
  );

create policy contract_units_select_tenant on public.contract_units
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and exists (
      select 1
        from public.contracts c
        join public.profiles p on p.tenant_id = c.tenant_id
       where p.id = (select auth.uid())
         and c.id = contract_units.contract_id
    )
  );

create policy contract_units_insert_permitted on public.contract_units
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.create'))
  );

create policy contract_units_update_permitted on public.contract_units
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.update'))
  );

create policy contract_units_delete_permitted on public.contract_units
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.delete'))
  );

create policy contract_units_company_service_all on public.contract_units
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy contract_units_service_role_all on public.contract_units
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 5. contract_extra_charges
------------------------------------------------------------
alter table public.contract_extra_charges enable row level security;
alter table public.contract_extra_charges force row level security;

create policy contract_extra_charges_select_permitted on public.contract_extra_charges
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.read'))
  );

create policy contract_extra_charges_insert_permitted on public.contract_extra_charges
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.create'))
  );

create policy contract_extra_charges_update_permitted on public.contract_extra_charges
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.update'))
  );

create policy contract_extra_charges_delete_permitted on public.contract_extra_charges
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.delete'))
  );

create policy contract_extra_charges_company_service_all on public.contract_extra_charges
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy contract_extra_charges_service_role_all on public.contract_extra_charges
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 6. concessions
------------------------------------------------------------
alter table public.concessions enable row level security;
alter table public.concessions force row level security;

create policy concessions_select_allowed on public.concessions
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select public.is_staff((select auth.uid())))
      or exists (
        select 1
          from public.contracts c
          join public.profiles p on p.tenant_id = c.tenant_id
         where c.id = concessions.contract_id
           and p.id = (select auth.uid())
      )
    )
  );

create policy concessions_insert_permitted on public.concessions
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.update'))
  );

create policy concessions_update_permitted on public.concessions
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.update'))
  );

create policy concessions_delete_permitted on public.concessions
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.update'))
  );

create policy concessions_company_service_all on public.concessions
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy concessions_service_role_all on public.concessions
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 7. concession_invoices
------------------------------------------------------------
alter table public.concession_invoices enable row level security;
alter table public.concession_invoices force row level security;

create policy concession_invoices_select_allowed on public.concession_invoices
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select public.is_staff((select auth.uid())))
      or exists (
        select 1
          from public.concessions cn
          join public.contracts c on c.id = cn.contract_id
          join public.profiles p on p.tenant_id = c.tenant_id
         where cn.id = concession_invoices.concession_id
           and p.id = (select auth.uid())
      )
    )
  );

create policy concession_invoices_company_service_all on public.concession_invoices
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy concession_invoices_service_role_all on public.concession_invoices
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 8. commercial_brands
------------------------------------------------------------
alter table public.commercial_brands enable row level security;
alter table public.commercial_brands force row level security;

create policy commercial_brands_select_company on public.commercial_brands
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      is_active = true
      or (select public.has_permission((select auth.uid()), 'landing_page.read'))
    )
  );

create policy commercial_brands_write_staff on public.commercial_brands
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.update'))
  );

create policy commercial_brands_company_service_all on public.commercial_brands
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy commercial_brands_service_role_all on public.commercial_brands
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 9. commercial_brand_contracts
------------------------------------------------------------
alter table public.commercial_brand_contracts enable row level security;
alter table public.commercial_brand_contracts force row level security;

create policy commercial_brand_contracts_select_company on public.commercial_brand_contracts
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and exists (
      select 1
        from public.commercial_brands b
       where b.id = commercial_brand_contracts.brand_id
         and (
           b.is_active = true
           or (select public.has_permission((select auth.uid()), 'landing_page.read'))
         )
    )
  );

create policy commercial_brand_contracts_write_staff on public.commercial_brand_contracts
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.update'))
  );

create policy commercial_brand_contracts_company_service_all on public.commercial_brand_contracts
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy commercial_brand_contracts_service_role_all on public.commercial_brand_contracts
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 10. contract_operational_events
------------------------------------------------------------
alter table public.contract_operational_events enable row level security;
alter table public.contract_operational_events force row level security;

create policy contract_operational_events_staff_read on public.contract_operational_events
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy contract_operational_events_company_service_all on public.contract_operational_events
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy contract_operational_events_service_role_all on public.contract_operational_events
  for all to service_role
  using (true)
  with check (true);
