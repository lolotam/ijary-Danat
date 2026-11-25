-- ---------------------------------------------------------------------------
-- 182 - whatsapp-media storage bucket
-- ---------------------------------------------------------------------------
--
-- Holds files exchanged through the WhatsApp inbox: attachments received from
-- tenants (fetched once from Evolution, then cached here) and files the admin
-- sends from the composer.
--
-- Why a bucket rather than fetching from Evolution every time: Evolution's
-- media store is not permanent — old payloads expire — and this bucket lives
-- on the Supabase Storage bind mount, so files survive every container
-- redeploy. Object path: chat/<chat_number>/<message_id>/<file name>.
--
-- PRIVATE, and readable only by service_role: the download and send server
-- fns run with the service key after their own permission checks; no browser
-- ever fetches from this bucket directly.
--
-- Reminder for anyone copying this bucket between servers: Supabase Storage
-- keeps each object's content type in POSIX extended attributes, so use
-- `rsync -aX` or `tar --xattrs`. A plain copy leaves every file present on
-- disk and returns HTTP 500 ENODATA on read.

insert into storage.buckets (id, name, public)
values ('whatsapp-media', 'whatsapp-media', false)
on conflict (id) do update set public = false;

drop policy if exists whatsapp_media_service_all on storage.objects;
create policy whatsapp_media_service_all on storage.objects
  for all to service_role
  using (bucket_id = 'whatsapp-media')
  with check (bucket_id = 'whatsapp-media');
