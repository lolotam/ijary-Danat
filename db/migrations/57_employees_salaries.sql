-- 57_employees_salaries.sql
--
-- T14a: employees, their documents, and monthly salaries.
--
-- Entirely greenfield — there were zero references to `employee` or `salary`
-- anywhere in db/migrations or src/ before this. The risk in this batch is not
-- breaking existing behaviour, it is reinventing things the repo already
-- solves, so shapes are copied deliberately from expenses, tenant_documents and
-- the company-documents bucket.

create sequence if not exists public.employee_code_seq;

create or replace function public.next_employee_code()
returns text language sql security definer set search_path = public
as $$ select 'EMP-' || lpad(nextval('public.employee_code_seq')::text, 5, '0') $$;

revoke all on function public.next_employee_code() from public;
grant execute on function public.next_employee_code() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1. Employees
-- ---------------------------------------------------------------------------

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  code text unique not null default public.next_employee_code(),
  company_id uuid references public.companies(id) on delete set null,
  name text not null,
  name_en text,
  nickname text,
  mobile text,
  email text,
  -- The employee's CURRENT monthly salary. Generation copies this figure onto
  -- each salaries row rather than joining it at read time — see the comment on
  -- generate_salaries_for_month.
  salary numeric(14,3) not null default 0 check (salary >= 0),
  -- A storage path, NOT a URL. Staff photographs go in a private bucket and are
  -- served through signed URLs; uploadImageToBucket returns public URLs, which
  -- is right for a landing-page image and wrong for a person.
  avatar_path text,
  hired_on date,
  is_active boolean not null default true,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.employees enable row level security;

-- Staff-only, for every column. Salary figures must never reach a tenant portal
-- user. No column-level revoke is needed here (unlike gmail_connections) because
-- nothing in this table is a credential — the whole row is simply staff-only.
drop policy if exists employees_staff_read on public.employees;
create policy employees_staff_read on public.employees for select to authenticated
  using (public.is_staff(auth.uid()));
drop policy if exists employees_insert_permitted on public.employees;
create policy employees_insert_permitted on public.employees for insert to authenticated
  with check (public.has_permission(auth.uid(), 'employees.create'));
drop policy if exists employees_update_permitted on public.employees;
create policy employees_update_permitted on public.employees for update to authenticated
  using (public.has_permission(auth.uid(), 'employees.update'))
  with check (public.has_permission(auth.uid(), 'employees.update'));
drop policy if exists employees_delete_permitted on public.employees;
create policy employees_delete_permitted on public.employees for delete to authenticated
  using (public.has_permission(auth.uid(), 'employees.delete'));
drop policy if exists employees_service_role_all on public.employees;
create policy employees_service_role_all on public.employees for all to service_role
  using (true) with check (true);

drop trigger if exists employees_set_updated_at on public.employees;
create trigger employees_set_updated_at before update on public.employees
  for each row execute function public.tg_set_updated_at();

create index if not exists employees_active_idx on public.employees (is_active);

-- ---------------------------------------------------------------------------
-- 2. Employee documents
-- ---------------------------------------------------------------------------

-- Mirrors public.tenant_documents, PLUS `expiry_date` — which tenant_documents
-- does not have, and which is the whole reason this is a separate table rather
-- than a reuse. A residency permit or work licence running out is exactly what
-- HR needs to see coming, and Batch F's expiry digest can read this column.
create table if not exists public.employee_documents (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  document_type text not null default 'other',
  storage_path text not null,
  display_name text,
  mime_type text,
  size_bytes bigint,
  expiry_date date,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.employee_documents enable row level security;

drop policy if exists employee_documents_staff_read on public.employee_documents;
create policy employee_documents_staff_read on public.employee_documents for select to authenticated
  using (public.is_staff(auth.uid()));
drop policy if exists employee_documents_insert_permitted on public.employee_documents;
create policy employee_documents_insert_permitted on public.employee_documents for insert to authenticated
  with check (public.has_permission(auth.uid(), 'employees.update'));
drop policy if exists employee_documents_update_permitted on public.employee_documents;
create policy employee_documents_update_permitted on public.employee_documents for update to authenticated
  using (public.has_permission(auth.uid(), 'employees.update'))
  with check (public.has_permission(auth.uid(), 'employees.update'));
drop policy if exists employee_documents_delete_permitted on public.employee_documents;
create policy employee_documents_delete_permitted on public.employee_documents for delete to authenticated
  using (public.has_permission(auth.uid(), 'employees.delete'));
drop policy if exists employee_documents_service_role_all on public.employee_documents;
create policy employee_documents_service_role_all on public.employee_documents for all to service_role
  using (true) with check (true);

create index if not exists employee_documents_expiry_idx
  on public.employee_documents (expiry_date)
  where expiry_date is not null;

-- ---------------------------------------------------------------------------
-- 3. Salaries
-- ---------------------------------------------------------------------------

create table if not exists public.salaries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  year integer not null check (year between 2000 and 2200),
  month integer not null check (month between 1 and 12),
  amount numeric(14,3) not null check (amount >= 0),
  delivered boolean not null default false,
  delivered_at timestamptz,
  delivered_by uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- What makes monthly generation idempotent — the same role
  -- unique (contract_id, period_year, period_month) plays for invoices. A cron
  -- job that can run twice without doubling someone's pay is not optional.
  unique (employee_id, year, month)
);

alter table public.salaries enable row level security;

drop policy if exists salaries_staff_read on public.salaries;
create policy salaries_staff_read on public.salaries for select to authenticated
  using (public.is_staff(auth.uid()));
drop policy if exists salaries_insert_permitted on public.salaries;
create policy salaries_insert_permitted on public.salaries for insert to authenticated
  with check (public.has_permission(auth.uid(), 'salaries.create'));
drop policy if exists salaries_update_permitted on public.salaries;
create policy salaries_update_permitted on public.salaries for update to authenticated
  using (public.has_permission(auth.uid(), 'salaries.update'))
  with check (public.has_permission(auth.uid(), 'salaries.update'));
drop policy if exists salaries_delete_permitted on public.salaries;
create policy salaries_delete_permitted on public.salaries for delete to authenticated
  using (public.has_permission(auth.uid(), 'salaries.delete'));
drop policy if exists salaries_service_role_all on public.salaries;
create policy salaries_service_role_all on public.salaries for all to service_role
  using (true) with check (true);

drop trigger if exists salaries_set_updated_at on public.salaries;
create trigger salaries_set_updated_at before update on public.salaries
  for each row execute function public.tg_set_updated_at();

create index if not exists salaries_period_idx on public.salaries (year, month);

-- ---------------------------------------------------------------------------
-- 4. Private document bucket
-- ---------------------------------------------------------------------------

-- Mirrors company-documents (migration 49). Deliberately NOT the `branding`
-- bucket, which migration 21 made world-readable to serve the landing-page logo
-- — staff photographs and residency documents must not be public.
insert into storage.buckets (id, name, public)
values ('employee-documents', 'employee-documents', false)
on conflict (id) do nothing;

drop policy if exists employee_documents_read on storage.objects;
create policy employee_documents_read on storage.objects
  for select to authenticated
  using (bucket_id = 'employee-documents' and public.is_staff(auth.uid()));

drop policy if exists employee_documents_write on storage.objects;
create policy employee_documents_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'employee-documents' and public.has_permission(auth.uid(), 'employees.update')
  );

drop policy if exists employee_documents_update on storage.objects;
create policy employee_documents_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'employee-documents' and public.has_permission(auth.uid(), 'employees.update')
  );

drop policy if exists employee_documents_remove on storage.objects;
create policy employee_documents_remove on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'employee-documents' and public.has_permission(auth.uid(), 'employees.delete')
  );

-- ---------------------------------------------------------------------------
-- 5. Permissions
-- ---------------------------------------------------------------------------

insert into public.permissions (code, module, action, is_system)
select m.module || '.' || a.action, m.module, a.action, true
from (values ('employees'), ('salaries')) as m(module)
cross join (values ('create'), ('read'), ('update'), ('delete'), ('export')) as a(action)
on conflict (code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'admin'::public.app_role, p.code
from public.permissions p where p.module in ('employees', 'salaries')
on conflict (role, permission_code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'accountant'::public.app_role, p.code
from public.permissions p
where p.module in ('employees', 'salaries')
  and p.action in ('create', 'read', 'update', 'export')
on conflict (role, permission_code) do nothing;

-- ---------------------------------------------------------------------------
-- 6. Monthly generation
-- ---------------------------------------------------------------------------

-- One row per ACTIVE employee for the given month.
--
-- `amount` is COPIED from employees.salary rather than joined at read time. A
-- join would mean raising someone's salary silently rewrites history, including
-- months already marked delivered — the payroll equivalent of recomputing a paid
-- invoice, which is exactly what migration 55 refuses to do.
--
-- `on conflict do nothing` against unique (employee_id, year, month) is what
-- makes this safe to run repeatedly, which a cron job must be.
create or replace function public.generate_salaries_for_month(
  p_year integer default null,
  p_month integer default null
)
-- `setof public.salaries` rather than an explicit OUT column list: named OUT
-- parameters would be `id`, `employee_id`, `year`, `month`, `amount`, and those
-- collide with the real columns in the `on conflict` target and the `returning`
-- clause — "column reference employee_id is ambiguous". An `on conflict` target
-- cannot be table-qualified, so the collision cannot be aliased away.
returns setof public.salaries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer := coalesce(p_year, extract(year from current_date)::integer);
  v_month integer := coalesce(p_month, extract(month from current_date)::integer);
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'salaries.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_year < 2000 or v_year > 2200 then
    raise exception 'Target year is outside the supported range';
  end if;
  if v_month < 1 or v_month > 12 then
    raise exception 'Target month is outside the supported range';
  end if;

  return query
  insert into public.salaries (employee_id, year, month, amount)
  select e.id, v_year, v_month, e.salary
    from public.employees e
   where e.is_active
   order by e.code
  on conflict (employee_id, year, month) do nothing
  returning *;
end;
$$;

revoke all on function public.generate_salaries_for_month(integer, integer) from public;
grant execute on function public.generate_salaries_for_month(integer, integer)
  to authenticated, service_role;
