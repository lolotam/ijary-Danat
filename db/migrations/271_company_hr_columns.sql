-- 271_company_hr_columns.sql
-- T029 (part 1): Company isolation columns, composite FKs, per-company uniques,
-- and company-led indexes for the HR table group (`employees`,
-- `employee_documents`, `salaries`).
-- Idempotent.

------------------------------------------------------------
-- 1. employees
------------------------------------------------------------

update public.employees
   set company_id = public._legacy_single_company_id()
 where company_id is null;

alter table public.employees
  drop constraint if exists employees_company_id_fkey;

alter table public.employees
  add constraint employees_company_id_fkey
  foreign key (company_id) references public.companies(id);

alter table public.employees
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'employees_company_id_id_key'
       and conrelid = 'public.employees'::regclass
  ) then
    alter table public.employees
      add constraint employees_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.employees
  drop constraint if exists employees_code_key;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'employees_company_id_code_key'
       and conrelid = 'public.employees'::regclass
  ) then
    alter table public.employees
      add constraint employees_company_id_code_key unique (company_id, code);
  end if;
end $$;

drop index if exists public.employees_active_idx;
create index if not exists employees_company_active_idx
  on public.employees (company_id, is_active);

------------------------------------------------------------
-- 2. employee_documents
------------------------------------------------------------

alter table public.employee_documents
  add column if not exists company_id uuid references public.companies(id);

update public.employee_documents d
   set company_id = e.company_id
  from public.employees e
 where e.id = d.employee_id
   and d.company_id is null;

update public.employee_documents
   set company_id = public._legacy_single_company_id()
 where company_id is null;

alter table public.employee_documents
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'employee_documents_company_id_id_key'
       and conrelid = 'public.employee_documents'::regclass
  ) then
    alter table public.employee_documents
      add constraint employee_documents_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.employee_documents
  drop constraint if exists employee_documents_employee_id_fkey,
  drop constraint if exists employee_documents_company_employee_fkey;

alter table public.employee_documents
  add constraint employee_documents_company_employee_fkey
  foreign key (company_id, employee_id)
  references public.employees(company_id, id)
  on delete cascade;

drop index if exists public.employee_documents_expiry_idx;
create index if not exists employee_documents_company_expiry_idx
  on public.employee_documents (company_id, expiry_date)
  where expiry_date is not null;

create index if not exists employee_documents_company_employee_idx
  on public.employee_documents (company_id, employee_id);

/**
 * يستمد `company_id` لوثيقة الموظف من سجل الموظف الأب عند الإدراج إذا لم يُمرَّر صراحةً.
 */
create or replace function public.tg_employee_documents_inherit_company()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.company_id is null and new.employee_id is not null then
    select e.company_id into new.company_id
      from public.employees e
     where e.id = new.employee_id;
  end if;
  return new;
end;
$$;

drop trigger if exists employee_documents_inherit_company on public.employee_documents;
create trigger employee_documents_inherit_company
  before insert on public.employee_documents
  for each row execute function public.tg_employee_documents_inherit_company();

------------------------------------------------------------
-- 3. salaries
------------------------------------------------------------

alter table public.salaries
  add column if not exists company_id uuid references public.companies(id);

update public.salaries s
   set company_id = e.company_id
  from public.employees e
 where e.id = s.employee_id
   and s.company_id is null;

update public.salaries
   set company_id = public._legacy_single_company_id()
 where company_id is null;

alter table public.salaries
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'salaries_company_id_id_key'
       and conrelid = 'public.salaries'::regclass
  ) then
    alter table public.salaries
      add constraint salaries_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.salaries
  drop constraint if exists salaries_employee_id_fkey,
  drop constraint if exists salaries_company_employee_fkey;

alter table public.salaries
  add constraint salaries_company_employee_fkey
  foreign key (company_id, employee_id)
  references public.employees(company_id, id)
  on delete cascade;

alter table public.salaries
  drop constraint if exists salaries_employee_id_year_month_key;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'salaries_company_employee_year_month_key'
       and conrelid = 'public.salaries'::regclass
  ) then
    alter table public.salaries
      add constraint salaries_company_employee_year_month_key
      unique (company_id, employee_id, year, month);
  end if;
end $$;

drop index if exists public.salaries_period_idx;
create index if not exists salaries_company_period_idx
  on public.salaries (company_id, year, month);

/**
 * يستمد `company_id` لسجل الراتب من سجل الموظف الأب عند الإدراج إذا لم يُمرَّر صراحةً.
 */
create or replace function public.tg_salaries_inherit_company()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.company_id is null and new.employee_id is not null then
    select e.company_id into new.company_id
      from public.employees e
     where e.id = new.employee_id;
  end if;
  return new;
end;
$$;

drop trigger if exists salaries_inherit_company on public.salaries;
create trigger salaries_inherit_company
  before insert on public.salaries
  for each row execute function public.tg_salaries_inherit_company();
