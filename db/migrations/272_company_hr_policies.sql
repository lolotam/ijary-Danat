-- 272_company_hr_policies.sql
-- T029 (part 2): Forced RLS and hoisted company-scoped policies for `employees`,
-- `employee_documents`, and `salaries`.
-- Idempotent.

------------------------------------------------------------
-- 1. employees
------------------------------------------------------------

grant select, insert, update, delete on public.employees to company_service;

alter table public.employees enable row level security;
alter table public.employees force row level security;

drop policy if exists employees_staff_read on public.employees;
drop policy if exists employees_insert_permitted on public.employees;
drop policy if exists employees_update_permitted on public.employees;
drop policy if exists employees_delete_permitted on public.employees;
drop policy if exists employees_company_service_all on public.employees;

create policy employees_staff_read on public.employees
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy employees_insert_permitted on public.employees
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'employees.create'))
  );

create policy employees_update_permitted on public.employees
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'employees.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'employees.update'))
  );

create policy employees_delete_permitted on public.employees
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'employees.delete'))
  );

create policy employees_company_service_all on public.employees
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 2. employee_documents
------------------------------------------------------------

grant select, insert, update, delete on public.employee_documents to company_service;

alter table public.employee_documents enable row level security;
alter table public.employee_documents force row level security;

drop policy if exists employee_documents_staff_read on public.employee_documents;
drop policy if exists employee_documents_insert_permitted on public.employee_documents;
drop policy if exists employee_documents_update_permitted on public.employee_documents;
drop policy if exists employee_documents_delete_permitted on public.employee_documents;
drop policy if exists employee_documents_company_service_all on public.employee_documents;

create policy employee_documents_staff_read on public.employee_documents
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy employee_documents_insert_permitted on public.employee_documents
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'employees.update'))
  );

create policy employee_documents_update_permitted on public.employee_documents
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'employees.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'employees.update'))
  );

create policy employee_documents_delete_permitted on public.employee_documents
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'employees.delete'))
  );

create policy employee_documents_company_service_all on public.employee_documents
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 3. salaries
------------------------------------------------------------

grant select, insert, update, delete on public.salaries to company_service;

alter table public.salaries enable row level security;
alter table public.salaries force row level security;

drop policy if exists salaries_staff_read on public.salaries;
drop policy if exists salaries_insert_permitted on public.salaries;
drop policy if exists salaries_update_permitted on public.salaries;
drop policy if exists salaries_delete_permitted on public.salaries;
drop policy if exists salaries_company_service_all on public.salaries;

create policy salaries_staff_read on public.salaries
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy salaries_insert_permitted on public.salaries
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'salaries.create'))
  );

create policy salaries_update_permitted on public.salaries
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'salaries.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'salaries.update'))
  );

create policy salaries_delete_permitted on public.salaries
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'salaries.delete'))
  );

create policy salaries_company_service_all on public.salaries
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));
