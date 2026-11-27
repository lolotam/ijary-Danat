-- 330_impersonation_sessions.sql (T177)
--
-- يضيف جدول جلسات الدعم الفني (`impersonation_sessions`) ويحدّث دالتي
-- `current_company_id()` و`write_audit()` لدعم جلسات انتحال الدعم الفني
-- مع تسجيل مشرف المنصة كفاعل في سجل التدقيق.
--
-- Per spec.md User Story 11, data-model.md (`impersonation_sessions`),
-- contracts/company-context.md, and research.md R17:
--   - `impersonation_sessions` records every super-admin support session with a
--     mandatory non-empty `reason` and a 60-minute default expiry (`expires_at`).
--   - RLS is forced; only `service_role` writes, and only verified platform
--     admins (`is_platform_admin()`) may read. Neither `authenticated` (non-admin)
--     nor `company_service` can read or write the table.
--   - `current_company_id()` resolves an `authenticated` JWT carrying an
--     `impersonation_session` claim ONLY when the session row is open
--     (`ended_at is null and expires_at > now()`), matches `target_user_id = v_uid`,
--     and the target user's active profile belongs to that session's company
--     (still subject to the active/suspended company check). Anything else fails
--     closed (`null`).
--   - `write_audit()` records the `impersonator` JWT claim as `actor_id` (with
--     `actor_label` from `platform_admins.full_name` and `role = 'platform_admin'`)
--     so company audit logs name the acting super admin.
--
-- Rollback:
--   Re-apply `public.current_company_id()` from `254_company_context.sql` and
--   `public.write_audit(...)` from `279_functions_identity_roles_audit.sql`,
--   then `drop table if exists public.impersonation_sessions;`.

------------------------------------------------------------
-- 1. impersonation_sessions table & RLS
------------------------------------------------------------

create table if not exists public.impersonation_sessions (
  id                uuid primary key default gen_random_uuid(),
  platform_admin_id uuid not null references public.platform_admins(user_id) on delete restrict,
  company_id        uuid not null references public.companies(id) on delete cascade,
  target_user_id    uuid not null references auth.users(id) on delete cascade,
  reason            text not null check (nullif(btrim(reason), '') is not null),
  started_at        timestamptz not null default now(),
  expires_at        timestamptz not null default (now() + interval '60 minutes'),
  ended_at          timestamptz,
  check (expires_at > started_at)
);

create index if not exists impersonation_sessions_company_started_idx
  on public.impersonation_sessions (company_id, started_at desc);

create index if not exists impersonation_sessions_admin_started_idx
  on public.impersonation_sessions (platform_admin_id, started_at desc);

revoke all on public.impersonation_sessions
  from public, anon, authenticated, company_service, service_role;
grant select on public.impersonation_sessions to authenticated;
grant all on public.impersonation_sessions to service_role;

alter table public.impersonation_sessions enable row level security;
alter table public.impersonation_sessions force row level security;

drop policy if exists impersonation_sessions_select_admin on public.impersonation_sessions;
create policy impersonation_sessions_select_admin on public.impersonation_sessions
  for select to authenticated
  using ((select public.is_platform_admin()));

drop policy if exists impersonation_sessions_service_role_all on public.impersonation_sessions;
create policy impersonation_sessions_service_role_all on public.impersonation_sessions
  for all to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 2. current_company_id() with support-session resolution
------------------------------------------------------------

/**
 * يُعيد معرّف الشركة النشطة للمستدعي الحالي أو null عند عدم التحقق أو الإيقاف.
 *
 * Reads `request.jwt.claims` (supported in both Postgres 15 test-db and Postgres 17
 * PostgREST) and checks the active Postgres role GUC first so an `authenticated`
 * caller can never spoof `company_service` or `allow_suspended` claims.
 * When `impersonation_session` is present on an `authenticated` token, resolves
 * the company only if the session is open, unexpired, and targets an active
 * profile of `v_uid` in that same company; anything else fails closed (`null`).
 * Returns null for suspended companies unless `company_service` carries `allow_suspended = true`.
 */
create or replace function public.current_company_id()
returns uuid
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_claims jsonb := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
  v_role text := coalesce(
    nullif(nullif(current_setting('role', true), 'none'), ''),
    nullif(v_claims ->> 'role', ''),
    auth.role()
  );
  v_uid uuid := auth.uid();
  v_claim_sub text := v_claims ->> 'sub';
  v_claim_company text := v_claims ->> 'company_id';
  v_claim_session text := nullif(btrim(coalesce(v_claims ->> 'impersonation_session', '')), '');
  v_company_id uuid;
  v_allow_suspended boolean := false;
  v_resolved_id uuid;
begin
  if v_role = 'company_service' then
    if coalesce(v_claim_company, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_company_id := v_claim_company::uuid;
    else
      return null;
    end if;

    if jsonb_typeof(v_claims -> 'allow_suspended') = 'boolean' then
      v_allow_suspended := (v_claims ->> 'allow_suspended')::boolean;
    end if;
  elsif v_role = 'authenticated' then
    if v_uid is null
       and coalesce(v_claim_sub, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      v_uid := v_claim_sub::uuid;
    end if;

    if v_uid is null then
      return null;
    end if;

    if v_claim_session is not null then
      if v_claim_session !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return null;
      end if;

      select s.company_id
        into v_company_id
        from public.impersonation_sessions s
        join public.profiles p
          on p.id = s.target_user_id
         and p.company_id = s.company_id
         and p.is_active
       where s.id = v_claim_session::uuid
         and s.target_user_id = v_uid
         and s.ended_at is null
         and s.expires_at > now();
    else
      select p.company_id
        into v_company_id
        from public.profiles p
       where p.id = v_uid
         and p.is_active;
    end if;
  else
    return null;
  end if;

  if v_company_id is null then
    return null;
  end if;

  select c.id
    into v_resolved_id
    from public.companies c
   where c.id = v_company_id
     and (c.status = 'active' or v_allow_suspended);

  return v_resolved_id;
end;
$$;

revoke execute on function public.current_company_id() from public, anon;
grant execute on function public.current_company_id() to authenticated, company_service, service_role;

------------------------------------------------------------
-- 3. write_audit() recording impersonator as actor
------------------------------------------------------------

/**
 * يوثّق حدثاً في سجل التدقيق مع اشتقاق الشركة والفاعل وبيانات الطلب بشكل آمن،
 * ويسجّل معرّف مشرف المنصة كفاعل عند وجود ادعاء `impersonator` في جلسة الدعم.
 *
 * `authenticated` and `company_service` always bind to `current_company_id()`.
 * Trusted `service_role`/superuser triggers may derive `company_id` from the
 * actor's profile, JSON payload, or target entity row when no request claim exists.
 */
create or replace function public.write_audit(
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb default null,
  p_after jsonb default null,
  p_result text default 'success',
  p_error_code text default null,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_claims jsonb := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
  v_headers jsonb := coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb,
    '{}'::jsonb
  );
  v_eff_role text := coalesce(
    nullif(nullif(current_setting('role', true), 'none'), ''),
    nullif(v_claims ->> 'role', ''),
    auth.role(),
    ''
  );
  v_trusted boolean := v_eff_role = 'service_role' or coalesce(v_claims ->> 'role', '') = 'service_role';
  v_actor_id uuid := auth.uid();
  v_impersonator_claim text := nullif(btrim(coalesce(v_claims ->> 'impersonator', '')), '');
  v_impersonator_id uuid;
  v_company_id uuid := public.current_company_id();
  v_actor_label text;
  v_role text;
  v_id uuid;
  v_cand text;
begin
  if v_actor_id is null
     and coalesce(v_claims ->> 'sub', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    v_actor_id := (v_claims ->> 'sub')::uuid;
  end if;

  if v_impersonator_claim is not null
     and v_impersonator_claim ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    v_impersonator_id := v_impersonator_claim::uuid;
    v_actor_id := v_impersonator_id;
  end if;

  if v_trusted and p_actor_id is not null then
    v_actor_id := p_actor_id;
  end if;

  if v_company_id is null and v_eff_role not in ('authenticated', 'company_service') then
    if v_actor_id is not null then
      select p.company_id into v_company_id from public.profiles p where p.id = v_actor_id;
    end if;

    if v_company_id is null then
      v_cand := coalesce(p_after ->> 'company_id', p_before ->> 'company_id');
      if coalesce(v_cand, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_company_id := v_cand::uuid;
      end if;
    end if;

    if v_company_id is null and p_entity_id is not null then
      case lower(coalesce(p_entity_type, ''))
        when 'company', 'companies' then v_company_id := p_entity_id;
        when 'invoice', 'invoices' then select company_id into v_company_id from public.invoices where id = p_entity_id;
        when 'payment', 'payments' then select company_id into v_company_id from public.payments where id = p_entity_id;
        when 'contract', 'contracts' then select company_id into v_company_id from public.contracts where id = p_entity_id;
        when 'deposit', 'deposits' then select company_id into v_company_id from public.deposits where id = p_entity_id;
        when 'refund', 'refunds' then select company_id into v_company_id from public.refunds where id = p_entity_id;
        when 'partial_payment', 'partial_payments' then select company_id into v_company_id from public.partial_payments where id = p_entity_id;
        when 'insurance_payment', 'insurance_payments' then select company_id into v_company_id from public.insurance_payments where id = p_entity_id;
        when 'contract_closeout', 'contract_closeouts' then select company_id into v_company_id from public.contract_closeouts where id = p_entity_id;
        when 'tenant', 'tenants' then select company_id into v_company_id from public.tenants where id = p_entity_id;
        when 'property', 'properties' then select company_id into v_company_id from public.properties where id = p_entity_id;
        when 'unit', 'units' then select company_id into v_company_id from public.units where id = p_entity_id;
        when 'commercial_brands' then select company_id into v_company_id from public.commercial_brands where id = p_entity_id;
        when 'option_list_item', 'option_list_items' then select company_id into v_company_id from public.option_list_items where id = p_entity_id;
        else null;
      end case;
    end if;
  end if;

  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED: write_audit requires company context'
      using errcode = '42501';
  end if;

  if v_impersonator_id is not null then
    select pa.full_name
      into v_actor_label
      from public.platform_admins pa
     where pa.user_id = v_impersonator_id;
    v_role := 'platform_admin';
  elsif v_actor_id is not null then
    select coalesce(p.username::text, p.display_name, p.email::text)
      into v_actor_label
      from public.profiles p
     where p.id = v_actor_id
       and p.company_id = v_company_id;

    select string_agg(ur.role::text, ',' order by ur.role::text)
      into v_role
      from public.user_roles ur
     where ur.user_id = v_actor_id
       and ur.company_id = v_company_id;
  end if;

  v_actor_label := coalesce(
    v_actor_label,
    v_claims -> 'user_metadata' ->> 'username',
    v_claims ->> 'email',
    case when v_actor_id is null then 'system' end
  );
  v_role := coalesce(
    v_role,
    case when v_trusted and p_actor_id is not null then null else v_claims ->> 'role' end,
    case when v_actor_id is null then 'system' end
  );

  insert into public.audit_logs (
    company_id, actor_id, actor_label, role, action, entity_type, entity_id,
    method, path, ip, user_agent, correlation_id,
    before, after, result, error_code
  ) values (
    v_company_id,
    v_actor_id,
    v_actor_label,
    v_role,
    p_action,
    p_entity_type,
    p_entity_id,
    coalesce(v_headers ->> 'x-http-method', v_headers ->> 'x-forwarded-method'),
    coalesce(
      case when v_trusted then nullif(trim(v_headers ->> 'x-danat-request-path'), '') end,
      v_headers ->> 'x-forwarded-uri',
      v_headers ->> 'x-original-url'
    ),
    coalesce(
      case when v_trusted then nullif(trim(v_headers ->> 'x-danat-client-ip'), '') end,
      nullif(trim(split_part(coalesce(v_headers ->> 'x-forwarded-for', v_headers ->> 'cf-connecting-ip', ''), ',', 1)), '')
    ),
    v_headers ->> 'user-agent',
    coalesce(v_headers ->> 'x-request-id', v_headers ->> 'x-correlation-id'),
    p_before,
    p_after,
    p_result,
    p_error_code
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.write_audit(text, text, uuid, jsonb, jsonb, text, text, uuid) from public, anon;
grant execute on function public.write_audit(text, text, uuid, jsonb, jsonb, text, text, uuid) to authenticated, company_service, service_role;
