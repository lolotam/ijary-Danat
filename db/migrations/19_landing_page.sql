-- 19_landing_page.sql
-- Database schema for Danat Al Jahra landing page restructures.
-- Includes settings, section-toggles, media, commercial brand directory, carousel, and inquiries.
-- Idempotent. Safe to re-run.

------------------------------------------------------------------------
-- 1. Create Tables
------------------------------------------------------------------------

-- 1.1 Landing Media
create table if not exists public.landing_media (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  mime_type text not null,
  width integer,
  height integer,
  alt_ar text,
  alt_en text,
  caption_ar text,
  caption_en text,
  focal_x numeric(3,2) default 0.50,
  focal_y numeric(3,2) default 0.50,
  category text not null check (category in ('exterior', 'interior', 'shops', 'facilities', 'events', 'parking', 'logo')),
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 1.2 Landing Page Settings
create table if not exists public.landing_page_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  locale text not null check (locale in ('ar', 'en')),
  hero_title text not null,
  hero_subtitle text not null,
  hero_primary_cta_label text,
  hero_primary_cta_target text,
  hero_secondary_cta_label text,
  hero_secondary_cta_target text,
  hero_desktop_media_id uuid references public.landing_media(id) on delete set null,
  hero_mobile_media_id uuid references public.landing_media(id) on delete set null,
  hero_video_media_id uuid references public.landing_media(id) on delete set null,
  about_title text not null,
  about_body text not null,
  about_primary_media_id uuid references public.landing_media(id) on delete set null,
  about_secondary_media_id uuid references public.landing_media(id) on delete set null,
  leasing_title text not null,
  leasing_body text not null,
  is_published boolean not null default false,
  published_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint landing_page_settings_company_locale_unique unique (company_id, locale)
);

-- 1.3 Landing Page Sections Enablement/Theme
create table if not exists public.landing_page_sections (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  section_key text not null,
  enabled boolean not null default true,
  display_order integer not null default 0,
  theme text check (theme in ('dark', 'light', 'glass')),
  settings_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint landing_page_sections_company_key_unique unique (company_id, section_key)
);

-- 1.4 Commercial Brands Directory (Tenants)
create table if not exists public.commercial_brands (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  unit_id uuid references public.units(id) on delete set null,
  name_original text not null,
  name_ar text not null,
  name_en text not null,
  slug text not null,
  description_ar text,
  description_en text,
  category_id uuid references public.building_categories(id) on delete set null,
  logo_media_id uuid references public.landing_media(id) on delete set null,
  cover_media_id uuid references public.landing_media(id) on delete set null,
  phone text,
  website_url text,
  instagram_url text,
  opening_hours_json jsonb,
  is_featured boolean not null default false,
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commercial_brands_slug_unique unique (property_id, slug)
);

-- 1.5 Landing Carousel Slides
create table if not exists public.landing_carousel_slides (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  carousel_key text not null default 'main_midpoint',
  media_id uuid not null references public.landing_media(id) on delete cascade,
  mobile_media_id uuid references public.landing_media(id) on delete set null,
  title_ar text not null,
  title_en text not null,
  description_ar text,
  description_en text,
  cta_label_ar text,
  cta_label_en text,
  cta_url text,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 1.6 Leasing Inquiries
create table if not exists public.leasing_inquiries (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  company_name text,
  business_activity text,
  phone text not null,
  email text not null,
  preferred_size text,
  preferred_contact_method text,
  message text,
  locale text not null default 'ar' check (locale in ('ar', 'en')),
  status text not null default 'new' check (status in ('new', 'contacted', 'accepted', 'rejected')),
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

------------------------------------------------------------------------
-- 2. Indexes
------------------------------------------------------------------------
create index if not exists landing_media_category_idx on public.landing_media (category);
create index if not exists commercial_brands_property_idx on public.commercial_brands (property_id);
create index if not exists commercial_brands_category_idx on public.commercial_brands (category_id);
create index if not exists leasing_inquiries_company_idx on public.leasing_inquiries (company_id);
create index if not exists leasing_inquiries_status_idx on public.leasing_inquiries (status);

------------------------------------------------------------------------
-- 3. Triggers for updated_at
------------------------------------------------------------------------
drop trigger if exists set_updated_at on public.landing_media;
create trigger set_updated_at before update on public.landing_media
for each row execute function public.tg_set_updated_at();

drop trigger if exists set_updated_at on public.landing_page_settings;
create trigger set_updated_at before update on public.landing_page_settings
for each row execute function public.tg_set_updated_at();

drop trigger if exists set_updated_at on public.landing_page_sections;
create trigger set_updated_at before update on public.landing_page_sections
for each row execute function public.tg_set_updated_at();

drop trigger if exists set_updated_at on public.commercial_brands;
create trigger set_updated_at before update on public.commercial_brands
for each row execute function public.tg_set_updated_at();

drop trigger if exists set_updated_at on public.landing_carousel_slides;
create trigger set_updated_at before update on public.landing_carousel_slides
for each row execute function public.tg_set_updated_at();

drop trigger if exists set_updated_at on public.leasing_inquiries;
create trigger set_updated_at before update on public.leasing_inquiries
for each row execute function public.tg_set_updated_at();

------------------------------------------------------------------------
-- 4. Enable Row Level Security (RLS)
------------------------------------------------------------------------
alter table public.landing_media enable row level security;
alter table public.landing_page_settings enable row level security;
alter table public.landing_page_sections enable row level security;
alter table public.commercial_brands enable row level security;
alter table public.landing_carousel_slides enable row level security;
alter table public.leasing_inquiries enable row level security;

------------------------------------------------------------------------
-- 5. Policies
------------------------------------------------------------------------

-- 5.1 Landing Media Policies
drop policy if exists "Allow public read of landing_media" on public.landing_media;
create policy "Allow public read of landing_media" on public.landing_media
  for select to public using (is_active = true or (auth.uid() is not null and public.is_staff(auth.uid())));

drop policy if exists "Allow staff write of landing_media" on public.landing_media;
create policy "Allow staff write of landing_media" on public.landing_media
  for all to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

-- 5.2 Landing Page Settings Policies
drop policy if exists "Allow public read of landing_page_settings" on public.landing_page_settings;
create policy "Allow public read of landing_page_settings" on public.landing_page_settings
  for select to public using (is_published = true or (auth.uid() is not null and public.is_staff(auth.uid())));

drop policy if exists "Allow staff write of landing_page_settings" on public.landing_page_settings;
create policy "Allow staff write of landing_page_settings" on public.landing_page_settings
  for all to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

-- 5.3 Landing Page Sections Policies
drop policy if exists "Allow public read of landing_page_sections" on public.landing_page_sections;
create policy "Allow public read of landing_page_sections" on public.landing_page_sections
  for select to public using (true);

drop policy if exists "Allow staff write of landing_page_sections" on public.landing_page_sections;
create policy "Allow staff write of landing_page_sections" on public.landing_page_sections
  for all to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

-- 5.4 Commercial Brands Policies
drop policy if exists "Allow public read of commercial_brands" on public.commercial_brands;
create policy "Allow public read of commercial_brands" on public.commercial_brands
  for select to public using (is_active = true or (auth.uid() is not null and public.is_staff(auth.uid())));

drop policy if exists "Allow staff write of commercial_brands" on public.commercial_brands;
create policy "Allow staff write of commercial_brands" on public.commercial_brands
  for all to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

-- 5.5 Landing Carousel Slides Policies
drop policy if exists "Allow public read of landing_carousel_slides" on public.landing_carousel_slides;
create policy "Allow public read of landing_carousel_slides" on public.landing_carousel_slides
  for select to public using (is_active = true or (auth.uid() is not null and public.is_staff(auth.uid())));

drop policy if exists "Allow staff write of landing_carousel_slides" on public.landing_carousel_slides;
create policy "Allow staff write of landing_carousel_slides" on public.landing_carousel_slides
  for all to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

-- 5.6 Leasing Inquiries Policies
drop policy if exists "Allow public insert of leasing_inquiries" on public.leasing_inquiries;
create policy "Allow public insert of leasing_inquiries" on public.leasing_inquiries
  for insert to public with check (true);

drop policy if exists "Allow staff read of leasing_inquiries" on public.leasing_inquiries;
create policy "Allow staff read of leasing_inquiries" on public.leasing_inquiries
  for select to authenticated using (public.is_staff(auth.uid()));

drop policy if exists "Allow staff write of leasing_inquiries" on public.leasing_inquiries;
create policy "Allow staff write of leasing_inquiries" on public.leasing_inquiries
  for update to authenticated using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()));

drop policy if exists "Allow admins to delete leasing_inquiries" on public.leasing_inquiries;
create policy "Allow admins to delete leasing_inquiries" on public.leasing_inquiries
  for delete to authenticated using (public.has_role(auth.uid(), 'admin'));

-- 5.7 Service Role Policies
drop policy if exists "Allow service role all on landing_media" on public.landing_media;
create policy "Allow service role all on landing_media" on public.landing_media for all to service_role using (true) with check (true);

drop policy if exists "Allow service role all on landing_page_settings" on public.landing_page_settings;
create policy "Allow service role all on landing_page_settings" on public.landing_page_settings for all to service_role using (true) with check (true);

drop policy if exists "Allow service role all on landing_page_sections" on public.landing_page_sections;
create policy "Allow service role all on landing_page_sections" on public.landing_page_sections for all to service_role using (true) with check (true);

drop policy if exists "Allow service role all on commercial_brands" on public.commercial_brands;
create policy "Allow service role all on commercial_brands" on public.commercial_brands for all to service_role using (true) with check (true);

drop policy if exists "Allow service role all on landing_carousel_slides" on public.landing_carousel_slides;
create policy "Allow service role all on landing_carousel_slides" on public.landing_carousel_slides for all to service_role using (true) with check (true);

drop policy if exists "Allow service role all on leasing_inquiries" on public.leasing_inquiries;
create policy "Allow service role all on leasing_inquiries" on public.leasing_inquiries for all to service_role using (true) with check (true);

------------------------------------------------------------------------
-- 6. Grants
------------------------------------------------------------------------
grant select on public.landing_media to anon, authenticated;
grant select on public.landing_page_settings to anon, authenticated;
grant select on public.landing_page_sections to anon, authenticated;
grant select on public.commercial_brands to anon, authenticated;
grant select on public.landing_carousel_slides to anon, authenticated;
grant insert on public.leasing_inquiries to anon, authenticated;
grant select, update on public.leasing_inquiries to authenticated;

grant all on public.landing_media to service_role;
grant all on public.landing_page_settings to service_role;
grant all on public.landing_page_sections to service_role;
grant all on public.commercial_brands to service_role;
grant all on public.landing_carousel_slides to service_role;
grant all on public.leasing_inquiries to service_role;

------------------------------------------------------------------------
-- 7. Seeding & Mock Data
------------------------------------------------------------------------

-- 7.1 Seeding custom permissions for landing page management
insert into public.permissions (code, module, action, is_system)
values
  ('landing_page.read', 'landing_page', 'read', true),
  ('landing_page.update', 'landing_page', 'update', true),
  ('landing_page.leasing_read', 'landing_page', 'leasing_read', true),
  ('landing_page.leasing_update', 'landing_page', 'leasing_update', true)
on conflict (code) do nothing;

-- Grant permissions to admin role
insert into public.role_permissions (role, permission_code)
values
  ('admin'::public.app_role, 'landing_page.read'),
  ('admin'::public.app_role, 'landing_page.update'),
  ('admin'::public.app_role, 'landing_page.leasing_read'),
  ('admin'::public.app_role, 'landing_page.leasing_update')
on conflict (role, permission_code) do nothing;

-- 7.2 Seeding Property and Units (Danat Al Jahra)
insert into public.properties (code, name_ar, name_en, type, address_ar, address_en, area, description_ar, description_en, company_id)
select 'PROP-JAHRA', 'مجمع دانة الجهراء التجاري', 'Danat Al Jahra Commercial Complex', 'building_complex', 'شارع مرزوق المتعب، الجهراء، قطعة 2', 'Marzouq Al-Mutaib St, Jahra, Block 2', 8500.0, 'مجمع تجاري فاخر في قلب الجهراء يضم نخبة من المحلات والخدمات الرائدة.', 'A premium commercial complex in the heart of Jahra, hosting top-tier retail and dining venues.', id
from public.companies limit 1
on conflict (code) do nothing;

-- Seed units for commercial brands
insert into public.units (code, property_id, name, type, area, status, default_rent, description_en)
select
  'PROP-JAHRA-U' || lpad(v.idx::text, 2, '0'),
  (select id from public.properties where code = 'PROP-JAHRA'),
  v.name,
  'commercial'::public.unit_types,
  v.area,
  'occupied'::public.unit_status,
  v.rent,
  v.desc_en
from (values
  (1, 'G01', 120.0, 1500.0, 'Ground Floor Retail - Brand 1'),
  (2, 'G02', 80.0, 1100.0, 'Ground Floor Cafe - Brand 2'),
  (3, 'F01', 150.0, 1800.0, 'First Floor Wellness - Brand 3'),
  (4, 'F02', 110.0, 1300.0, 'First Floor Clinic - Brand 4'),
  (5, 'F03', 200.0, 2500.0, 'First Floor Gym - Brand 5')
) as v(idx, name, area, rent, desc_en)
on conflict (code) do nothing;

-- 7.3 Seeding Landing Media (Placeholder visuals)
insert into public.landing_media (id, storage_path, mime_type, category, alt_ar, alt_en, caption_ar, caption_en, display_order)
values
  ('a1b2c3d4-e5f6-7a8b-9c0d-111111111111', '/landing/hero.png', 'image/png', 'exterior', 'الواجهة الخارجية للمجمع', 'Main Exterior Facade', 'مجمع دانة الجهراء في وقت الغروب', 'Danat Al Jahra Commercial Complex at sunset', 1),
  ('a1b2c3d4-e5f6-7a8b-9c0d-222222222222', '/landing/feature.png', 'image/png', 'interior', 'الممر الداخلي للمجمع', 'Interior Walkway', 'تصاميم داخلية عصرية ومساحات واسعة', 'Modern interior design with spacious corridors', 2),
  ('a1b2c3d4-e5f6-7a8b-9c0d-333333333333', 'https://images.unsplash.com/photo-1519642918688-7e43b19245d8?q=80&w=1200&auto=format&fit=crop', 'image/jpeg', 'interior', 'منطقة المطاعم والمقاهي', 'Food Court Area', 'جلسات خارجية وداخلية مريحة في منطقة المقاهي', 'Comfortable seating area in the restaurant section', 3),
  ('a1b2c3d4-e5f6-7a8b-9c0d-444444444444', 'https://images.unsplash.com/photo-1540555700478-4be289fbecef?q=80&w=1200&auto=format&fit=crop', 'image/jpeg', 'facilities', 'النادي الصحي الفاخر', 'Luxury Fitness Center', 'معدات متكاملة بأعلى المعايير العالمية', 'Top tier fitness equipment and wellness zone', 4),
  ('a1b2c3d4-e5f6-7a8b-9c0d-555555555555', 'https://images.unsplash.com/photo-1582213782179-e0d53f98f2ca?q=80&w=1200&auto=format&fit=crop', 'image/jpeg', 'parking', 'مواقف سيارات المجمع واسعة وسهلة الاستخدام', 'Ample Parking Spaces', 'مواقف فسيحة تتسع لأكثر من 500 سيارة', 'Spacious parking lot accommodating over 500 cars', 5),
  -- Brand logos placeholders
  ('b1111111-1111-1111-1111-111111111111', 'https://images.unsplash.com/photo-1554469384-e58fac16e23a?w=200&h=200&fit=crop&q=80', 'image/jpeg', 'logo', 'شعار كافيه أرابيكا', 'Arabica Coffee Logo', null, null, 1),
  ('b2222222-2222-2222-2222-222222222222', 'https://images.unsplash.com/photo-1509281373149-e957c6296406?w=200&h=200&fit=crop&q=80', 'image/jpeg', 'logo', 'شعار مطعم غوستو', 'Gusto Restaurant Logo', null, null, 2),
  ('b3333333-3333-3333-3333-333333333333', 'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?w=200&h=200&fit=crop&q=80', 'image/jpeg', 'logo', 'شعار صالون جلامور', 'Glamour Salon Logo', null, null, 3),
  ('b4444444-4444-4444-4444-444444444444', 'https://images.unsplash.com/photo-1526253038957-bce54e05968e?w=200&h=200&fit=crop&q=80', 'image/jpeg', 'logo', 'شعار صيدلية بوتس', 'Boots Pharmacy Logo', null, null, 4),
  ('b5555555-5555-5555-5555-555555555555', 'https://images.unsplash.com/photo-1517838277536-f5f99be501cd?w=200&h=200&fit=crop&q=80', 'image/jpeg', 'logo', 'شعار أوكسجين جيم', 'Oxygen Gym Logo', null, null, 5)
on conflict (id) do nothing;

-- 7.4 Seeding Landing Page Settings
insert into public.landing_page_settings (
  company_id, locale, hero_title, hero_subtitle,
  hero_primary_cta_label, hero_primary_cta_target,
  hero_secondary_cta_label, hero_secondary_cta_target,
  hero_desktop_media_id, hero_mobile_media_id,
  about_title, about_body, about_primary_media_id, about_secondary_media_id,
  leasing_title, leasing_body, is_published, published_at
)
values
  -- Arabic Settings
  (
    (select id from public.companies limit 1),
    'ar',
    'دانة الجهراء',
    'وجهتك اليومية للتسوق والخدمات في قلب الجهراء. نجمع لك بين متعة التسوق وفخامة المرافق لتجربة متكاملة تناسب جميع أفراد العائلة.',
    'استكشف المحلات',
    '#shops',
    'احصل على الاتجاهات',
    '#location',
    'a1b2c3d4-e5f6-7a8b-9c0d-111111111111',
    'a1b2c3d4-e5f6-7a8b-9c0d-111111111111',
    'مفهوم معماري فريد بقلب الجهراء',
    'مجمع دانة الجهراء ليس مجرد مركز تسوق تقليدي، بل هو تجربة عصرية متكاملة تمتد على مساحات رحبة وبتصميم معماري يمزج الحداثة بالفخامة. يوفر المجمع لرواده خيارات تسوق متنوعة تلبي كافة احتياجاتهم اليومية من أرقى صالات الأزياء، العطور، صيدليات متكاملة، مراكز لياقة بدنية مجهزة بالكامل، ومزيج استثنائي من المطاعم والمقاهي ذات الجلسات الهادئة والمميزة.',
    'a1b2c3d4-e5f6-7a8b-9c0d-111111111111',
    'a1b2c3d4-e5f6-7a8b-9c0d-222222222222',
    'انقل علامتك التجارية إلى مستوى جديد',
    'انضم إلى نخبة من الماركات الناجحة في مجمع دانة الجهراء. نوفر مساحات تأجيرية مرنة ومصممة خصيصاً لتناسب احتياجات عملك ومشاريعك التجارية مع دعم تشغيلي متكامل وموقع حيوي يضمن توافداً مستمراً للزوار.',
    true,
    now()
  ),
  -- English Settings
  (
    (select id from public.companies limit 1),
    'en',
    'Danat Al Jahra',
    'Your everyday destination for shopping, dining, and premium services in the heart of Jahra. We curate the best local and international brands for an unparalleled lifestyle experience.',
    'Explore Shops',
    '#shops',
    'Get Directions',
    '#location',
    'a1b2c3d4-e5f6-7a8b-9c0d-111111111111',
    'a1b2c3d4-e5f6-7a8b-9c0d-111111111111',
    'A Unique Architectural Concept in Jahra',
    'Danat Al Jahra Commercial Complex is more than just a retail space; it is a modern lifestyle destination built with a magnificent structural design that combines luxury and utility. The complex provides visitors with dynamic options ranging from high-end retail fashion, premium fragrances, clinics, professional fitness centers, to a rich culinary scene with cozy coffee shops and vibrant restaurants.',
    'a1b2c3d4-e5f6-7a8b-9c0d-111111111111',
    'a1b2c3d4-e5f6-7a8b-9c0d-222222222222',
    'Bring Your Brand to a Thriving Hub',
    'Elevate your business by joining the successful list of tenants at Danat Al Jahra. We offer adaptable retail layouts, dedicated facilities management, and a highly active location that ensures steady visitor foot traffic all year round.',
    true,
    now()
  )
on conflict (company_id, locale) do nothing;

-- 7.5 Seeding Landing Page Sections (Enablement toggles)
insert into public.landing_page_sections (company_id, section_key, enabled, display_order, theme)
select (select id from public.companies limit 1), v.key, true, v.idx, v.theme
from (values
  (1, 'announcement',  'dark'),
  (2, 'header',        'glass'),
  (3, 'hero',          'dark'),
  (4, 'visitor_info',  'light'),
  (5, 'about',         'dark'),
  (6, 'brands_marquee','light'),
  (7, 'shop_explorer', 'dark'),
  (8, 'midpoint_hero', 'dark'),
  (9, 'facilities',    'dark'),
  (10,'gallery',       'dark'),
  (11,'location',      'dark'),
  (12,'leasing',       'dark'),
  (13,'contact',       'dark'),
  (14,'footer',        'dark')
) as v(idx, key, theme)
on conflict (company_id, section_key) do nothing;

-- 7.6 Seeding Commercial Brands (Tenants)
insert into public.commercial_brands (
  property_id, unit_id, name_original, name_ar, name_en, slug,
  description_ar, description_en, category_id, logo_media_id,
  phone, website_url, instagram_url, opening_hours_json, is_featured, display_order
)
values
  -- Brand 1: Arabica Coffee (Café)
  (
    (select id from public.properties where code = 'PROP-JAHRA'),
    (select id from public.units where code = 'PROP-JAHRA-U02'),
    'Arabica Coffee',
    'أرابيكا كافيه',
    'Arabica Coffee',
    'arabica-coffee',
    'قهوة مختصة محضرة بعناية فائقة وجلسات هادئة.',
    'Specialty coffee prepared with premium beans and cozy spaces.',
    (select id from public.building_categories where code = 'restaurants_cafes'),
    'b1111111-1111-1111-1111-111111111111',
    '+965 2200 1101',
    'https://arabica.coffee',
    'https://instagram.com/arabicacoffee_kuwait',
    '{"daily": "08:00 AM - 11:30 PM"}',
    true,
    1
  ),
  -- Brand 2: Gusto (Restaurant)
  (
    (select id from public.properties where code = 'PROP-JAHRA'),
    (select id from public.units where code = 'PROP-JAHRA-U01'),
    'Gusto Restaurant',
    'مطعم غوستو الإيطالي',
    'Gusto Italian Restaurant',
    'gusto-restaurant',
    'أشهى المأكولات الإيطالية والبيتزا المخبوزة في الفرن الحجري.',
    'Authentic Italian dishes and stone-oven pizzas.',
    (select id from public.building_categories where code = 'restaurants_cafes'),
    'b2222222-2222-2222-2222-222222222222',
    '+965 2200 1102',
    'https://gusto.com.kw',
    'https://instagram.com/gusto_kw',
    '{"daily": "12:00 PM - 11:00 PM"}',
    true,
    2
  ),
  -- Brand 3: Glamour Salon (Beauty)
  (
    (select id from public.properties where code = 'PROP-JAHRA'),
    (select id from public.units where code = 'PROP-JAHRA-U03'),
    'Glamour Salon',
    'صالون جلامور للسيدات',
    'Glamour Ladies Salon',
    'glamour-salon',
    'خدمات العناية بالشعر والبشرة الفاخرة بأحدث التقنيات.',
    'Premium hair care and skincare wellness salon services.',
    (select id from public.building_categories where code = 'retail_perfume_clothing_children'),
    'b3333333-3333-3333-3333-333333333333',
    '+965 2200 1103',
    null,
    'https://instagram.com/glamour_salon_kw',
    '{"daily": "10:00 AM - 08:30 PM"}',
    false,
    3
  ),
  -- Brand 4: Boots Pharmacy (Health)
  (
    (select id from public.properties where code = 'PROP-JAHRA'),
    (select id from public.units where code = 'PROP-JAHRA-U04'),
    'Boots Pharmacy',
    'صيدلية بوتس',
    'Boots Pharmacy',
    'boots-pharmacy',
    'جميع مستحضرات التجميل والأدوية والمكملات الغذائية الرائدة.',
    'Leading pharmaceutical products, skincare, and healthcare supplements.',
    (select id from public.building_categories where code = 'retail_perfume_clothing_children'),
    'b4444444-4444-4444-4444-444444444444',
    '+965 2200 1104',
    'https://boots.com',
    'https://instagram.com/boots_middleeast',
    '{"daily": "08:00 AM - 12:00 AM"}',
    true,
    4
  ),
  -- Brand 5: Oxygen Gym (Fitness)
  (
    (select id from public.properties where code = 'PROP-JAHRA'),
    (select id from public.units where code = 'PROP-JAHRA-U05'),
    'Oxygen Gym',
    'أوكسجين جيم',
    'Oxygen Gym',
    'oxygen-gym',
    'نادي لياقة بدنية للرجال بأحدث الأجهزة ومدربين محترفين.',
    'State of the art fitness gym for men with professional trainers.',
    (select id from public.building_categories where code = 'health_clubs'),
    'b5555555-5555-5555-5555-555555555555',
    '+965 2200 1105',
    'https://oxygengym.com',
    'https://instagram.com/oxygengym_kw',
    '{"daily": "24 Hours"}',
    true,
    5
  )
on conflict (property_id, slug) do nothing;

-- 7.7 Seeding Midpoint Carousel Slides
insert into public.landing_carousel_slides (
  company_id, media_id, title_ar, title_en, description_ar, description_en, cta_label_ar, cta_label_en, cta_url, display_order
)
values
  (
    (select id from public.companies limit 1),
    'a1b2c3d4-e5f6-7a8b-9c0d-111111111111',
    'وجهة عصرية في قلب المحافظة',
    'A Modern Landmark in the Heart of Jahra',
    'يوفر مجمع دانة الجهراء وصولاً سهلاً وموقعاً استراتيجياً متفرداً يربط زوارنا بالوجهات الرئيسية.',
    'Danat Al Jahra Complex offers seamless accessibility and an ideal location connecting visitors to main hubs.',
    'ابحث عنا على الخريطة',
    'Find Us on Map',
    '#location',
    1
  ),
  (
    (select id from public.companies limit 1),
    'a1b2c3d4-e5f6-7a8b-9c0d-222222222222',
    'خيارات تسوق وتناول طعام غير محدودة',
    'Diverse Dining & Retail Venues',
    'استمتع بأشهى المأكولات وأفضل المشروبات في المقاهي والمطاعم ذات الطراز المعماري الفخم.',
    'Indulge in global cuisines and rich coffee brands under premium modern architectures.',
    'استكشف دليل المحلات',
    'Explore Store Directory',
    '#shops',
    2
  ),
  (
    (select id from public.companies limit 1),
    'a1b2c3d4-e5f6-7a8b-9c0d-333333333333',
    'مرافق صحية وترفيهية بأعلى المعايير',
    'World-Class Health & Wellness Facilities',
    'يحتوي المجمع على صيدلية بوتس ونادي أوكسجين جيم وصالونات تجميل تقدم مستويات رعاية وتدريب عالمية.',
    'Featuring Boots pharmacy, Oxygen gym, and premium beauty salons with international care standards.',
    'اتصل بفريق التأجير',
    'Inquire About Leasing',
    '#leasing',
    3
  )
on conflict (id) do nothing;
