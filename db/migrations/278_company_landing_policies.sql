-- 278_company_landing_policies.sql
-- T032 (part 2): Forced RLS and hoisted company-scoped policies for
-- `landing_media`, `landing_page_settings`, `landing_page_sections`,
-- `landing_carousel_slides`, and `leasing_inquiries`.
-- Idempotent.

------------------------------------------------------------
-- 1. landing_media
------------------------------------------------------------

revoke all on public.landing_media from anon;
grant select, insert, update, delete on public.landing_media to company_service;

alter table public.landing_media enable row level security;
alter table public.landing_media force row level security;

drop policy if exists "Allow public read of landing_media" on public.landing_media;
drop policy if exists "Allow staff write of landing_media" on public.landing_media;
drop policy if exists landing_media_company_service_all on public.landing_media;

create policy "Allow public read of landing_media"
  on public.landing_media
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      is_active = true
      or (select public.has_permission((select auth.uid()), 'landing_page.read'))
    )
  );

create policy "Allow staff write of landing_media"
  on public.landing_media
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.update'))
  );

create policy landing_media_company_service_all on public.landing_media
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 2. landing_page_settings
------------------------------------------------------------

revoke all on public.landing_page_settings from anon;
grant select, insert, update, delete on public.landing_page_settings to company_service;

alter table public.landing_page_settings enable row level security;
alter table public.landing_page_settings force row level security;

drop policy if exists "Allow public read of landing_page_settings" on public.landing_page_settings;
drop policy if exists "Allow staff write of landing_page_settings" on public.landing_page_settings;
drop policy if exists landing_page_settings_company_service_all on public.landing_page_settings;

create policy "Allow public read of landing_page_settings"
  on public.landing_page_settings
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      is_published = true
      or (select public.has_permission((select auth.uid()), 'landing_page.read'))
    )
  );

create policy "Allow staff write of landing_page_settings"
  on public.landing_page_settings
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.update'))
  );

create policy landing_page_settings_company_service_all on public.landing_page_settings
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 3. landing_page_sections
------------------------------------------------------------

revoke all on public.landing_page_sections from anon;
grant select, insert, update, delete on public.landing_page_sections to company_service;

alter table public.landing_page_sections enable row level security;
alter table public.landing_page_sections force row level security;

drop policy if exists "Allow public read of landing_page_sections" on public.landing_page_sections;
drop policy if exists "Allow staff write of landing_page_sections" on public.landing_page_sections;
drop policy if exists landing_page_sections_company_service_all on public.landing_page_sections;

create policy "Allow public read of landing_page_sections"
  on public.landing_page_sections
  for select to authenticated
  using (company_id = (select public.current_company_id()));

create policy "Allow staff write of landing_page_sections"
  on public.landing_page_sections
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.update'))
  );

create policy landing_page_sections_company_service_all on public.landing_page_sections
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 4. landing_carousel_slides
------------------------------------------------------------

revoke all on public.landing_carousel_slides from anon;
grant select, insert, update, delete on public.landing_carousel_slides to company_service;

alter table public.landing_carousel_slides enable row level security;
alter table public.landing_carousel_slides force row level security;

drop policy if exists "Allow public read of landing_carousel_slides" on public.landing_carousel_slides;
drop policy if exists "Allow staff write of landing_carousel_slides" on public.landing_carousel_slides;
drop policy if exists landing_carousel_slides_company_service_all on public.landing_carousel_slides;

create policy "Allow public read of landing_carousel_slides"
  on public.landing_carousel_slides
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      is_active = true
      or (select public.has_permission((select auth.uid()), 'landing_page.read'))
    )
  );

create policy "Allow staff write of landing_carousel_slides"
  on public.landing_carousel_slides
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.update'))
  );

create policy landing_carousel_slides_company_service_all on public.landing_carousel_slides
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 5. leasing_inquiries
------------------------------------------------------------

revoke all on public.leasing_inquiries from anon;
grant select, insert, update, delete on public.leasing_inquiries to company_service;

alter table public.leasing_inquiries enable row level security;
alter table public.leasing_inquiries force row level security;

drop policy if exists "Allow public insert of leasing_inquiries" on public.leasing_inquiries;
drop policy if exists "Allow staff read of leasing_inquiries" on public.leasing_inquiries;
drop policy if exists "Allow staff write of leasing_inquiries" on public.leasing_inquiries;
drop policy if exists "Allow admins to delete leasing_inquiries" on public.leasing_inquiries;
drop policy if exists leasing_inquiries_company_service_all on public.leasing_inquiries;

create policy "Allow staff read of leasing_inquiries"
  on public.leasing_inquiries
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.leasing_read'))
  );

create policy "Allow staff write of leasing_inquiries"
  on public.leasing_inquiries
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.leasing_update'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.leasing_update'))
  );

create policy "Allow admins to delete leasing_inquiries"
  on public.leasing_inquiries
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'landing_page.leasing_update'))
  );

create policy leasing_inquiries_company_service_all on public.leasing_inquiries
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));
