-- 282_functions_identity_brands_shops.sql
-- T033: function audit — commercial brands & tenant shop helpers.
-- Split from 279_functions_identity.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

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
  v_company_id uuid := public.current_company_id_strict();
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
