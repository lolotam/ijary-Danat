-- 49_company_documents_bucket.sql
--
-- Private bucket for server-generated company documents.
--
-- Why: `sendCompanyInfo` renders a company-information PDF and uploads it so
-- `dispatchNotification.loadAttachments()` can attach it to the outgoing
-- email. That upload originally targeted the `branding` bucket, which
-- migration 21 deliberately made world-readable
-- (`branding_public_read ... for select to public`) because it serves the logo
-- and favicon to anonymous visitors on the landing page.
--
-- Generated documents do not belong there. They carry the company's bank
-- details and accumulate one object per send, and nothing about the email
-- path needs public read: `loadAttachments` downloads with the service-role
-- client, which bypasses RLS. A private bucket is therefore a drop-in.
--
-- Mirrors the deposit-attachments policy shape from migration 08.
-- Idempotent.
------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('company-documents', 'company-documents', false)
on conflict (id) do nothing;

-- Staff may read generated company documents (e.g. to re-download a sent PDF).
drop policy if exists company_documents_read on storage.objects;
create policy company_documents_read on storage.objects
  for select to authenticated
  using (bucket_id = 'company-documents' and public.is_staff(auth.uid()));

-- Writes come from the server fn under the service-role key, which bypasses
-- RLS; this policy only covers an admin uploading through the client.
drop policy if exists company_documents_write on storage.objects;
create policy company_documents_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'company-documents' and public.has_permission(auth.uid(), 'notifications.send')
  );

drop policy if exists company_documents_delete on storage.objects;
create policy company_documents_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'company-documents' and public.has_role(auth.uid(), 'admin'));
