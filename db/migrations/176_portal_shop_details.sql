-- 176_portal_shop_details.sql
--
-- Shop Details tab in tenant portal: a tenant edits their own storefront.
--
-- `commercial_brands` is rendered on the PUBLIC landing page. After this
-- change it holds tenant-authored content whose URL fields are written
-- straight into anchor hrefs (src/routes/index.tsx ~1826). The validation
-- and the whitelist below are not optional: column-level GRANTs cannot
-- separate tenants from staff because both are `authenticated`.
--
-- 1. Portal tab plumbing: permission + role grants + per-tenant override column.
-- 2. Two SECURITY DEFINER RPCs that share one ownership rule:
--      - every contract linked to the brand must belong to the caller tenant;
--      - a brand with no links is owned by no tenant;
--      - a brand linked to two different tenants is owned by neither.
--
-- Idempotent.

-- ======================================================================
-- 1a. Permission and per-tenant override
-- ======================================================================

insert into public.permissions (code, module, action, description_ar, description_en, is_system)
values (
  'portal.tab_shop',
  'portal',
  'tab_shop',
  'بوابة المستأجر: تبويب متجري',
  'Tenant portal: Shop Details tab',
  true
)
on conflict (code) do nothing;

-- Explicit single-code grants. Migration 46 used a wildcard
-- `where p.module = ''portal'' and p.action like ''tab\_%''' which would
-- grant EVERY portal tab. Do not reuse that pattern here.
insert into public.role_permissions (role, permission_code)
values
  ('tenant'::public.app_role, 'portal.tab_shop'),
  ('admin'::public.app_role, 'portal.tab_shop')
on conflict (role, permission_code) do nothing;

alter table public.tenants
  add column if not exists portal_tab_shop boolean;

comment on column public.tenants.portal_tab_shop is
  'Portal tab override: null = follow tenant role permission, true = force show, false = force hide.';

-- ======================================================================
-- Helpers: ownership and validation
-- ======================================================================

-- Resolve tenant_id for the caller strictly via profiles.tenant_id.
-- Returns null when caller is not a tenant-linked user.
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
   limit 1
$$;

-- True when every contract linked to the brand belongs to p_tenant_id.
-- Also requires at least one link — a brand with no links belongs to no tenant.
create or replace function public._shop_brand_owned_by_tenant(
  p_brand_id uuid,
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (select 1 from public.commercial_brand_contracts c where c.brand_id = p_brand_id)
    and not exists (
      select 1
        from public.commercial_brand_contracts c
        join public.contracts ct on ct.id = c.contract_id
       where c.brand_id = p_brand_id
         and ct.tenant_id is distinct from p_tenant_id
    )
$$;

-- Validate that url is empty/null or a http/https URL within length.
create or replace function public._shop_assert_valid_url(
  p_url text,
  p_field text,
  p_max_len integer
)
returns text
language plpgsql
immutable
as $$
declare
  v text := nullif(btrim(coalesce(p_url, '')), '');
begin
  if v is null then return null; end if;
  if char_length(v) > p_max_len then
    raise exception '% exceeds % characters', p_field, p_max_len;
  end if;
  if v !~* '^https?://' then
    raise exception '% must start with http:// or https://', p_field;
  end if;
  -- Reject control chars and javascript: hidden behind whitespace/case handled above.
  if v ~ '[\x00-\x1F\x7F]' then
    raise exception '% contains invalid characters', p_field;
  end if;
  return v;
end;
$$;

-- ======================================================================
-- 1b. Owner-scoped READ rpc
-- ======================================================================

-- يقرأ تفاصيل متجر المستأجر الحالي — يعمل حتى وإن كان المحل معطّلاً.
create or replace function public.shop_details_for_tenant(
  p_contract_id uuid default null
)
returns table (
  id uuid,
  name_original text,
  name_ar text,
  name_en text,
  phone text,
  opening_hours text,
  website_url text,
  instagram_url text,
  description_ar text,
  description_en text,
  logo_media_id uuid,
  cover_media_id uuid,
  logo_url text,
  cover_url text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public._shop_caller_tenant();
  v_contract_tenant uuid;
begin
  if v_tenant_id is null then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if p_contract_id is not null then
    select ct.tenant_id into v_contract_tenant
      from public.contracts ct where ct.id = p_contract_id;
    if v_contract_tenant is null or v_contract_tenant is distinct from v_tenant_id then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  end if;

  return query
  select
    b.id,
    b.name_original,
    b.name_ar,
    b.name_en,
    b.phone,
    (b.opening_hours_json ->> 'daily') as opening_hours,
    b.website_url,
    b.instagram_url,
    b.description_ar,
    b.description_en,
    b.logo_media_id,
    b.cover_media_id,
    lm_logo.storage_path as logo_url,
    lm_cover.storage_path as cover_url,
    b.updated_at
  from public.commercial_brands b
  left join public.landing_media lm_logo on lm_logo.id = b.logo_media_id
  left join public.landing_media lm_cover on lm_cover.id = b.cover_media_id
  where public._shop_brand_owned_by_tenant(b.id, v_tenant_id)
    and (p_contract_id is null or exists (
      select 1 from public.commercial_brand_contracts c2
       where c2.brand_id = b.id and c2.contract_id = p_contract_id
    ))
  order by b.display_order, b.created_at;
end;
$$;

revoke execute on function public.shop_details_for_tenant(uuid) from public, anon;
grant execute on function public.shop_details_for_tenant(uuid) to authenticated, service_role;

-- ======================================================================
-- 1c. WHITELIST WRITE rpc — parameter list IS the whitelist
-- ======================================================================

-- يحفظ تفاصيل المتجر للمستأجر نفسه؛ القائمة البيضاء تحدد الأعمدة القابلة للكتابة.
create or replace function public.save_shop_details_as_tenant(
  p_brand_id uuid,
  p_name_original text,
  p_name_ar text,
  p_name_en text,
  p_phone text,
  p_opening_hours text,
  p_website_url text,
  p_instagram_url text,
  p_description_ar text,
  p_description_en text,
  p_logo_media_id uuid,
  p_cover_media_id uuid,
  p_expected_updated_at timestamptz
)
returns public.commercial_brands
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid := public._shop_caller_tenant();
  v_before jsonb;
  v_after jsonb;
  v_row public.commercial_brands%rowtype;
  v_name_original text := nullif(btrim(coalesce(p_name_original, '')), '');
  v_name_ar text := nullif(btrim(coalesce(p_name_ar, '')), '');
  v_name_en text := nullif(btrim(coalesce(p_name_en, '')), '');
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_opening_hours text := nullif(btrim(coalesce(p_opening_hours, '')), '');
  v_website_url text;
  v_instagram_url text;
  v_desc_ar text := nullif(btrim(coalesce(p_description_ar, '')), '');
  v_desc_en text := nullif(btrim(coalesce(p_description_en, '')), '');
  v_logo uuid := p_logo_media_id;
  v_cover uuid := p_cover_media_id;
begin
  if v_tenant_id is null then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if p_brand_id is null then
    raise exception 'Brand is required' using errcode = '42501';
  end if;

  select * into v_row from public.commercial_brands b where b.id = p_brand_id for update;
  if not found then
    raise exception 'Brand not found' using errcode = '42501';
  end if;

  -- Ownership: every linked contract must belong to caller tenant; no links => no owner.
  if not public._shop_brand_owned_by_tenant(p_brand_id, v_tenant_id) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if p_expected_updated_at is not null
     and v_row.updated_at is distinct from p_expected_updated_at then
    raise exception 'Conflict: shop was modified concurrently; refresh and retry'
      using errcode = '40001';
  end if;

  -- Required names
  if v_name_original is null or v_name_ar is null or v_name_en is null then
    raise exception 'name_original, name_ar and name_en are required';
  end if;

  -- Length checks
  if char_length(v_name_original) > 200 then raise exception 'name_original exceeds 200 characters'; end if;
  if char_length(v_name_ar) > 200 then raise exception 'name_ar exceeds 200 characters'; end if;
  if char_length(v_name_en) > 200 then raise exception 'name_en exceeds 200 characters'; end if;
  if v_phone is not null and char_length(v_phone) > 32 then raise exception 'phone exceeds 32 characters'; end if;
  if v_opening_hours is not null and char_length(v_opening_hours) > 100 then raise exception 'opening_hours exceeds 100 characters'; end if;
  if char_length(coalesce(v_desc_ar, '')) > 4000 then raise exception 'description_ar exceeds 4000 characters'; end if;
  if char_length(coalesce(v_desc_en, '')) > 4000 then raise exception 'description_en exceeds 4000 characters'; end if;

  -- URL validation (allow only http/https)
  v_website_url := public._shop_assert_valid_url(p_website_url, 'website_url', 2048);
  v_instagram_url := public._shop_assert_valid_url(p_instagram_url, 'instagram_url', 2048);

  -- Media existence check when not null (FK would reject but with less clear message)
  if v_logo is not null and not exists (select 1 from public.landing_media m where m.id = v_logo) then
    raise exception 'logo_media_id does not exist';
  end if;
  if v_cover is not null and not exists (select 1 from public.landing_media m where m.id = v_cover) then
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
         logo_media_id = v_logo,
         cover_media_id = v_cover
   where b.id = p_brand_id
  returning * into v_row;

  v_after := to_jsonb(v_row);

  perform public.write_audit(
    'shop.save',
    'commercial_brands',
    p_brand_id,
    v_before,
    v_after
  );

  return v_row;
end;
$$;

revoke execute on function public.save_shop_details_as_tenant(uuid, text, text, text, text, text, text, text, text, text, uuid, uuid, timestamptz) from public, anon;
grant execute on function public.save_shop_details_as_tenant(uuid, text, text, text, text, text, text, text, text, text, uuid, uuid, timestamptz) to authenticated, service_role;

-- Helper revokes: _shop_* helpers are not for direct client calls.
revoke execute on function public._shop_caller_tenant() from public, anon;
revoke execute on function public._shop_brand_owned_by_tenant(uuid, uuid) from public, anon;
-- The tenant media upload (`src/fns/uploadShopMedia.ts`) runs as the service
-- role and calls this helper rather than reimplementing the ownership rule in
-- TypeScript. One authorisation rule, one definition.
grant execute on function public._shop_brand_owned_by_tenant(uuid, uuid) to service_role;
revoke execute on function public._shop_assert_valid_url(text, text, integer) from public, anon;
