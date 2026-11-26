-- 258_company_lists_policies.sql
-- T022 (RLS policies): Lists group
--   option_lists, option_list_items, building_categories,
--   expense_categories, invoice_years, card_visibility.
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
         'option_lists',
         'option_list_items',
         'building_categories',
         'expense_categories',
         'invoice_years',
         'card_visibility'
       )
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

------------------------------------------------------------
-- 1. option_lists
------------------------------------------------------------
alter table public.option_lists enable row level security;
alter table public.option_lists force row level security;

create policy option_lists_select on public.option_lists
  for select to authenticated
  using (company_id = (select public.current_company_id()));

create policy option_lists_write on public.option_lists
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'settings.lists'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'settings.lists'))
  );

create policy option_lists_company_service_all on public.option_lists
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy option_lists_service_role_all on public.option_lists
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 2. option_list_items
------------------------------------------------------------
alter table public.option_list_items enable row level security;
alter table public.option_list_items force row level security;

create policy option_list_items_select on public.option_list_items
  for select to authenticated
  using (company_id = (select public.current_company_id()));

create policy option_list_items_write on public.option_list_items
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'settings.lists'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'settings.lists'))
  );

create policy option_list_items_company_service_all on public.option_list_items
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy option_list_items_service_role_all on public.option_list_items
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 3. building_categories
------------------------------------------------------------
alter table public.building_categories enable row level security;
alter table public.building_categories force row level security;

create policy building_categories_select_staff on public.building_categories
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy building_categories_write_admin on public.building_categories
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  );

create policy building_categories_company_service_all on public.building_categories
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy building_categories_service_role_all on public.building_categories
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 4. expense_categories
------------------------------------------------------------
alter table public.expense_categories enable row level security;
alter table public.expense_categories force row level security;

create policy expense_categories_staff_read on public.expense_categories
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy expense_categories_admin_write on public.expense_categories
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'expenses.categories'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'expenses.categories'))
  );

create policy expense_categories_company_service_all on public.expense_categories
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy expense_categories_service_role_all on public.expense_categories
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 5. invoice_years
------------------------------------------------------------
alter table public.invoice_years enable row level security;
alter table public.invoice_years force row level security;

create policy invoice_years_read on public.invoice_years
  for select to authenticated
  using (company_id = (select public.current_company_id()));

create policy invoice_years_insert_perm on public.invoice_years
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'invoices.create'))
  );

create policy invoice_years_company_service_all on public.invoice_years
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy invoice_years_service_role_all on public.invoice_years
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 6. card_visibility
------------------------------------------------------------
alter table public.card_visibility enable row level security;
alter table public.card_visibility force row level security;

create policy card_visibility_select on public.card_visibility
  for select to authenticated
  using (company_id = (select public.current_company_id()));

create policy card_visibility_write on public.card_visibility
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'company.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'company.update'))
  );

create policy card_visibility_company_service_all on public.card_visibility
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy card_visibility_service_role_all on public.card_visibility
  for all to service_role
  using (true)
  with check (true);
