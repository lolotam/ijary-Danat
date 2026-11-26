-- 266_company_ledgers_policies.sql
-- T026 (Ledgers group): enable + force RLS and rewrite policies to hoisted
-- `(select public.current_company_id())` for authenticated and company_service.
-- Idempotent.

do $$
declare
  v_table text;
  v_pol text;
begin
  foreach v_table in array array[
    'deposits',
    'partial_payments',
    'insurance_payments',
    'refunds',
    'expenses'
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
-- deposits
------------------------------------------------------------

create policy deposits_staff_read on public.deposits
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy deposits_insert_permitted on public.deposits
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'deposits.create'::text))
  );

create policy deposits_update_permitted on public.deposits
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'deposits.update'::text))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'deposits.update'::text))
  );

create policy deposits_delete_permitted on public.deposits
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'deposits.delete'::text))
  );

create policy deposits_company_service_all on public.deposits
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- partial_payments
------------------------------------------------------------

create policy partial_payments_staff_read on public.partial_payments
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy partial_payments_insert_permitted on public.partial_payments
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'partial_payments.create'::text))
  );

create policy partial_payments_update_permitted on public.partial_payments
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'partial_payments.update'::text))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'partial_payments.update'::text))
  );

create policy partial_payments_delete_permitted on public.partial_payments
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'partial_payments.delete'::text))
  );

create policy partial_payments_company_service_all on public.partial_payments
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- insurance_payments
------------------------------------------------------------

create policy insurance_payments_staff_read on public.insurance_payments
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy insurance_payments_insert_permitted on public.insurance_payments
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'insurance.create'::text))
  );

create policy insurance_payments_update_permitted on public.insurance_payments
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'insurance.update'::text))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'insurance.update'::text))
  );

create policy insurance_payments_delete_permitted on public.insurance_payments
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'insurance.delete'::text))
  );

create policy insurance_payments_company_service_all on public.insurance_payments
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- refunds
------------------------------------------------------------

create policy refunds_staff_read on public.refunds
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy refunds_insert_permitted on public.refunds
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'refunds.create'::text))
  );

create policy refunds_update_permitted on public.refunds
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'refunds.update'::text))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'refunds.update'::text))
  );

create policy refunds_delete_permitted on public.refunds
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'refunds.delete'::text))
    and status = 'draft'::text
  );

create policy refunds_company_service_all on public.refunds
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- expenses
------------------------------------------------------------

create policy expenses_staff_read on public.expenses
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy expenses_insert_permitted on public.expenses
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'expenses.create'::text))
  );

create policy expenses_update_permitted on public.expenses
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'expenses.update'::text))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'expenses.update'::text))
  );

create policy expenses_delete_permitted on public.expenses
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'expenses.delete'::text))
  );

create policy expenses_company_service_all on public.expenses
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));
