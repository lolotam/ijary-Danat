-- 268_company_closeout_policies.sql
-- T027 (Closeout group): enable + force RLS and rewrite policies to hoisted
-- `(select public.current_company_id())` for authenticated and company_service.
-- Idempotent.

do $$
declare
  v_table text;
  v_pol text;
begin
  foreach v_table in array array[
    'contract_closeouts',
    'contract_closeout_deductions',
    'contract_closeout_invoice_actions'
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
-- contract_closeouts
------------------------------------------------------------

create policy contract_closeouts_staff_read on public.contract_closeouts
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy contract_closeouts_insert_permitted on public.contract_closeouts
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.close_out'::text))
  );

create policy contract_closeouts_update_permitted on public.contract_closeouts
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.close_out'::text))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.close_out'::text))
  );

create policy contract_closeouts_company_service_all on public.contract_closeouts
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- contract_closeout_deductions
------------------------------------------------------------

create policy contract_closeout_deductions_staff_read on public.contract_closeout_deductions
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy contract_closeout_deductions_insert_permitted on public.contract_closeout_deductions
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.close_out'::text))
  );

create policy contract_closeout_deductions_update_permitted on public.contract_closeout_deductions
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.close_out'::text))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.close_out'::text))
  );

create policy contract_closeout_deductions_delete_permitted on public.contract_closeout_deductions
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.close_out'::text))
  );

create policy contract_closeout_deductions_company_service_all on public.contract_closeout_deductions
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- contract_closeout_invoice_actions
------------------------------------------------------------

create policy contract_closeout_invoice_actions_staff_read on public.contract_closeout_invoice_actions
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy contract_closeout_invoice_actions_insert_permitted on public.contract_closeout_invoice_actions
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.close_out'::text))
  );

create policy contract_closeout_invoice_actions_update_permitted on public.contract_closeout_invoice_actions
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.close_out'::text))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.close_out'::text))
  );

create policy contract_closeout_invoice_actions_delete_permitted on public.contract_closeout_invoice_actions
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'contracts.close_out'::text))
  );

create policy contract_closeout_invoice_actions_company_service_all on public.contract_closeout_invoice_actions
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));
