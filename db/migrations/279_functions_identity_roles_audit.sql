-- 279_functions_identity_roles_audit.sql
-- T033: function audit — role & permission helpers, audit log, profile/company guards.
-- Split from 279_functions_identity.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

------------------------------------------------------------
-- 1. Core role & permission helpers (company-scoped)
------------------------------------------------------------

/**
 * يتحقق من امتلاك المستخدم للدور المطلوب داخل الشركة الحالية للمستدعي.
 */
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id = _user_id
       and p.is_active
       and p.company_id = public.current_company_id()
  ) and exists (
    select 1
      from public.user_roles ur
     where ur.user_id = _user_id
       and ur.role = _role
       and ur.company_id = public.current_company_id()
  );
$$;

/**
 * يتحقق من أن المستخدم موظف نشط في الشركة الحالية للمستدعي.
 */
create or replace function public.is_staff(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id = _user_id
       and p.is_active
       and p.company_id = public.current_company_id()
  ) and exists (
    select 1
      from public.user_roles ur
     where ur.user_id = _user_id
       and ur.company_id = public.current_company_id()
       and ur.role in ('admin', 'accountant', 'collector', 'readonly')
  );
$$;

/**
 * يتحقق من امتلاك المستخدم للصلاحية المطلوبة ضمن الشركة الحالية عبر الأدوار القياسية أو المخصصة.
 */
create or replace function public.has_permission(_user_id uuid, _code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id = _user_id
       and p.is_active
       and p.company_id = public.current_company_id()
  ) and coalesce(
    public.has_role(_user_id, 'admin'::public.app_role)
    or exists (
      select 1
        from public.user_roles ur
        join public.role_permissions rp
          on rp.company_id = ur.company_id
         and rp.role = ur.role
       where ur.user_id = _user_id
         and ur.company_id = public.current_company_id()
         and rp.permission_code = _code
    )
    or exists (
      select 1
        from public.user_custom_roles ucr
        join public.custom_roles cr
          on cr.id = ucr.custom_role_id
         and cr.company_id = ucr.company_id
        join public.custom_role_permissions crp
          on crp.custom_role_id = cr.id
         and crp.company_id = cr.company_id
       where ucr.user_id = _user_id
         and ucr.company_id = public.current_company_id()
         and cr.is_active = true
         and crp.permission_code = _code
    ),
    false
  );
$$;

------------------------------------------------------------
-- 2. Audit log & profile/company triggers
------------------------------------------------------------

/**
 * يوثّق حدثاً في سجل التدقيق مع اشتقاق الشركة والفاعل وبيانات الطلب بشكل آمن.
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
  v_company_id uuid := public.current_company_id();
  v_actor_label text;
  v_role text;
  v_id uuid;
  v_cand text;
begin
  if v_actor_id is null
     and coalesce(v_claims ->> 'sub', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  then
    v_actor_id := (v_claims ->> 'sub')::uuid;
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

  if v_actor_id is not null then
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

/**
 * يمنع المستخدم غير المخوّل من تعديل حقول الربط والتعطيل في ملفه الشخصي.
 */
create or replace function public.guard_profile_self_update()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() = old.id and not public.has_permission(auth.uid(), 'users.update') then
    new.tenant_id  := old.tenant_id;
    new.company_id := old.company_id;
    new.is_active  := old.is_active;
  end if;
  return new;
end;
$$;

/**
 * يتحقق من صلاحية `settings.backup` قبل تعديل إعدادات النسخ الاحتياطي للشركة.
 */
create or replace function public.companies_backup_settings_protect()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if (new.backup_daily_enabled is distinct from old.backup_daily_enabled) or
     (new.backup_weekly_enabled is distinct from old.backup_weekly_enabled) then
    if auth.uid() is not null
       and not public.has_permission(auth.uid(), 'settings.backup') then
      raise exception 'Forbidden: missing permission settings.backup';
    end if;
  end if;
  return new;
end;
$$;
