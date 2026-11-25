-- 142_deactivation_enforcement.sql
--
-- `profiles.is_active` has been written since migration 01 by four paths — the
-- admin Users switch, createAppUser, the closeout restore RPC, and migration
-- 21's contract trigger — and read as a gate by none of them. Deactivating a
-- user has never blocked anything: not the login, not a route guard, not a
-- single RLS policy. This migration makes the flag load-bearing.
--
-- Five parts, and the order matters:
--
--   ١  repoint migration 21's trigger off the account flag onto the portal flag
--   ٢  move the state that trigger already wrote, without locking anyone out
--   ٣  ban the accounts that were deactivated deliberately
--   ٤  teach has_role / is_staff / has_permission to respect the flag
--   ٥  stop restore_contract from silently undoing a deactivation
--
-- Part ٣ must follow part ٢, or it bans the very rows part ٢ is restoring.
--
-- Every dollar-quoted body below carries its own tag ($trg$, $role$, $staff$,
-- $restore$, $mig$, $fn$, $body$) and none use a bare $$. That is not style.
-- Applying an earlier draft of this file to production silently skipped the
-- `restore_contract` re-issue while still running the `comment on function`
-- that follows it: psql lost track of the nesting and swallowed the statement,
-- and without ON_ERROR_STOP it simply carried on. The file was transferred with
-- CRLF endings, which is the difference from the LF copy that applies cleanly
-- locally. Unique tags remove the ambiguity; apply with ON_ERROR_STOP=1 and
-- --single-transaction regardless.

-- ---------------------------------------------------------------------------
-- ١. يوقف بوابة المستأجر — لا الحساب — عند انتهاء آخر عقد نشط.
--
-- Migration 21 named this function "deactivate_portal_users…" and wrote
-- `profiles.is_active`, which is the ACCOUNT flag. Inert while nothing read
-- it; the moment login consults it, every tenant whose contract merely ended
-- is locked out of their account rather than out of the portal. It is
-- repointed at `tenants.tenant_portal_enabled`, which is what the portal
-- already gates on (portal.tsx, createPayment.ts, and the RLS in migration 06).
-- ---------------------------------------------------------------------------
create or replace function public.deactivate_portal_users_without_active_contract()
returns trigger
language plpgsql
security definer
set search_path = public
as $trg$
declare
  _tenant uuid := coalesce(old.tenant_id, new.tenant_id);
begin
  if _tenant is not null and not exists (
    select 1 from public.contracts c
    where c.tenant_id = _tenant and c.state = 'active'
  ) then
    update public.tenants
      set tenant_portal_enabled = false
      where id = _tenant and tenant_portal_enabled;
  end if;
  return coalesce(new, old);
end;
$trg$;

comment on function public.deactivate_portal_users_without_active_contract() is
  'Disables the tenant portal when a tenant has no active contract left. Writes tenants.tenant_portal_enabled; it deliberately does NOT touch profiles.is_active, which is the account flag (migration 142).';

-- The trigger definition itself is unchanged and is restated only so this file
-- is self-contained: same timing, same `when (old.state = 'active')` guard.
drop trigger if exists trg_contract_deactivate_portal on public.contracts;
create trigger trg_contract_deactivate_portal
  after update of state or delete on public.contracts
  for each row
  when (old.state = 'active')
  execute function public.deactivate_portal_users_without_active_contract();


-- ---------------------------------------------------------------------------
-- ٢. ينقل ما كتبه المُشغِّل القديم من علم الحساب إلى علم البوابة.
--
-- Expressed as the trigger's own precondition rather than as "every false row
-- was the trigger's doing". The single inactive profile in production has an
-- ACTIVE contract, so the trigger cannot have written it — an admin did,
-- deliberately, and a blanket restore would undo the exact deactivation this
-- migration exists to start enforcing.
--
-- One statement, not two. As separate sweeps the second would disable the
-- portal for every tenant without an active contract, which includes `frozen`
-- and `suspended` contracts and brand-new tenants still on a `draft` — none of
-- which the trigger ever fired for, and whose portal access createAppUser turns
-- on deliberately. The CTE moves state only for rows actually restored here.
--
-- Staff are excluded by `tenant_id is not null`: the trigger only ever touched
-- rows with a tenant, so a false there is always admin-authored.
-- ---------------------------------------------------------------------------
with restored as (
  update public.profiles p
     set is_active = true
   where not p.is_active
     and p.tenant_id is not null
     and not exists (
       select 1 from public.contracts c
        where c.tenant_id = p.tenant_id and c.state = 'active')
  returning p.tenant_id
)
update public.tenants t
   set tenant_portal_enabled = false
 where t.id in (select tenant_id from restored)
   and t.tenant_portal_enabled;


-- ---------------------------------------------------------------------------
-- ٣. يمنع الحسابات الموقوفة أصلاً من إصدار أي جلسة جديدة.
--
-- The server function added alongside this migration bans accounts as they are
-- toggled from here on. Every row deactivated BEFORE today would otherwise keep
-- a working password grant straight against GoTrue — the anon key and the
-- Supabase URL are compiled into the browser bundle, so the login form is not a
-- boundary. Production's one deliberately-deactivated account is exactly that
-- shape: is_active false, banned_until unset. Without this the feature ships
-- and the account that reported the bug stays open.
--
-- Runs after part ٢ so it sees only the deliberate deactivations.
--
-- Finite, not `'infinity'`: Postgres accepts `infinity` for a timestamptz but
-- GoTrue's Go driver cannot scan it into a `time.Time`, so a row holding it
-- fails to load at all — no password change, no login, no unban (500
-- "Database error loading user"). 876000 hours is the value `setUserActive`
-- sends as `ban_duration`, so the back-fill and the runtime path agree.
-- Migration 144 repairs databases that ran the earlier `'infinity'` form.
--
-- A ban already in the future is only left alone when it outlasts the one this
-- statement would write. A shorter one — a temporary ban set by hand, say —
-- would otherwise expire and hand the account back its password grant while
-- the profile still reads inactive, which is the exact hole this part exists
-- to close. The 1000-hour dead band below that threshold is what keeps
-- re-application a no-op: without it every run would rewrite the rows a
-- previous run had already banned, since `now()` has moved on.
-- ---------------------------------------------------------------------------
update auth.users u
   set banned_until = now() + interval '876000 hours'
 where exists (
     select 1 from public.profiles p
      where p.id = u.id and not p.is_active)
   and (u.banned_until is null or u.banned_until < now() + interval '875000 hours');


-- ---------------------------------------------------------------------------
-- ٤. يمنع الحساب الموقوف من اجتياز أي فحص صلاحيات.
--
-- Defence in depth rather than decoration. A login-form check alone is
-- bypassable, so this makes a token obtained by any other means read nothing.
--
-- All three functions are re-issued in full with one added clause and no other
-- change. `has_role` matters most: it gates the admin policies, including all
-- three on `profiles` itself (01:141, :148, :153-154), companies_write_admin,
-- and branding_admin_write on storage.objects (21:41-45). Gating only
-- has_permission and is_staff would leave the highest-privilege role the least
-- defended.
--
-- No RLS recursion. `profiles_select_own_or_admin` calls these functions and
-- they now read `profiles`, but all three are SECURITY DEFINER owned by
-- `postgres`, which owns the table, and no table here has FORCE ROW LEVEL
-- SECURITY — so the definer's read bypasses the policy instead of re-entering
-- it. `stable` remains correct: the added read is a primary-key probe of the
-- same volatility class as the reads already there.
--
-- Parameter names are load-bearing: `create or replace function` cannot rename
-- an input parameter, so `_code` and `_role` must stay exactly as they are.
-- ---------------------------------------------------------------------------
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $role$
  select exists (
    select 1 from public.profiles p
     where p.id = _user_id and p.is_active
  ) and exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  )
$role$;

create or replace function public.is_staff(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $staff$
  select exists (
    select 1 from public.profiles p
     where p.id = _user_id and p.is_active
  ) and exists (
    select 1 from public.user_roles
    where user_id = _user_id
      and role in ('admin', 'accountant', 'collector', 'readonly')
  )
$staff$;

-- `has_permission` is the one of the three whose live body is not the same
-- everywhere, so it is assembled rather than hard-coded.
--
-- Migration 16 added custom roles and re-issued this function with a third
-- branch over user_custom_roles / custom_roles / custom_role_permissions. Those
-- three tables exist in this repository and in a database built from
-- db/migrations, but **not in the deployed production database**, whose live
-- has_permission is still migration 03's two-branch version. Verified directly
-- against production, which is also where a hard-coded migration-16 body first
-- failed with 42P01 "relation public.user_custom_roles does not exist".
--
-- A `language sql` body is parsed and validated at CREATE time, so a
-- to_regclass guard inside the SQL cannot save it — the missing relation is a
-- creation error, not a runtime one. Hence the branch is appended as text only
-- when its tables are actually present. The alternative, shipping the
-- two-branch body unconditionally, would silently delete custom-role support
-- from every database that does have migration 16.
do $mig$
declare
  v_custom_roles_branch text := '';
begin
  if to_regclass('public.user_custom_roles') is not null
     and to_regclass('public.custom_roles') is not null
     and to_regclass('public.custom_role_permissions') is not null then
    v_custom_roles_branch := '
    or exists (
      select 1
      from public.user_custom_roles ucr
      join public.custom_roles cr on cr.id = ucr.custom_role_id
      join public.custom_role_permissions crp on crp.custom_role_id = cr.id
      where ucr.user_id = _user_id
        and cr.is_active = true
        and crp.permission_code = _code
    )';
  end if;

  execute format($fn$
create or replace function public.has_permission(_user_id uuid, _code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $body$
  select exists (
    select 1 from public.profiles p
     where p.id = _user_id and p.is_active
  ) and coalesce(
    public.has_role(_user_id, 'admin')
    or exists (
      select 1
      from public.user_roles ur
      join public.role_permissions rp on rp.role = ur.role
      where ur.user_id = _user_id
        and rp.permission_code = _code
    )%s,
    false
  )
$body$;
$fn$, v_custom_roles_branch);
end
$mig$;

revoke all on function public.has_role(uuid, public.app_role) from public, anon;
grant execute on function public.has_role(uuid, public.app_role) to authenticated, service_role;
revoke all on function public.is_staff(uuid) from public, anon;
grant execute on function public.is_staff(uuid) to authenticated, service_role;
revoke all on function public.has_permission(uuid, text) from public, anon;
grant execute on function public.has_permission(uuid, text) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- ٥. يمنع استعادة العقد من إعادة تفعيل حساب أوقفته الإدارة عمداً.
--
-- `restore_contract` ended with an unconditional
-- `update public.profiles set is_active = true`, added for one reason only:
-- migration 21's trigger was one-way, so a restore had to undo it by hand.
-- Part ١ above removes that reason — the trigger no longer touches the account
-- flag, and step 5 of this function already restores tenant_portal_enabled.
--
-- Left in place it would become a live bug: restoring any contract would
-- silently re-activate an account an admin deliberately deactivated, and
-- desync it from `banned_until`, so the Users table would read "active" while
-- GoTrue still refused the login.
--
-- The body below is migration 114's, copied verbatim with that one statement
-- deleted and nothing else touched. 114 is the live definition — migration 87
-- declares the same signature, so re-issuing 87's older body here would revert
-- the multi-unit closeout logic.
-- ---------------------------------------------------------------------------
create or replace function public.restore_contract(
  p_contract_id uuid,
  p_target_state text,
  p_restore_tenant boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $restore$
declare
  v_contract public.contracts%rowtype;
  v_actor uuid := auth.uid();
  v_unit_status public.unit_status;
  v_result jsonb;
  v_holder uuid;
  v_holder_unit uuid;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(v_actor, 'contracts.restore') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if nullif(trim(p_reason), '') is null then
    raise exception 'A restore reason is required';
  end if;

  if p_target_state is null
     or p_target_state not in (
       'draft', 'active', 'frozen', 'suspended', 'expired', 'terminated', 'renewed'
     )
  then
    raise exception 'Invalid p_target_state: %', p_target_state;
  end if;

  -- Same lock order as close-out: contracts → tenants; no units lock.
  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
   for update;
  if not found then
    raise exception 'Contract not found';
  end if;

  perform 1 from public.tenants t where t.id = v_contract.tenant_id for update;

  -- 1. Nothing to restore
  if v_contract.archived_at is null then
    raise exception 'Contract is not archived';
  end if;

  -- 3. Another live contract holding one of this contract's units → readable
  -- error (not raw 23505). Fans out over every unit on this contract, not
  -- just the one legacy single-unit column used to name, and names the first
  -- conflicting unit.
  select c2.id, cu2.unit_id into v_holder, v_holder_unit
    from public.contract_units cu
    join public.contract_units cu2 on cu2.unit_id = cu.unit_id
    join public.contracts c2 on c2.id = cu2.contract_id
   where cu.contract_id = p_contract_id
     and c2.id <> p_contract_id
     and c2.archived_at is null
     and c2.state in ('draft', 'active', 'frozen', 'suspended')
   order by cu2.unit_id
   limit 1;
  if v_holder is not null then
    raise exception 'Cannot restore: another live contract (%) holds unit %',
      v_holder, v_holder_unit;
  end if;

  -- 4. One update: state + clear archived_at. Unit occupancy is derived by
  -- trg_contract_sync_unit_status — do not write public.units.
  -- 7. DO NOT regenerate invoices. Restoring visibility is not reactivating the lease.
  update public.contracts
     set state = p_target_state::public.contract_states,
         archived_at = null
   where id = p_contract_id;

  select c.* into v_contract from public.contracts c where c.id = p_contract_id;

  -- 5. Optional tenant restore
  if coalesce(p_restore_tenant, false) then
    update public.tenants
       set archived_at = null,
           tenant_portal_enabled = true
     where id = v_contract.tenant_id;
  end if;

  select u.status into v_unit_status
    from public.units u
    join public.contract_units cu on cu.unit_id = u.id
   where cu.contract_id = v_contract.id
   order by cu.line_order, cu.unit_id
   limit 1;

  v_result := jsonb_build_object(
    'contract_id', p_contract_id,
    'contract_code', v_contract.code,
    'contract_state', v_contract.state::text,
    'archived_at', v_contract.archived_at,
    'unit_id', (select cu.unit_id from public.contract_units cu
      where cu.contract_id = v_contract.id
        and (select count(*) from public.contract_units c2
               where c2.contract_id = v_contract.id) = 1),
    'unit_ids', (select coalesce(jsonb_agg(cu.unit_id order by cu.line_order), '[]'::jsonb)
                   from public.contract_units cu where cu.contract_id = v_contract.id),
    'unit_status', v_unit_status::text,
    'tenant_id', v_contract.tenant_id,
    'reason', trim(p_reason)
  );

  -- 8. Audit + operational event
  perform public.write_audit(
    'contract.restore',
    'contract',
    p_contract_id,
    null,
    v_result,
    'success',
    null
  );

  insert into public.contract_operational_events (
    contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    p_contract_id,
    v_contract.tenant_id,
    'restored',
    v_actor,
    v_result,
    trim(p_reason)
  );

  return v_result;
end;
$restore$;

comment on function public.restore_contract(uuid, text, boolean, text) is
  'Restores a closed-out contract. As of migration 142 it no longer writes profiles.is_active: the portal flag is restored in step 5, and the account flag is now an admin-owned kill switch.';

revoke all on function public.restore_contract(uuid, text, boolean, text) from public, anon;
grant execute on function public.restore_contract(uuid, text, boolean, text) to authenticated, service_role;

notify pgrst, 'reload schema';
