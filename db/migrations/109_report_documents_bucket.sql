-- ---------------------------------------------------------------------------
-- 109 - report-documents storage bucket
-- ---------------------------------------------------------------------------
--
-- Holds the PDF rendered for each emailed report and receipt.
--
-- Why a bucket rather than an inline buffer: dispatchNotification already loads
-- attachments from `payload.attachment_paths` + `payload.attachment_bucket`, so
-- storing the file reuses the mechanism instead of adding a second one. It also
-- means a resend costs no re-render, and the exact PDF a recipient was sent
-- stays retrievable.
--
-- PRIVATE, and readable only by service_role. These documents carry tenant
-- financial data. The renderer and the mail dispatcher both run server-side
-- with the service key; no browser ever needs to fetch from this bucket, so
-- there is deliberately no authenticated-role read policy. Note that a bucket
-- with RLS enabled and no matching policy denies by default, but the explicit
-- service_role policy is written out so a future reader does not assume the
-- omission was an oversight.
--
-- Reminder for anyone copying this bucket between servers: Supabase Storage
-- keeps each object's content type in POSIX extended attributes, so use
-- `rsync -aX` or `tar --xattrs`. A plain copy leaves every file present on disk
-- and returns HTTP 500 ENODATA on read — the failure that broke the July 2026
-- server move.

insert into storage.buckets (id, name, public)
values ('report-documents', 'report-documents', false)
on conflict (id) do update set public = false;

drop policy if exists report_documents_service_all on storage.objects;
create policy report_documents_service_all on storage.objects
  for all to service_role
  using (bucket_id = 'report-documents')
  with check (bucket_id = 'report-documents');
