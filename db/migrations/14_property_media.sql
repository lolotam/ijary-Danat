-- 14_property_media.sql
-- Storage bucket + RLS for property/building cover images. Idempotent.
-- The `properties` and `buildings` tables already carry `image_url` columns.
-- Uploaded objects live under: companies/{company_id}/properties/{property_id}/...
--                              companies/{company_id}/buildings/{building_id}/...

insert into storage.buckets (id, name, public)
values ('property-images', 'property-images', true)
on conflict (id) do nothing;

drop policy if exists property_images_select on storage.objects;
create policy property_images_select on storage.objects
  for select to public
  using (bucket_id = 'property-images');

drop policy if exists property_images_insert on storage.objects;
create policy property_images_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'property-images'
    and public.is_staff(auth.uid())
  );

drop policy if exists property_images_update on storage.objects;
create policy property_images_update on storage.objects
  for update to authenticated
  using (bucket_id = 'property-images' and public.is_staff(auth.uid()))
  with check (bucket_id = 'property-images' and public.is_staff(auth.uid()));

drop policy if exists property_images_delete on storage.objects;
create policy property_images_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'property-images' and public.is_staff(auth.uid()));
