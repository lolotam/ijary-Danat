-- 39_rls_tenant_isolation_hardening.sql
-- Hardens tenant isolation and role-grant boundaries at the RLS layer.
--
-- Fixes (from the migration RLS audit):
--   1. (HIGH)   profiles self-update let a tenant portal user rewrite their own
--               profiles.tenant_id. Every tenant-portal policy resolves identity
--               via `profiles.tenant_id = <table>.tenant_id`, so a rewritten
--               tenant_id grants cross-tenant read/write over another tenant's
--               invoices, payments, receipts, contracts and documents. RLS
--               WITH CHECK cannot pin a single column, so a BEFORE UPDATE trigger
--               now freezes the sensitive columns for a non-privileged principal
--               editing THEIR OWN row.
--   3. (LOW)    is_active re-enable — a portal user deactivated by the contract
--               trigger (21_settings_integrations.sql) could set is_active=true on
--               their own row. Closed by the same trigger.
--   2. (MEDIUM) user_roles insert checked only that the actor holds users.update,
--               not which role was granted, so a delegated "user manager" custom
--               role (16_custom_roles.sql) could self-grant admin. Granting the
--               admin role now additionally requires the actor to BE an admin.
--
-- Legitimate paths are unaffected by the trigger:
--   * service role (createAppUser / updateAppUser) — auth.uid() is null, guard skips.
--   * admins (has_permission 'users.update') — guard skips.
--   * staff-triggered portal deactivation — auth.uid() is the staff member, which
--     differs from the tenant's profile id (old.id), so the guard skips.
--
-- The INFO-level finding (RBAC config tables readable to any authenticated user)
-- is intentionally NOT changed here: usePermissions() reads role_permissions for
-- tenant users to gate the portal, so restricting that SELECT would break the
-- live tenant portal for a config-disclosure benefit that is not worth it.
--
-- Idempotent: safe to re-run.

------------------------------------------------------------
-- 1 + 3 — freeze self-modifiable identity columns on profiles
------------------------------------------------------------
create or replace function public.guard_profile_self_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only constrain a non-privileged principal editing THEIR OWN row.
  -- auth.uid() is null under the service role, and differs from old.id for
  -- admin/staff cascades (e.g. the portal-deactivation trigger), so those
  -- legitimate paths pass through untouched.
  if auth.uid() = old.id and not public.has_permission(auth.uid(), 'users.update') then
    new.tenant_id  := old.tenant_id;
    new.company_id := old.company_id;
    new.is_active  := old.is_active;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_profile_self_update on public.profiles;
create trigger trg_guard_profile_self_update
  before update on public.profiles
  for each row
  execute function public.guard_profile_self_update();

------------------------------------------------------------
-- 2 — a non-admin user-manager may not grant the admin role
------------------------------------------------------------
drop policy if exists user_roles_insert_permitted on public.user_roles;
create policy user_roles_insert_permitted on public.user_roles
  for insert to authenticated
  with check (
    public.has_permission(auth.uid(), 'users.update')
    and (role <> 'admin'::public.app_role or public.has_role(auth.uid(), 'admin'))
  );

comment on function public.guard_profile_self_update() is
  'Prevents a non-privileged user from changing tenant_id/company_id/is_active on '
  'their own profile row (tenant-isolation hardening, migration 39).';
