-- 35_landing_media_show_in_gallery.sql
-- Opt-in flag so only explicitly selected media appear in the public gallery.
-- Also allows category = 'gallery' for dedicated gallery uploads.
-- Idempotent.

------------------------------------------------------------------------
-- 1. show_in_gallery flag (default false — brands/slides no longer flood gallery)
------------------------------------------------------------------------
alter table public.landing_media
  add column if not exists show_in_gallery boolean not null default false;

create index if not exists landing_media_show_in_gallery_idx
  on public.landing_media (show_in_gallery, display_order)
  where show_in_gallery = true and is_active = true;

------------------------------------------------------------------------
-- 2. Expand category check to include dedicated gallery assets
------------------------------------------------------------------------
alter table public.landing_media
  drop constraint if exists landing_media_category_check;

alter table public.landing_media
  add constraint landing_media_category_check
  check (category in (
    'exterior',
    'interior',
    'shops',
    'facilities',
    'events',
    'parking',
    'logo',
    'tenant_avatar',
    'gallery'
  ));

comment on column public.landing_media.show_in_gallery is
  'When true (and is_active), media is shown on the public landing page gallery section.';
