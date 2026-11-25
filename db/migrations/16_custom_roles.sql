-- ============================================================
-- Migration 16: Custom Roles
-- Allows admins to create arbitrary roles beyond the built-in
-- app_role enum, assign permissions from the permission pool,
-- and assign those roles to users. has_permission() is extended
-- to also consider custom roles.
-- Idempotent.
-- ============================================================

------------------------------------------------------------
-- custom_roles
------------------------------------------------------------
create table if not exists public.custom_roles (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name_ar     text not null,
  name_en     text not null,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) on delete set null
);

create index if not exists custom_roles_active_idx on public.custom_roles (is_active);

grant select on public.custom_roles to authenticated;
grant insert, update, delete on public.custom_roles to authenticated;
grant all on public.custom_roles to service_role;

alter table public.custom_roles enable row level security;

drop policy if exists custom_roles_select_all on public.custom_roles;
create policy custom_roles_select_all on public.custom_roles
  for select to authenticated using (true);

drop policy if exists custom_roles_write_admin on public.custom_roles;
create policy custom_roles_write_admin on public.custom_roles
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists custom_roles_service_all on public.custom_roles;
create policy custom_roles_service_all on public.custom_roles
  for all to service_role using (true) with check (true);

------------------------------------------------------------
-- custom_role_permissions
------------------------------------------------------------
create table if not exists public.custom_role_permissions (
  id              uuid primary key default gen_random_uuid(),
  custom_role_id  uuid not null references public.custom_roles(id) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  created_at      timestamptz not null default now(),
  unique (custom_role_id, permission_code)
);

create index if not exists custom_role_permissions_role_idx
  on public.custom_role_permissions (custom_role_id);

grant select, insert, delete on public.custom_role_permissions to authenticated;
grant all on public.custom_role_permissions to service_role;

alter table public.custom_role_permissions enable row level security;

drop policy if exists crp_select_all on public.custom_role_permissions;
create policy crp_select_all on public.custom_role_permissions
  for select to authenticated using (true);

drop policy if exists crp_write_admin on public.custom_role_permissions;
create policy crp_write_admin on public.custom_role_permissions
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists crp_service_all on public.custom_role_permissions;
create policy crp_service_all on public.custom_role_permissions
  for all to service_role using (true) with check (true);

------------------------------------------------------------
-- user_custom_roles (assignment)
------------------------------------------------------------
create table if not exists public.user_custom_roles (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  custom_role_id  uuid not null references public.custom_roles(id) on delete cascade,
  created_at      timestamptz not null default now(),
  unique (user_id, custom_role_id)
);

create index if not exists ucr_user_idx on public.user_custom_roles (user_id);
create index if not exists ucr_role_idx on public.user_custom_roles (custom_role_id);

grant select, insert, delete on public.user_custom_roles to authenticated;
grant all on public.user_custom_roles to service_role;

alter table public.user_custom_roles enable row level security;

drop policy if exists ucr_select_own_or_admin on public.user_custom_roles;
create policy ucr_select_own_or_admin on public.user_custom_roles
  for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

drop policy if exists ucr_write_admin on public.user_custom_roles;
create policy ucr_write_admin on public.user_custom_roles
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists ucr_service_all on public.user_custom_roles;
create policy ucr_service_all on public.user_custom_roles
  for all to service_role using (true) with check (true);

------------------------------------------------------------
-- has_permission() — extend to consider custom roles
------------------------------------------------------------
create or replace function public.has_permission(_user_id uuid, _code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.has_role(_user_id, 'admin')
    or exists (
      select 1
      from public.user_roles ur
      join public.role_permissions rp on rp.role = ur.role
      where ur.user_id = _user_id
        and rp.permission_code = _code
    )
    or exists (
      select 1
      from public.user_custom_roles ucr
      join public.custom_roles cr on cr.id = ucr.custom_role_id
      join public.custom_role_permissions crp on crp.custom_role_id = cr.id
      where ucr.user_id = _user_id
        and cr.is_active = true
        and crp.permission_code = _code
    ),
    false
  )
$$;

revoke all on function public.has_permission(uuid, text) from public;
grant execute on function public.has_permission(uuid, text) to authenticated, service_role;
