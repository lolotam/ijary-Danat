-- 270_company_electricity_policies.sql
-- T028 (Electricity group): enable + force RLS and rewrite policies to hoisted
-- `(select public.current_company_id())` for authenticated and company_service.
-- Idempotent.

do $$
declare
  v_table text;
  v_pol text;
begin
  foreach v_table in array array[
    'electricity_tariffs',
    'electricity_meters',
    'meter_readings',
    'electricity_charges'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);

    for v_pol in
      select p.polname
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname = v_table
         and not (
           cardinality(p.polroles) = 1
           and p.polroles[1] = 'service_role'::regrole::oid
         )
    loop
      execute format('drop policy if exists %I on public.%I', v_pol, v_table);
    end loop;
  end loop;
end $$;

------------------------------------------------------------
-- electricity_tariffs
------------------------------------------------------------

create policy electricity_tariffs_staff_read on public.electricity_tariffs
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy electricity_tariffs_admin_write on public.electricity_tariffs
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'electricity.tariffs'::text))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'electricity.tariffs'::text))
  );

create policy electricity_tariffs_company_service_all on public.electricity_tariffs
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- electricity_meters
------------------------------------------------------------

create policy electricity_meters_staff_read on public.electricity_meters
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy electricity_meters_admin_write on public.electricity_meters
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  );

create policy electricity_meters_company_service_all on public.electricity_meters
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- meter_readings
------------------------------------------------------------

create policy meter_readings_staff_read on public.meter_readings
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy meter_readings_insert_permitted on public.meter_readings
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'electricity.create'::text))
  );

create policy meter_readings_update_permitted on public.meter_readings
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'electricity.update'::text))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'electricity.update'::text))
  );

create policy meter_readings_delete_permitted on public.meter_readings
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'electricity.delete'::text))
  );

create policy meter_readings_company_service_all on public.meter_readings
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- electricity_charges
------------------------------------------------------------

create policy electricity_charges_select_allowed on public.electricity_charges
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select public.is_staff((select auth.uid())))
      or (
        status = 'issued'::text
        and exists (
          select 1
            from public.profiles p
           where p.id = (select auth.uid())
             and p.tenant_id = electricity_charges.tenant_id
        )
      )
    )
  );

create policy electricity_charges_insert_permitted on public.electricity_charges
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'electricity.create'::text))
  );

create policy electricity_charges_update_permitted on public.electricity_charges
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'electricity.update'::text))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'electricity.update'::text))
  );

create policy electricity_charges_delete_permitted on public.electricity_charges
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'electricity.delete'::text))
  );

create policy electricity_charges_company_service_all on public.electricity_charges
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));
