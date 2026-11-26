-- 279_functions_identity.sql
-- T033: Function audit for identity, permissions, audit, sign-in, lists,
-- companies backup guard, tenant lifecycle, unit status, and shop/brand helpers.
-- Every SECURITY DEFINER function scopes by `public.current_company_id()` or
-- moves to `SECURITY INVOKER` where caller RLS suffices.
-- Idempotent.

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

------------------------------------------------------------
-- 3. Sign-in & conflict helpers (company-scoped)
------------------------------------------------------------

/**
 * يبحث عن الحسابات المطابقة لآخر 8 أرقام هاتف داخل الشركة الحالية فقط.
 */
create or replace function public.find_profiles_by_phone_digits(_digits text)
returns table(id uuid, email text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.email::text
    from public.profiles p
    left join public.tenants t
      on t.id = p.tenant_id
     and t.company_id = p.company_id
   where p.company_id = public.current_company_id()
     and (
       (
         p.phone is not null
         and length(regexp_replace(p.phone, '\D', '', 'g')) >= 8
         and right(regexp_replace(p.phone, '\D', '', 'g'), 8) = right(_digits, 8)
       )
       or (
         t.mobile is not null
         and length(regexp_replace(t.mobile, '\D', '', 'g')) >= 8
         and right(regexp_replace(t.mobile, '\D', '', 'g'), 8) = right(_digits, 8)
       )
     )
   limit 2;
$$;

/**
 * يتحقق من تعارض أرقام الهواتف في الملفات الشخصية والمستأجرين داخل الشركة الحالية فقط.
 */
create or replace function public.find_phone_conflicts(
  _digits text,
  _exclude_profile uuid,
  _exclude_tenant uuid
)
returns table(kind text, id uuid, label text)
language sql
stable
security definer
set search_path = public
as $$
  select 'profile'::text,
         p.id,
         coalesce(p.display_name, p.username::text, p.email::text)
    from public.profiles p
    left join public.tenants t
      on t.id = p.tenant_id
     and t.company_id = p.company_id
   where p.company_id = public.current_company_id()
     and (_exclude_profile is null or p.id <> _exclude_profile)
     and (
       (
         p.phone is not null
         and length(regexp_replace(p.phone, '\D', '', 'g')) >= 8
         and right(regexp_replace(p.phone, '\D', '', 'g'), 8) = right(_digits, 8)
       )
       or (
         t.mobile is not null
         and length(regexp_replace(t.mobile, '\D', '', 'g')) >= 8
         and right(regexp_replace(t.mobile, '\D', '', 'g'), 8) = right(_digits, 8)
       )
     )
  union all
  select 'tenant'::text, t.id, t.name
    from public.tenants t
   where t.company_id = public.current_company_id()
     and t.mobile is not null
     and length(regexp_replace(t.mobile, '\D', '', 'g')) >= 8
     and right(regexp_replace(t.mobile, '\D', '', 'g'), 8) = right(_digits, 8)
     and not exists (
       select 1 from public.profiles p
        where p.company_id = t.company_id
          and p.tenant_id = t.id
     )
     and (_exclude_tenant is null or t.id <> _exclude_tenant)
   limit 10;
$$;

/**
 * يسجّل محاولة تسجيل دخول فاشلة ضمن نطاق الشركة الحالية ويطبّق حد الإبطاء الزمني.
 */
create or replace function public.record_failed_login(
  p_identifier text,
  p_account_id uuid,
  p_error_code text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_client_ip text := coalesce(current_setting('request.headers', true)::jsonb ->> 'x-danat-client-ip', '');
  v_window timestamptz := date_trunc('hour', now()) + (floor(extract(minute from now()) / 15) * interval '15 minutes');
  v_identifier_key text := lower(trim(p_identifier));
  v_count integer;
  v_ip_count integer;
begin
  if v_company_id is null and p_account_id is not null
     and coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '') not in ('authenticated', 'company_service') then
    select p.company_id into v_company_id from public.profiles p where p.id = p_account_id;
  end if;

  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED: record_failed_login requires company context'
      using errcode = '42501';
  end if;

  insert into public.failed_login_attempts (
    company_id, scope, identifier_key, client_ip, window_start, attempts, first_at, last_at
  ) values (v_company_id, 'client_ip', '', v_client_ip, v_window, 1, now(), now())
  on conflict (company_id, scope, identifier_key, client_ip, window_start)
  do update set attempts = failed_login_attempts.attempts + 1, last_at = now()
  returning attempts into v_ip_count;

  if v_ip_count > 25 then
    if public.failed_login_is_milestone(v_ip_count) then
      perform public.write_audit(
        p_action := 'auth.login.throttled',
        p_entity_type := 'user',
        p_entity_id := null,
        p_before := null,
        p_after := jsonb_build_object(
          'company_id', v_company_id,
          'scope', 'client_ip',
          'attempts', v_ip_count,
          'window_start', v_window
        ),
        p_result := 'failure',
        p_error_code := p_error_code
      );
    end if;
  else
    insert into public.failed_login_attempts (
      company_id, scope, identifier_key, client_ip, window_start, attempts, first_at, last_at
    ) values (v_company_id, 'identifier', v_identifier_key, v_client_ip, v_window, 1, now(), now())
    on conflict (company_id, scope, identifier_key, client_ip, window_start)
    do update set attempts = failed_login_attempts.attempts + 1, last_at = now()
    returning attempts into v_count;

    if v_count = 1 or v_count = 5 then
      perform public.write_audit(
        p_action := 'auth.login',
        p_entity_type := 'user',
        p_entity_id := p_account_id,
        p_before := null,
        p_after := jsonb_build_object('company_id', v_company_id, 'identifier', p_identifier),
        p_result := 'failure',
        p_error_code := p_error_code
      );
    elsif public.failed_login_is_milestone(v_count) then
      perform public.write_audit(
        p_action := 'auth.login.throttled',
        p_entity_type := 'user',
        p_entity_id := p_account_id,
        p_before := null,
        p_after := jsonb_build_object(
          'company_id', v_company_id,
          'scope', 'identifier',
          'identifier', p_identifier,
          'attempts', v_count,
          'window_start', v_window
        ),
        p_result := 'failure',
        p_error_code := p_error_code
      );
    end if;
  end if;

  delete from public.failed_login_attempts
   where company_id = v_company_id
     and window_start < now() - interval '24 hours';

  return coalesce(v_count, v_ip_count);
end;
$$;

------------------------------------------------------------
-- 4. Option lists (company-scoped)
------------------------------------------------------------

/**
 * يبذر عناصر القائمة الافتراضية لقائمة خيارات محددة داخل الشركة الحالية.
 */
create or replace function public._seed_option_items(_code text, _items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  _list_id uuid;
  _item jsonb;
begin
  if v_company_id is null then
    return;
  end if;

  select id into _list_id
    from public.option_lists
   where company_id = v_company_id
     and code = _code;
  if _list_id is null then return; end if;

  for _item in select * from jsonb_array_elements(_items) loop
    insert into public.option_list_items (
      company_id, list_id, value, label_ar, label_en, sort_order, is_system
    ) values (
      v_company_id,
      _list_id,
      _item ->> 'value',
      _item ->> 'label_ar',
      _item ->> 'label_en',
      coalesce((_item ->> 'sort_order')::int, 0),
      true
    )
    on conflict (company_id, list_id, value) do nothing;
  end loop;
end;
$$;

/**
 * يحسب استخدام قيمة عنصر قائمة خيارات داخل جداول الشركة الحالية فقط.
 */
create or replace function public.count_option_list_value_usage(p_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_item public.option_list_items%rowtype;
  v_code text;
  v_ref record;
  v_n integer;
  v_counts jsonb := '{}'::jsonb;
begin
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'settings.lists') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  select * into v_item
    from public.option_list_items
   where id = p_item_id
     and (v_company_id is null or company_id = v_company_id);
  if not found then raise exception 'Option list item not found' using errcode = 'P0002'; end if;

  v_company_id := coalesce(v_company_id, v_item.company_id);
  select code into v_code
    from public.option_lists
   where id = v_item.list_id
     and company_id = v_company_id;

  for v_ref in select * from public.option_list_value_references(v_code) loop
    execute format(
      'select count(*) from public.%I where company_id = $1 and %I = $2',
      v_ref.table_name,
      v_ref.column_name
    ) into v_n using v_company_id, v_item.value;
    v_counts := v_counts || jsonb_build_object(v_ref.table_name || '.' || v_ref.column_name, v_n);
  end loop;
  return v_counts;
end;
$$;

/**
 * يعيد تسمية قيمة عنصر قائمة خيارات ويحدّث المراجع المرتبطة داخل الشركة الحالية فقط.
 */
create or replace function public.rename_option_list_value(p_item_id uuid, p_new_value text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_item public.option_list_items%rowtype;
  v_code text;
  v_new text := btrim(coalesce(p_new_value, ''));
  v_ref record;
  v_n integer;
  v_counts jsonb := '{}'::jsonb;
begin
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'settings.lists') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_new = '' then raise exception 'Value is required' using errcode = '22023'; end if;

  select * into v_item
    from public.option_list_items
   where id = p_item_id
     and (v_company_id is null or company_id = v_company_id)
   for update;
  if not found then raise exception 'Option list item not found' using errcode = 'P0002'; end if;

  v_company_id := coalesce(v_company_id, v_item.company_id);
  select code into v_code
    from public.option_lists
   where id = v_item.list_id
     and company_id = v_company_id;

  if v_code in ('unit_statuses','contract_types','contract_states','payment_methods',
                'tenant_lifecycles','tenant_categories','manual_payment_reasons') then
    raise exception 'Values of this list cannot be renamed' using errcode = '22023';
  end if;
  if public.option_list_value_is_code_bound(v_code, v_item.value) then
    raise exception 'This value is bound to system rules and cannot be renamed' using errcode = '22023';
  end if;
  if v_item.value = v_new then return jsonb_build_object('updated', v_counts); end if;
  if exists (
    select 1 from public.option_list_items
     where company_id = v_company_id
       and list_id = v_item.list_id
       and value = v_new
  ) then
    raise exception 'Value already exists in this list' using errcode = '23505';
  end if;

  for v_ref in select * from public.option_list_value_references(v_code) loop
    execute format(
      'update public.%I set %I = $1 where company_id = $2 and %I = $3',
      v_ref.table_name,
      v_ref.column_name,
      v_ref.column_name
    ) using v_new, v_company_id, v_item.value;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object(v_ref.table_name || '.' || v_ref.column_name, v_n);
  end loop;

  perform set_config('app.option_value_rename', 'on', true);
  update public.option_list_items
     set value = v_new, updated_at = now()
   where id = p_item_id
     and company_id = v_company_id;

  perform public.write_audit(
    'option_list_item.rename_value', 'option_list_item', p_item_id,
    jsonb_build_object('company_id', v_company_id, 'value', v_item.value, 'list', v_code),
    jsonb_build_object('company_id', v_company_id, 'value', v_new, 'list', v_code, 'updated', v_counts)
  );
  return jsonb_build_object('updated', v_counts);
end;
$$;

------------------------------------------------------------
-- 5. Tenant lifecycle & unit status helpers (company-scoped)
------------------------------------------------------------

/**
 * يعطّل بوابة المستأجر عند عدم وجود عقد نشط له داخل الشركة.
 */
create or replace function public.deactivate_portal_users_without_active_contract()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _tenant uuid := coalesce(old.tenant_id, new.tenant_id);
  _company uuid := coalesce(public.current_company_id(), old.company_id, new.company_id);
begin
  if _tenant is not null and _company is not null and not exists (
    select 1 from public.contracts c
     where c.tenant_id = _tenant
       and c.company_id = _company
       and c.state = 'active'
  ) then
    update public.tenants
       set tenant_portal_enabled = false
     where id = _tenant
       and company_id = _company
       and tenant_portal_enabled;
  end if;
  return coalesce(new, old);
end;
$$;

/**
 * يحسب دورة حياة المستأجر من عقوده ضمن شركته.
 */
create or replace function public.compute_tenant_lifecycle(_tenant uuid, _current public.tenant_lifecycle)
returns public.tenant_lifecycle
language sql
stable
security definer
set search_path = public
as $$
  select case
    when _current = 'blocked' then 'blocked'::public.tenant_lifecycle
    when exists (
      select 1 from public.contracts c
       where c.tenant_id = _tenant
         and c.state = 'active'
         and (
           coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '') not in ('authenticated', 'company_service')
           or c.company_id = public.current_company_id()
         )
    ) then 'active'::public.tenant_lifecycle
    when exists (
      select 1 from public.contracts c
       where c.tenant_id = _tenant
         and c.state <> 'draft'
         and (
           coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '') not in ('authenticated', 'company_service')
           or c.company_id = public.current_company_id()
         )
    ) then 'contract_ended'::public.tenant_lifecycle
    else 'inactive'::public.tenant_lifecycle
  end;
$$;

/**
 * يزامن حالة دورة حياة المستأجر داخل شركته.
 */
create or replace function public.sync_tenant_lifecycle_for(_tenant uuid)
returns public.tenant_lifecycle
language plpgsql
security definer
set search_path = public
as $$
declare
  _company uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  _next public.tenant_lifecycle;
begin
  if _tenant is null then return null; end if;
  if v_eff_role in ('authenticated', 'company_service') and _company is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select public.compute_tenant_lifecycle(t.id, t.lifecycle)
    into _next
    from public.tenants t
   where t.id = _tenant
     and (_company is null or t.company_id = _company);
  if _next is null then return null; end if;

  update public.tenants
     set lifecycle = _next
   where id = _tenant
     and (_company is null or company_id = _company)
     and lifecycle is distinct from _next;
  return _next;
end;
$$;

/**
 * مشغّل يحدّث دورة حياة المستأجر عند تغيّر عقوده.
 */
create or replace function public.tg_contract_sync_tenant_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.tenant_id is distinct from old.tenant_id then
    perform public.sync_tenant_lifecycle_for(old.tenant_id);
  end if;
  if tg_op = 'DELETE' then
    perform public.sync_tenant_lifecycle_for(old.tenant_id);
  else
    perform public.sync_tenant_lifecycle_for(new.tenant_id);
  end if;
  return coalesce(new, old);
end;
$$;

/**
 * يضبط دورة الحياة الأولية عند إدراج مستأجر جديد.
 */
create or replace function public.tg_tenant_default_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.lifecycle := public.compute_tenant_lifecycle(new.id, new.lifecycle);
  return new;
end;
$$;

/**
 * يوحّد حقول الاسم التجاري للمستأجر قبل الحفظ.
 */
create or replace function public.tg_tenant_commercial_name_compat()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.commercial_name_ar is null and new.commercial_name_en is null
       and nullif(btrim(new.commercial_name), '') is not null then
      new.commercial_name_ar := btrim(new.commercial_name);
    end if;
  else
    if new.commercial_name is distinct from old.commercial_name
       and new.commercial_name_ar is not distinct from old.commercial_name_ar
       and new.commercial_name_en is not distinct from old.commercial_name_en then
      new.commercial_name_ar := nullif(btrim(new.commercial_name), '');
    end if;
  end if;
  new.commercial_name_ar := nullif(btrim(new.commercial_name_ar), '');
  new.commercial_name_en := nullif(btrim(new.commercial_name_en), '');
  new.commercial_name := coalesce(new.commercial_name_ar, new.commercial_name_en);
  return new;
end;
$$;

/**
 * يحظر أو يرفع الحظر عن مستأجر داخل الشركة الحالية.
 */
create or replace function public.set_tenant_blocked(_tenant uuid, _blocked boolean)
returns public.tenant_lifecycle
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  _next public.tenant_lifecycle;
begin
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'tenants.update') then
    raise exception 'Not authorized to change tenant lifecycle' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  if _blocked then
    update public.tenants
       set lifecycle = 'blocked'
     where id = _tenant
       and (v_company_id is null or company_id = v_company_id)
     returning lifecycle into _next;
    return _next;
  end if;

  update public.tenants
     set lifecycle = 'inactive'
   where id = _tenant
     and (v_company_id is null or company_id = v_company_id)
     and lifecycle = 'blocked';
  return public.sync_tenant_lifecycle_for(_tenant);
end;
$$;

/**
 * يتحقق مما إذا كانت الوحدة مرتبطة بعقد نشط غير مؤرشف ضمن شركتها.
 */
create or replace function public.unit_has_active_contract(_unit uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.contract_units cu
      join public.contracts c
        on c.id = cu.contract_id
       and c.company_id = cu.company_id
     where cu.unit_id = _unit
       and c.state = 'active'
       and c.archived_at is null
       and (
         coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '') not in ('authenticated', 'company_service')
         or cu.company_id = public.current_company_id()
       )
  );
$$;

/**
 * يحسب الحالة المشتقة للوحدة بناءً على عقودها النشطة.
 */
create or replace function public.compute_unit_status(_unit uuid, _current public.unit_status)
returns public.unit_status
language sql
stable
security invoker
set search_path = public
as $$
  select case
    when public.unit_has_active_contract(_unit) then 'occupied'::public.unit_status
    when _current in ('under_maintenance', 'archived') then _current
    else 'vacant'::public.unit_status
  end;
$$;

/**
 * يزامن حالة وحدة واحدة مع عقودها ضمن الشركة.
 */
create or replace function public.sync_unit_status_for(_unit uuid)
returns public.unit_status
language plpgsql
security definer
set search_path = public
as $$
declare
  _company uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  _current public.unit_status;
  _next public.unit_status;
begin
  if _unit is null then return null; end if;
  if v_eff_role in ('authenticated', 'company_service') and _company is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select status into _current
    from public.units
   where id = _unit
     and (_company is null or company_id = _company)
   for update;
  if not found then return null; end if;

  _next := public.compute_unit_status(_unit, _current);
  update public.units
     set status = _next
   where id = _unit
     and (_company is null or company_id = _company)
     and status is distinct from _next;
  return _next;
end;
$$;

/**
 * يزامن حالات مجموعة وحدات بترتيب ثابت لتفادي التوقف المتبادل.
 */
create or replace function public.sync_unit_status_many(_units uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _company uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  _unit uuid;
begin
  if v_eff_role in ('authenticated', 'company_service') and _company is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  for _unit in
    select distinct x from unnest(_units) as t(x) where x is not null order by 1
  loop
    perform 1 from public.units
     where id = _unit and (_company is null or company_id = _company)
     for update;
  end loop;
  for _unit in
    select distinct x from unnest(_units) as t(x) where x is not null order by 1
  loop
    perform public.sync_unit_status_for(_unit);
  end loop;
end;
$$;

/**
 * مشغّل يزامن حالات الوحدات عند تغيير حالة العقد أو أرشفته.
 */
create or replace function public.tg_contract_sync_unit_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _company uuid := coalesce(public.current_company_id(), new.company_id);
begin
  perform public.sync_unit_status_many(
    array(
      select cu.unit_id
        from public.contract_units cu
       where cu.contract_id = new.id
         and cu.company_id = _company
    )
  );
  return new;
end;
$$;

revoke execute on function public.tg_contract_sync_unit_status() from public, anon;

/**
 * يفرض اشتقاق حالة الوحدة تلقائياً قبل الحفظ.
 */
create or replace function public.tg_unit_enforce_derived_status()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.status in ('available', 'reserved') then
    new.status := 'vacant';
  end if;
  if public.unit_has_active_contract(new.id) then
    if new.status <> 'occupied' then
      raise exception
        'Unit % has an active contract, so its status is maintained automatically and stays occupied.',
        coalesce(new.code, new.id::text)
        using errcode = 'check_violation';
    end if;
  elsif new.status = 'occupied' then
    new.status := 'vacant';
  end if;
  return new;
end;
$$;

------------------------------------------------------------
-- 6. Commercial brands & tenant shop helpers (company-scoped)
------------------------------------------------------------

/**
 * يحفظ عقود العلامة التجارية ضمن الشركة الحالية فقط.
 */
create or replace function public.save_brand_contracts(p_brand_id uuid, p_contract_ids uuid[])
returns setof public.commercial_brand_contracts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
begin
  if v_eff_role = 'authenticated'
     and not public.has_permission(auth.uid(), 'landing_page.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select b.company_id into v_company_id
    from public.commercial_brands b
   where b.id = p_brand_id
     and (v_company_id is null or b.company_id = v_company_id);
  if v_company_id is null then
    raise exception 'Brand not found';
  end if;

  delete from public.commercial_brand_contracts cbc
   where cbc.brand_id = p_brand_id
     and cbc.company_id = v_company_id
     and not (cbc.contract_id = any(coalesce(p_contract_ids, '{}'::uuid[])));

  insert into public.commercial_brand_contracts (company_id, brand_id, contract_id)
  select v_company_id, p_brand_id, unnest(coalesce(p_contract_ids, '{}'::uuid[]))
  on conflict do nothing;

  return query
    select cbc.* from public.commercial_brand_contracts cbc
     where cbc.brand_id = p_brand_id
       and cbc.company_id = v_company_id
     order by cbc.contract_id;
end;
$$;

/**
 * يعيد معرّف المستأجر المرتبط بالمستخدم الحالي داخل الشركة الحالية.
 */
create or replace function public._shop_caller_tenant()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.tenant_id
    from public.profiles p
   where p.id = auth.uid()
     and p.is_active
     and p.company_id = public.current_company_id()
   limit 1;
$$;

/**
 * يتحقق من ملكية المستأجر للعلامة التجارية ضمن الشركة الحالية.
 */
create or replace function public._shop_brand_owned_by_tenant(p_brand_id uuid, p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.commercial_brand_contracts c
       where c.brand_id = p_brand_id
         and c.company_id = public.current_company_id()
    )
    and not exists (
      select 1
        from public.commercial_brand_contracts c
        join public.contracts ct
          on ct.id = c.contract_id
         and ct.company_id = c.company_id
       where c.brand_id = p_brand_id
         and c.company_id = public.current_company_id()
         and ct.tenant_id is distinct from p_tenant_id
    );
$$;

/**
 * يعرض بيانات المتاجر المملوكة للمستأجر الحالي ضمن الشركة الحالية.
 */
create or replace function public.shop_details_for_tenant(p_contract_id uuid default null)
returns table(
  id uuid, name_original text, name_ar text, name_en text, phone text,
  opening_hours text, website_url text, instagram_url text,
  description_ar text, description_en text, logo_media_id uuid,
  cover_media_id uuid, logo_url text, cover_url text, updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_tenant_id uuid := public._shop_caller_tenant();
  v_contract_tenant uuid;
begin
  if v_company_id is null or v_tenant_id is null then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if p_contract_id is not null then
    select ct.tenant_id into v_contract_tenant
      from public.contracts ct
     where ct.id = p_contract_id
       and ct.company_id = v_company_id;
    if v_contract_tenant is null or v_contract_tenant is distinct from v_tenant_id then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  end if;

  return query
  select
    b.id, b.name_original, b.name_ar, b.name_en, b.phone,
    (b.opening_hours_json ->> 'daily') as opening_hours,
    b.website_url, b.instagram_url, b.description_ar, b.description_en,
    b.logo_media_id, b.cover_media_id,
    lm_logo.storage_path as logo_url,
    lm_cover.storage_path as cover_url,
    b.updated_at
    from public.commercial_brands b
    left join public.landing_media lm_logo
      on lm_logo.id = b.logo_media_id and lm_logo.company_id = b.company_id
    left join public.landing_media lm_cover
      on lm_cover.id = b.cover_media_id and lm_cover.company_id = b.company_id
   where b.company_id = v_company_id
     and public._shop_brand_owned_by_tenant(b.id, v_tenant_id)
     and (p_contract_id is null or exists (
       select 1 from public.commercial_brand_contracts c2
        where c2.brand_id = b.id
          and c2.company_id = v_company_id
          and c2.contract_id = p_contract_id
     ))
   order by b.display_order, b.created_at;
end;
$$;

/**
 * يحفظ تفاصيل المتجر بواسطة المستأجر المالك داخل الشركة الحالية مع التدقيق.
 */
create or replace function public.save_shop_details_as_tenant(
  p_brand_id uuid, p_name_original text, p_name_ar text, p_name_en text,
  p_phone text, p_opening_hours text, p_website_url text, p_instagram_url text,
  p_description_ar text, p_description_en text, p_logo_media_id uuid,
  p_cover_media_id uuid, p_expected_updated_at timestamptz
)
returns public.commercial_brands
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_tenant_id uuid := public._shop_caller_tenant();
  v_row public.commercial_brands%rowtype;
  v_before jsonb;
  v_name_original text := nullif(btrim(coalesce(p_name_original, '')), '');
  v_name_ar text := nullif(btrim(coalesce(p_name_ar, '')), '');
  v_name_en text := nullif(btrim(coalesce(p_name_en, '')), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_opening_hours text := nullif(btrim(coalesce(p_opening_hours, '')), '');
  v_website_url text;
  v_instagram_url text;
  v_desc_ar text := nullif(btrim(coalesce(p_description_ar, '')), '');
  v_desc_en text := nullif(btrim(coalesce(p_description_en, '')), '');
begin
  if v_company_id is null or v_tenant_id is null then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if p_brand_id is null then
    raise exception 'Brand is required' using errcode = '42501';
  end if;

  select * into v_row
    from public.commercial_brands b
   where b.id = p_brand_id
     and b.company_id = v_company_id
   for update;
  if not found then
    raise exception 'Brand not found' using errcode = '42501';
  end if;

  if not public._shop_brand_owned_by_tenant(p_brand_id, v_tenant_id) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if p_expected_updated_at is not null and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'Conflict: shop was modified concurrently; refresh and retry' using errcode = '40001';
  end if;
  if v_name_original is null or v_name_ar is null or v_name_en is null then
    raise exception 'name_original, name_ar and name_en are required';
  end if;
  if char_length(v_name_original) > 200 then raise exception 'name_original exceeds 200 characters'; end if;
  if char_length(v_name_ar) > 200 then raise exception 'name_ar exceeds 200 characters'; end if;
  if char_length(v_name_en) > 200 then raise exception 'name_en exceeds 200 characters'; end if;
  if v_phone is not null and char_length(v_phone) > 32 then raise exception 'phone exceeds 32 characters'; end if;
  if v_opening_hours is not null and char_length(v_opening_hours) > 100 then raise exception 'opening_hours exceeds 100 characters'; end if;
  if char_length(coalesce(v_desc_ar, '')) > 4000 then raise exception 'description_ar exceeds 4000 characters'; end if;
  if char_length(coalesce(v_desc_en, '')) > 4000 then raise exception 'description_en exceeds 4000 characters'; end if;

  v_website_url := public._shop_assert_valid_url(p_website_url, 'website_url', 2048);
  v_instagram_url := public._shop_assert_valid_url(p_instagram_url, 'instagram_url', 2048);

  if p_logo_media_id is not null and not exists (
    select 1 from public.landing_media m where m.id = p_logo_media_id and m.company_id = v_company_id
  ) then
    raise exception 'logo_media_id does not exist';
  end if;
  if p_cover_media_id is not null and not exists (
    select 1 from public.landing_media m where m.id = p_cover_media_id and m.company_id = v_company_id
  ) then
    raise exception 'cover_media_id does not exist';
  end if;

  v_before := to_jsonb(v_row);

  update public.commercial_brands b
     set name_original = v_name_original,
         name_ar = v_name_ar,
         name_en = v_name_en,
         phone = v_phone,
         opening_hours_json = case when v_opening_hours is null then null else jsonb_build_object('daily', v_opening_hours) end,
         website_url = v_website_url,
         instagram_url = v_instagram_url,
         description_ar = v_desc_ar,
         description_en = v_desc_en,
         logo_media_id = p_logo_media_id,
         cover_media_id = p_cover_media_id
   where b.id = p_brand_id
     and b.company_id = v_company_id
  returning * into v_row;

  perform public.write_audit('shop.save', 'commercial_brands', p_brand_id, v_before, to_jsonb(v_row));
  return v_row;
end;
$$;
