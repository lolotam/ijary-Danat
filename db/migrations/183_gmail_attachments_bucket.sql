-- ---------------------------------------------------------------------------
-- 183 - gmail-attachments storage bucket
-- ---------------------------------------------------------------------------
--
-- Caches the bytes of Gmail attachments the first time an admin downloads
-- them, so the file remains available after the message is trashed in Gmail,
-- the mailbox is disconnected, or Google's token is unavailable — and repeat
-- downloads stop costing a Gmail API call. Same durability rationale as
-- whatsapp-media (182): the bucket lives on the Supabase Storage bind mount
-- and survives every container redeploy.
--
-- Object path: message/<gmail_messages.id>/<attachment hash>/<file name>.
-- The hash stands in for Gmail's attachmentId, which can exceed storage key
-- length limits.
--
-- PRIVATE, service_role only: the download server fn performs its own staff
-- check and streams base64 to the browser; nothing fetches from this bucket
-- directly.
--
-- Reminder when copying between servers: Supabase Storage keeps content types
-- in POSIX extended attributes — use `rsync -aX` or `tar --xattrs`, or every
-- object 500s with ENODATA while looking present on disk.

insert into storage.buckets (id, name, public)
values ('gmail-attachments', 'gmail-attachments', false)
on conflict (id) do update set public = false;

drop policy if exists gmail_attachments_service_all on storage.objects;
create policy gmail_attachments_service_all on storage.objects
  for all to service_role
  using (bucket_id = 'gmail-attachments')
  with check (bucket_id = 'gmail-attachments');
