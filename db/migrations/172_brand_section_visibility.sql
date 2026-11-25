-- 172_brand_section_visibility.sql
-- تحكم مستقل بظهور كل محل في قسمي الصفحة الرئيسية — شريط العلامات ودليل المحلات.
-- Independent per-shop visibility for the two landing-page bands that mirror
-- `landing_page_sections` keys `brands_marquee` and `shop_explorer` by name so a
-- search for a section key finds the per-shop override too. These are per-shop
-- overrides that sit *underneath* the global section switch: the section switch
-- hides the whole band, these hide one shop. Defaults are true so every
-- existing shop stays visible in both sections after the migration — no backfill
-- to false.

alter table public.commercial_brands
  add column if not exists show_in_brands_marquee boolean not null default true;

alter table public.commercial_brands
  add column if not exists show_in_shop_explorer boolean not null default true;
