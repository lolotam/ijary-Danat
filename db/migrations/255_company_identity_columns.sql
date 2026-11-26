-- 255_company_identity_columns.sql
-- T021 (columns, constraints, FKs, indexes): Identity group
--   profiles, user_roles, role_permissions, custom_roles,
--   custom_role_permissions, user_custom_roles, user_tenants,
--   audit_logs, failed_login_attempts.
-- Idempotent.

do $$
declare
  v_default_company_id uuid;
begin
  select id into v_default_company_id
    from public.companies
   order by created_at asc, id asc
   limit 1;

  ------------------------------------------------------------
  -- 1. profiles
  ------------------------------------------------------------
  if v_default_company_id is not null then
    update public.profiles
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  -- Remove ON DELETE SET NULL so profiles stay bound to their company.
  alter table public.profiles drop constraint if exists profiles_company_id_fkey;
  alter table public.profiles
    add constraint profiles_company_id_fkey
    foreign key (company_id) references public.companies(id);

  alter table public.profiles
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.profiles drop constraint if exists profiles_company_id_id_key;
  alter table public.profiles add constraint profiles_company_id_id_key unique (company_id, id);

  alter table public.profiles drop constraint if exists profiles_username_key;
  alter table public.profiles drop constraint if exists profiles_company_username_key;
  alter table public.profiles
    add constraint profiles_company_username_key unique (company_id, username);

  create unique index if not exists profiles_company_email_lower_idx
    on public.profiles (company_id, lower(email::text))
    where email is not null;

  drop index if exists public.profiles_tenant_id_unique;
  create unique index if not exists profiles_company_tenant_id_unique
    on public.profiles (company_id, tenant_id)
    where tenant_id is not null;

  create index if not exists profiles_company_id_idx
    on public.profiles (company_id);
  create index if not exists profiles_company_phone_digits_idx
    on public.profiles (company_id, right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 8));

  ------------------------------------------------------------
  -- 2. user_roles
  ------------------------------------------------------------
  alter table public.user_roles
    add column if not exists company_id uuid references public.companies(id);

  update public.user_roles ur
     set company_id = coalesce(p.company_id, v_default_company_id)
    from public.profiles p
   where p.id = ur.user_id
     and ur.company_id is null;

  if v_default_company_id is not null then
    update public.user_roles
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.user_roles
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.user_roles drop constraint if exists user_roles_company_id_id_key;
  alter table public.user_roles add constraint user_roles_company_id_id_key unique (company_id, id);

  alter table public.user_roles drop constraint if exists user_roles_user_id_role_key;
  alter table public.user_roles drop constraint if exists user_roles_company_user_role_key;
  alter table public.user_roles
    add constraint user_roles_company_user_role_key unique (company_id, user_id, role);

  create index if not exists user_roles_company_user_idx
    on public.user_roles (company_id, user_id);

  ------------------------------------------------------------
  -- 3. role_permissions
  ------------------------------------------------------------
  alter table public.role_permissions
    add column if not exists company_id uuid references public.companies(id);

  if v_default_company_id is not null then
    update public.role_permissions
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.role_permissions
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.role_permissions drop constraint if exists role_permissions_company_id_id_key;
  alter table public.role_permissions
    add constraint role_permissions_company_id_id_key unique (company_id, id);

  alter table public.role_permissions drop constraint if exists role_permissions_role_permission_code_key;
  alter table public.role_permissions drop constraint if exists role_permissions_company_role_perm_key;
  alter table public.role_permissions
    add constraint role_permissions_company_role_perm_key unique (company_id, role, permission_code);

  create index if not exists role_permissions_company_role_idx
    on public.role_permissions (company_id, role);

  ------------------------------------------------------------
  -- 4. custom_roles
  ------------------------------------------------------------
  alter table public.custom_roles
    add column if not exists company_id uuid references public.companies(id);

  if v_default_company_id is not null then
    update public.custom_roles
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.custom_roles
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.custom_roles drop constraint if exists custom_roles_company_id_id_key;
  alter table public.custom_roles
    add constraint custom_roles_company_id_id_key unique (company_id, id);

  alter table public.custom_roles drop constraint if exists custom_roles_code_key;
  alter table public.custom_roles drop constraint if exists custom_roles_company_code_key;
  alter table public.custom_roles
    add constraint custom_roles_company_code_key unique (company_id, code);

  create index if not exists custom_roles_company_active_idx
    on public.custom_roles (company_id, is_active);

  ------------------------------------------------------------
  -- 5. custom_role_permissions
  ------------------------------------------------------------
  alter table public.custom_role_permissions
    add column if not exists company_id uuid references public.companies(id);

  update public.custom_role_permissions crp
     set company_id = cr.company_id
    from public.custom_roles cr
   where cr.id = crp.custom_role_id
     and crp.company_id is null;

  if v_default_company_id is not null then
    update public.custom_role_permissions
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.custom_role_permissions
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.custom_role_permissions drop constraint if exists custom_role_permissions_company_id_id_key;
  alter table public.custom_role_permissions
    add constraint custom_role_permissions_company_id_id_key unique (company_id, id);

  alter table public.custom_role_permissions drop constraint if exists custom_role_permissions_custom_role_id_permission_code_key;
  alter table public.custom_role_permissions drop constraint if exists custom_role_permissions_company_role_perm_key;
  alter table public.custom_role_permissions
    add constraint custom_role_permissions_company_role_perm_key
    unique (company_id, custom_role_id, permission_code);

  alter table public.custom_role_permissions drop constraint if exists custom_role_permissions_custom_role_id_fkey;
  alter table public.custom_role_permissions drop constraint if exists custom_role_permissions_company_role_fkey;
  alter table public.custom_role_permissions
    add constraint custom_role_permissions_company_role_fkey
    foreign key (company_id, custom_role_id)
    references public.custom_roles(company_id, id) on delete cascade;

  create index if not exists custom_role_permissions_company_role_idx
    on public.custom_role_permissions (company_id, custom_role_id);

  ------------------------------------------------------------
  -- 6. user_custom_roles
  ------------------------------------------------------------
  alter table public.user_custom_roles
    add column if not exists company_id uuid references public.companies(id);

  update public.user_custom_roles ucr
     set company_id = cr.company_id
    from public.custom_roles cr
   where cr.id = ucr.custom_role_id
     and ucr.company_id is null;

  if v_default_company_id is not null then
    update public.user_custom_roles
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.user_custom_roles
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.user_custom_roles drop constraint if exists user_custom_roles_company_id_id_key;
  alter table public.user_custom_roles
    add constraint user_custom_roles_company_id_id_key unique (company_id, id);

  alter table public.user_custom_roles drop constraint if exists user_custom_roles_user_id_custom_role_id_key;
  alter table public.user_custom_roles drop constraint if exists user_custom_roles_company_user_role_key;
  alter table public.user_custom_roles
    add constraint user_custom_roles_company_user_role_key
    unique (company_id, user_id, custom_role_id);

  alter table public.user_custom_roles drop constraint if exists user_custom_roles_custom_role_id_fkey;
  alter table public.user_custom_roles drop constraint if exists user_custom_roles_company_role_fkey;
  alter table public.user_custom_roles
    add constraint user_custom_roles_company_role_fkey
    foreign key (company_id, custom_role_id)
    references public.custom_roles(company_id, id) on delete cascade;

  create index if not exists user_custom_roles_company_user_idx
    on public.user_custom_roles (company_id, user_id);

  ------------------------------------------------------------
  -- 7. user_tenants (composite FK to tenants added in 261)
  ------------------------------------------------------------
  alter table public.user_tenants
    add column if not exists company_id uuid references public.companies(id);

  update public.user_tenants ut
     set company_id = coalesce(t.company_id, v_default_company_id)
    from public.tenants t
   where t.id = ut.tenant_id
     and ut.company_id is null;

  if v_default_company_id is not null then
    update public.user_tenants
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.user_tenants
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.user_tenants drop constraint if exists user_tenants_company_id_id_key;
  alter table public.user_tenants
    add constraint user_tenants_company_id_id_key unique (company_id, id);

  alter table public.user_tenants drop constraint if exists user_tenants_user_id_tenant_id_key;
  alter table public.user_tenants drop constraint if exists user_tenants_company_user_tenant_key;
  alter table public.user_tenants
    add constraint user_tenants_company_user_tenant_key
    unique (company_id, user_id, tenant_id);

  create index if not exists user_tenants_company_user_idx
    on public.user_tenants (company_id, user_id);

  ------------------------------------------------------------
  -- 8. audit_logs
  ------------------------------------------------------------
  alter table public.audit_logs
    add column if not exists company_id uuid references public.companies(id);

  update public.audit_logs al
     set company_id = coalesce(p.company_id, v_default_company_id)
    from public.profiles p
   where p.id = al.actor_id
     and al.company_id is null;

  if v_default_company_id is not null then
    update public.audit_logs
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.audit_logs
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.audit_logs drop constraint if exists audit_logs_company_id_id_key;
  alter table public.audit_logs
    add constraint audit_logs_company_id_id_key unique (company_id, id);

  create index if not exists audit_logs_company_created_idx
    on public.audit_logs (company_id, created_at desc);
  create index if not exists audit_logs_company_actor_idx
    on public.audit_logs (company_id, actor_id);

  ------------------------------------------------------------
  -- 9. failed_login_attempts
  ------------------------------------------------------------
  alter table public.failed_login_attempts
    add column if not exists company_id uuid references public.companies(id);

  if v_default_company_id is not null then
    update public.failed_login_attempts
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.failed_login_attempts
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.failed_login_attempts drop constraint if exists failed_login_attempts_pkey;
  alter table public.failed_login_attempts
    add constraint failed_login_attempts_pkey
    primary key (company_id, scope, identifier_key, client_ip, window_start);

  create index if not exists failed_login_attempts_company_window_idx
    on public.failed_login_attempts (company_id, window_start);
end $$;

------------------------------------------------------------
-- Parent derivation triggers (when superuser/SQL tests omit company_id)
------------------------------------------------------------

/**
 * يستنتج `company_id` لدور المستخدم من ملفه الشخصي عند غياب القيمة صراحة.
 */
create or replace function public.tg_user_roles_fill_company_id()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.company_id is null then
    select p.company_id into new.company_id
      from public.profiles p
     where p.id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_user_roles_fill_company_id on public.user_roles;
create trigger trg_user_roles_fill_company_id
  before insert on public.user_roles
  for each row execute function public.tg_user_roles_fill_company_id();

/**
 * يستنتج `company_id` من جدول `custom_roles` عند غياب القيمة صراحة.
 */
create or replace function public.tg_custom_role_child_fill_company_id()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.company_id is null then
    select cr.company_id into new.company_id
      from public.custom_roles cr
     where cr.id = new.custom_role_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_crp_fill_company_id on public.custom_role_permissions;
create trigger trg_crp_fill_company_id
  before insert on public.custom_role_permissions
  for each row execute function public.tg_custom_role_child_fill_company_id();

drop trigger if exists trg_ucr_fill_company_id on public.user_custom_roles;
create trigger trg_ucr_fill_company_id
  before insert on public.user_custom_roles
  for each row execute function public.tg_custom_role_child_fill_company_id();

/**
 * يُنشئ ملف المستخدم تلقائياً عند تسجيله في `auth.users` مع ربطه بالشركة من البيانات الوصفية أو السياق.
 *
 * Skips profile creation for platform super admins and when no company can be
 * determined (preserving `profiles.company_id NOT NULL` across multi-company tests).
 */
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
  v_company_id uuid;
  v_raw_cid text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'company_id', '')), '');
begin
  if coalesce(new.raw_user_meta_data ->> 'is_platform_admin', 'false') = 'true' then
    return new;
  end if;

  if v_raw_cid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_company_id := v_raw_cid::uuid;
  else
    v_company_id := public.current_company_id();
  end if;

  if v_company_id is null then
    return new;
  end if;

  v_username := coalesce(
    new.raw_user_meta_data ->> 'username',
    split_part(coalesce(new.email, ''), '@', 1)
  );

  if v_username is not null and v_username <> '' then
    if exists (
      select 1 from public.profiles
       where company_id = v_company_id
         and username = v_username
    ) then
      v_username := v_username || '_' || substr(new.id::text, 1, 8);
    end if;
  else
    v_username := substr(new.id::text, 1, 12);
  end if;

  insert into public.profiles (id, company_id, username, display_name, email, preferred_locale)
  values (
    new.id,
    v_company_id,
    v_username,
    coalesce(new.raw_user_meta_data ->> 'display_name', v_username),
    new.email,
    coalesce((new.raw_user_meta_data ->> 'preferred_locale')::public.locale_code, 'ar')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon;
