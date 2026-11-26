-- 280_functions_identity_signin_option_lists.sql
-- T033: function audit — sign-in & conflict helpers, option lists.
-- Split from 279_functions_identity.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

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
  v_company_id uuid := public.current_company_id_strict();
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
  v_company_id uuid := public.current_company_id_strict();
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
