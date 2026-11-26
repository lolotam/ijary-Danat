-- 256_company_identity_policies.sql
-- T021 (RLS policies): companies + Identity group
--   companies, profiles, user_roles, role_permissions, custom_roles,
--   custom_role_permissions, user_custom_roles, user_tenants,
--   audit_logs, failed_login_attempts.
-- Drops all prior policies (including any TO public policies) and enforces
-- hoisted `(select public.current_company_id())` across authenticated & company_service.
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
         'companies',
         'profiles',
         'user_roles',
         'role_permissions',
         'custom_roles',
         'custom_role_permissions',
         'user_custom_roles',
         'user_tenants',
         'audit_logs',
         'failed_login_attempts'
       )
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

------------------------------------------------------------
-- 0. permissions (global read-only catalogue; force RLS)
------------------------------------------------------------
alter table public.permissions enable row level security;
alter table public.permissions force row level security;

------------------------------------------------------------
-- 1. companies (PK id = current_company_id(); never DELETE)
------------------------------------------------------------
alter table public.companies enable row level security;
alter table public.companies force row level security;

create policy companies_select_own on public.companies
  for select to authenticated, company_service
  using (id = (select public.current_company_id()));

create policy companies_update_authenticated on public.companies
  for update to authenticated
  using (
    id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'company.update'))
  )
  with check (
    id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'company.update'))
  );

create policy companies_update_company_service on public.companies
  for update to company_service
  using (id = (select public.current_company_id()))
  with check (id = (select public.current_company_id()));

create policy companies_service_role_all on public.companies
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 2. profiles
------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.profiles force row level security;

create policy profiles_select_own_or_admin on public.profiles
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select auth.uid()) = id
      or (select public.has_permission((select auth.uid()), 'users.read'))
    )
  );

create policy profiles_insert_admin on public.profiles
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'users.create'))
  );

create policy profiles_update_own_or_admin on public.profiles
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select auth.uid()) = id
      or (select public.has_permission((select auth.uid()), 'users.update'))
    )
  )
  with check (
    company_id = (select public.current_company_id())
    and (
      (select auth.uid()) = id
      or (select public.has_permission((select auth.uid()), 'users.update'))
    )
  );

create policy profiles_company_service_all on public.profiles
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy profiles_service_role_all on public.profiles
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 3. user_roles
------------------------------------------------------------
alter table public.user_roles enable row level security;
alter table public.user_roles force row level security;

create policy user_roles_select_own_or_admin on public.user_roles
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select auth.uid()) = user_id
      or (select public.has_permission((select auth.uid()), 'users.read'))
    )
  );

create policy user_roles_insert_permitted on public.user_roles
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'users.update'))
    and (role <> 'admin'::public.app_role or (select public.has_role((select auth.uid()), 'admin'::public.app_role)))
  );

create policy user_roles_delete_permitted on public.user_roles
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'users.delete'))
  );

create policy user_roles_company_service_all on public.user_roles
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy user_roles_service_role_all on public.user_roles
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 4. role_permissions
------------------------------------------------------------
alter table public.role_permissions enable row level security;
alter table public.role_permissions force row level security;

create policy role_permissions_select_company on public.role_permissions
  for select to authenticated
  using (company_id = (select public.current_company_id()));

create policy role_permissions_write_admin on public.role_permissions
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  );

create policy role_permissions_company_service_all on public.role_permissions
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy role_permissions_service_role_all on public.role_permissions
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 5. custom_roles
------------------------------------------------------------
alter table public.custom_roles enable row level security;
alter table public.custom_roles force row level security;

create policy custom_roles_select_company on public.custom_roles
  for select to authenticated
  using (company_id = (select public.current_company_id()));

create policy custom_roles_write_admin on public.custom_roles
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  );

create policy custom_roles_company_service_all on public.custom_roles
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy custom_roles_service_role_all on public.custom_roles
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 6. custom_role_permissions
------------------------------------------------------------
alter table public.custom_role_permissions enable row level security;
alter table public.custom_role_permissions force row level security;

create policy crp_select_company on public.custom_role_permissions
  for select to authenticated
  using (company_id = (select public.current_company_id()));

create policy crp_write_admin on public.custom_role_permissions
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  );

create policy crp_company_service_all on public.custom_role_permissions
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy crp_service_role_all on public.custom_role_permissions
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 7. user_custom_roles
------------------------------------------------------------
alter table public.user_custom_roles enable row level security;
alter table public.user_custom_roles force row level security;

create policy ucr_select_own_or_admin on public.user_custom_roles
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      user_id = (select auth.uid())
      or (select public.has_role((select auth.uid()), 'admin'::public.app_role))
    )
  );

create policy ucr_write_admin on public.user_custom_roles
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  );

create policy ucr_company_service_all on public.user_custom_roles
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy ucr_service_role_all on public.user_custom_roles
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 8. user_tenants
------------------------------------------------------------
alter table public.user_tenants enable row level security;
alter table public.user_tenants force row level security;

create policy user_tenants_select on public.user_tenants
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      user_id = (select auth.uid())
      or (select public.has_permission((select auth.uid()), 'users.read'))
    )
  );

create policy user_tenants_write on public.user_tenants
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'users.assign_tenants'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'users.assign_tenants'))
  );

create policy user_tenants_company_service_all on public.user_tenants
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy user_tenants_service_role_all on public.user_tenants
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 9. audit_logs (append-only for app callers)
------------------------------------------------------------
alter table public.audit_logs enable row level security;
alter table public.audit_logs force row level security;

create policy audit_logs_select_staff on public.audit_logs
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select public.is_staff((select auth.uid())))
      or (select public.has_role((select auth.uid()), 'admin'::public.app_role))
    )
  );

create policy audit_logs_insert_own on public.audit_logs
  for insert to authenticated
  with check (
    company_id = (select public.current_company_id())
    and actor_id = (select auth.uid())
  );

create policy audit_logs_company_service_select on public.audit_logs
  for select to company_service
  using (company_id = (select public.current_company_id()));

create policy audit_logs_company_service_insert on public.audit_logs
  for insert to company_service
  with check (company_id = (select public.current_company_id()));

create policy audit_logs_service_role_all on public.audit_logs
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 10. failed_login_attempts
------------------------------------------------------------
alter table public.failed_login_attempts enable row level security;
alter table public.failed_login_attempts force row level security;

create policy failed_login_attempts_select_audit on public.failed_login_attempts
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'audit.read'))
  );

create policy failed_login_attempts_company_service_all on public.failed_login_attempts
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy failed_login_attempts_service_role_all on public.failed_login_attempts
  for all to service_role
  using (true)
  with check (true);
