-- 277_company_landing_columns.sql
-- T032 (part 1): Company isolation columns, composite FKs, per-company uniques,
-- and company-led indexes for the landing group (`landing_media`,
-- `landing_page_settings`, `landing_page_sections`, `landing_carousel_slides`,
-- `leasing_inquiries`).
-- Idempotent.

------------------------------------------------------------
-- 1. landing_media
------------------------------------------------------------

alter table public.landing_media
  add column if not exists company_id uuid references public.companies(id);

update public.landing_media
   set company_id = (select id from public.companies order by created_at asc limit 1)
 where company_id is null;

alter table public.landing_media
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'landing_media_company_id_id_key'
       and conrelid = 'public.landing_media'::regclass
  ) then
    alter table public.landing_media
      add constraint landing_media_company_id_id_key unique (company_id, id);
  end if;
end $$;

drop index if exists public.landing_media_category_idx;
drop index if exists public.landing_media_show_in_gallery_idx;

create index if not exists landing_media_company_category_idx
  on public.landing_media (company_id, category);
create index if not exists landing_media_company_gallery_idx
  on public.landing_media (company_id, show_in_gallery, display_order)
  where show_in_gallery = true and is_active = true;

------------------------------------------------------------
-- 2. landing_page_settings
------------------------------------------------------------

alter table public.landing_page_settings
  drop constraint if exists landing_page_settings_company_id_fkey;

alter table public.landing_page_settings
  add constraint landing_page_settings_company_id_fkey
  foreign key (company_id) references public.companies(id);

alter table public.landing_page_settings
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'landing_page_settings_company_id_id_key'
       and conrelid = 'public.landing_page_settings'::regclass
  ) then
    alter table public.landing_page_settings
      add constraint landing_page_settings_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.landing_page_settings
  drop constraint if exists landing_page_settings_about_primary_media_id_fkey,
  drop constraint if exists landing_page_settings_company_about_primary_media_fkey,
  drop constraint if exists landing_page_settings_about_secondary_media_id_fkey,
  drop constraint if exists landing_page_settings_company_about_secondary_media_fkey,
  drop constraint if exists landing_page_settings_hero_desktop_media_id_fkey,
  drop constraint if exists landing_page_settings_company_hero_desktop_media_fkey,
  drop constraint if exists landing_page_settings_hero_mobile_media_id_fkey,
  drop constraint if exists landing_page_settings_company_hero_mobile_media_fkey,
  drop constraint if exists landing_page_settings_hero_video_media_id_fkey,
  drop constraint if exists landing_page_settings_company_hero_video_media_fkey;

alter table public.landing_page_settings
  add constraint landing_page_settings_company_about_primary_media_fkey
    foreign key (company_id, about_primary_media_id)
    references public.landing_media(company_id, id)
    on delete set null (about_primary_media_id),
  add constraint landing_page_settings_company_about_secondary_media_fkey
    foreign key (company_id, about_secondary_media_id)
    references public.landing_media(company_id, id)
    on delete set null (about_secondary_media_id),
  add constraint landing_page_settings_company_hero_desktop_media_fkey
    foreign key (company_id, hero_desktop_media_id)
    references public.landing_media(company_id, id)
    on delete set null (hero_desktop_media_id),
  add constraint landing_page_settings_company_hero_mobile_media_fkey
    foreign key (company_id, hero_mobile_media_id)
    references public.landing_media(company_id, id)
    on delete set null (hero_mobile_media_id),
  add constraint landing_page_settings_company_hero_video_media_fkey
    foreign key (company_id, hero_video_media_id)
    references public.landing_media(company_id, id)
    on delete set null (hero_video_media_id);

------------------------------------------------------------
-- 3. landing_page_sections
------------------------------------------------------------

alter table public.landing_page_sections
  drop constraint if exists landing_page_sections_company_id_fkey;

alter table public.landing_page_sections
  add constraint landing_page_sections_company_id_fkey
  foreign key (company_id) references public.companies(id);

alter table public.landing_page_sections
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'landing_page_sections_company_id_id_key'
       and conrelid = 'public.landing_page_sections'::regclass
  ) then
    alter table public.landing_page_sections
      add constraint landing_page_sections_company_id_id_key unique (company_id, id);
  end if;
end $$;

------------------------------------------------------------
-- 4. landing_carousel_slides
------------------------------------------------------------

alter table public.landing_carousel_slides
  drop constraint if exists landing_carousel_slides_company_id_fkey;

alter table public.landing_carousel_slides
  add constraint landing_carousel_slides_company_id_fkey
  foreign key (company_id) references public.companies(id);

alter table public.landing_carousel_slides
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'landing_carousel_slides_company_id_id_key'
       and conrelid = 'public.landing_carousel_slides'::regclass
  ) then
    alter table public.landing_carousel_slides
      add constraint landing_carousel_slides_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.landing_carousel_slides
  drop constraint if exists landing_carousel_slides_media_id_fkey,
  drop constraint if exists landing_carousel_slides_company_media_fkey,
  drop constraint if exists landing_carousel_slides_mobile_media_id_fkey,
  drop constraint if exists landing_carousel_slides_company_mobile_media_fkey;

alter table public.landing_carousel_slides
  add constraint landing_carousel_slides_company_media_fkey
    foreign key (company_id, media_id)
    references public.landing_media(company_id, id)
    on delete cascade,
  add constraint landing_carousel_slides_company_mobile_media_fkey
    foreign key (company_id, mobile_media_id)
    references public.landing_media(company_id, id)
    on delete set null (mobile_media_id);

create index if not exists landing_carousel_slides_company_order_idx
  on public.landing_carousel_slides (company_id, display_order);

------------------------------------------------------------
-- 5. leasing_inquiries
------------------------------------------------------------

alter table public.leasing_inquiries
  drop constraint if exists leasing_inquiries_company_id_fkey;

alter table public.leasing_inquiries
  add constraint leasing_inquiries_company_id_fkey
  foreign key (company_id) references public.companies(id);

alter table public.leasing_inquiries
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'leasing_inquiries_company_id_id_key'
       and conrelid = 'public.leasing_inquiries'::regclass
  ) then
    alter table public.leasing_inquiries
      add constraint leasing_inquiries_company_id_id_key unique (company_id, id);
  end if;
end $$;

drop index if exists public.leasing_inquiries_company_idx;
drop index if exists public.leasing_inquiries_status_idx;
create index if not exists leasing_inquiries_company_status_idx
  on public.leasing_inquiries (company_id, status);

------------------------------------------------------------
-- 6. Deferred composite FKs from tenants / commercial_brands (261) -> landing_media
------------------------------------------------------------

alter table public.tenants
  drop constraint if exists tenants_avatar_media_id_fkey,
  drop constraint if exists tenants_company_avatar_media_fkey;

alter table public.tenants
  add constraint tenants_company_avatar_media_fkey
  foreign key (company_id, avatar_media_id)
  references public.landing_media(company_id, id)
  on delete set null (avatar_media_id);

alter table public.commercial_brands
  drop constraint if exists commercial_brands_logo_media_id_fkey,
  drop constraint if exists commercial_brands_company_logo_media_fkey,
  drop constraint if exists commercial_brands_cover_media_id_fkey,
  drop constraint if exists commercial_brands_company_cover_media_fkey;

alter table public.commercial_brands
  add constraint commercial_brands_company_logo_media_fkey
    foreign key (company_id, logo_media_id)
    references public.landing_media(company_id, id)
    on delete set null (logo_media_id),
  add constraint commercial_brands_company_cover_media_fkey
    foreign key (company_id, cover_media_id)
    references public.landing_media(company_id, id)
    on delete set null (cover_media_id);
