alter table public.landing_media
  drop constraint if exists landing_media_category_check;

alter table public.landing_media
  add constraint landing_media_category_check
  check (category in (
    'exterior', 'interior', 'shops', 'facilities', 'events', 'parking', 'logo', 'tenant_avatar'
  ));

alter table public.tenants
  add column if not exists avatar_media_id uuid
    references public.landing_media(id) on delete set null;

create index if not exists tenants_avatar_media_id_idx
  on public.tenants (avatar_media_id);
