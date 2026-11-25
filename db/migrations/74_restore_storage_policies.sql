-- 74_restore_storage_policies.sql
--
-- Restore every RLS policy on storage.objects that was lost in the July 2026
-- server move.
--
-- Background: `storage.objects` belongs to the storage-api container's schema,
-- not to this repo. Migrations only *attach* policies to it. When the Supabase
-- stack was rebuilt on the Danat-Future host (2026-07-28) the storage schema was
-- recreated from scratch while `public` was restored from a dump — so all 195
-- public policies survived and every storage policy did not. Only migrations
-- applied after the move (05 re-issued, 57) had their policies re-created; the
-- rest of the buckets were left with RLS enabled and no policy at all, which
-- denies by default.
--
-- Symptom: every client-side upload fails with "new row violates row-level
-- security policy". `landing` and `branding` still *read* fine because they are
-- public buckets and storage-api serves those without consulting RLS, which is
-- why this went unnoticed — the newest object in any bucket is 2026-07-26.
--
-- Broken until this runs: property/landing images, tenant documents, expense
-- and deposit attachments, tenant-message attachments, company documents.
--
-- These are re-issued VERBATIM from their originating migrations so the restore
-- is auditable as "put back exactly what was lost" — not a behaviour change.
-- Where a later migration superseded a definition, the later one wins:
--   deposit_attachments_insert_permitted / _delete_permitted -> migration 29
--   tenant_messages_attachments_insert_staff                 -> migration 28
--
-- Idempotent: drop-if-exists + create throughout. Must run as the owner of
-- storage.objects (supabase_admin); as a non-owner every `create policy` fails
-- with "must be owner of table objects".

-- tenant-documents (migration 04) ---------------------------------------------
drop policy if exists tenant_documents_storage_select on storage.objects;
create policy tenant_documents_storage_select on storage.objects for select to authenticated using (
  bucket_id = 'tenant-documents'
  and (storage.foldername(name))[1] = 'companies'
  and (storage.foldername(name))[3] = 'tenants'
  and (
    public.is_staff(auth.uid()) or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.tenant_id::text = (storage.foldername(name))[4]
    )
  )
);

drop policy if exists tenant_documents_storage_insert on storage.objects;
create policy tenant_documents_storage_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'tenant-documents'
  and (storage.foldername(name))[1] = 'companies'
  and (storage.foldername(name))[3] = 'tenants'
  and public.has_permission(auth.uid(), 'tenants.update')
);

drop policy if exists tenant_documents_storage_delete on storage.objects;
create policy tenant_documents_storage_delete on storage.objects for delete to authenticated using (
  bucket_id = 'tenant-documents'
  and (storage.foldername(name))[1] = 'companies'
  and (storage.foldername(name))[3] = 'tenants'
  and public.has_permission(auth.uid(), 'tenants.update')
);

-- expense-attachments (migration 08) -------------------------------------------
drop policy if exists expense_attachments_select_staff on storage.objects;
create policy expense_attachments_select_staff on storage.objects for select to authenticated
using (bucket_id = 'expense-attachments' and public.is_staff(auth.uid()));

drop policy if exists expense_attachments_insert_permitted on storage.objects;
create policy expense_attachments_insert_permitted on storage.objects for insert to authenticated
with check (bucket_id = 'expense-attachments' and public.has_permission(auth.uid(), 'expenses.create'));

drop policy if exists expense_attachments_update_permitted on storage.objects;
create policy expense_attachments_update_permitted on storage.objects for update to authenticated
using (bucket_id = 'expense-attachments' and public.has_permission(auth.uid(), 'expenses.update'))
with check (bucket_id = 'expense-attachments' and public.has_permission(auth.uid(), 'expenses.update'));

drop policy if exists expense_attachments_delete_permitted on storage.objects;
create policy expense_attachments_delete_permitted on storage.objects for delete to authenticated
using (bucket_id = 'expense-attachments' and public.has_permission(auth.uid(), 'expenses.delete'));

-- deposit-attachments (migration 08; insert/delete superseded by 29) -----------
drop policy if exists deposit_attachments_select_staff on storage.objects;
create policy deposit_attachments_select_staff on storage.objects for select to authenticated
using (bucket_id = 'deposit-attachments' and public.is_staff(auth.uid()));

drop policy if exists deposit_attachments_insert_permitted on storage.objects;
create policy deposit_attachments_insert_permitted on storage.objects for insert to authenticated
with check (
  bucket_id = 'deposit-attachments'
  and (
    public.has_permission(auth.uid(), 'deposits.create')
    or public.has_permission(auth.uid(), 'deposits.update')
  )
);

drop policy if exists deposit_attachments_update_permitted on storage.objects;
create policy deposit_attachments_update_permitted on storage.objects for update to authenticated
using (bucket_id = 'deposit-attachments' and public.has_permission(auth.uid(), 'deposits.update'))
with check (bucket_id = 'deposit-attachments' and public.has_permission(auth.uid(), 'deposits.update'));

drop policy if exists deposit_attachments_delete_permitted on storage.objects;
create policy deposit_attachments_delete_permitted on storage.objects for delete to authenticated
using (
  bucket_id = 'deposit-attachments'
  and (
    public.has_permission(auth.uid(), 'deposits.delete')
    or public.has_permission(auth.uid(), 'deposits.update')
  )
);

-- property-images (migration 14) -----------------------------------------------
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

-- branding (migration 21) -------------------------------------------------------
drop policy if exists branding_public_read on storage.objects;
create policy branding_public_read on storage.objects
  for select to public using (bucket_id = 'branding');

drop policy if exists branding_admin_write on storage.objects;
create policy branding_admin_write on storage.objects
  for all to authenticated
  using (bucket_id = 'branding' and public.has_role(auth.uid(), 'admin'))
  with check (bucket_id = 'branding' and public.has_role(auth.uid(), 'admin'));

-- landing (migration 22) --------------------------------------------------------
drop policy if exists landing_public_read on storage.objects;
create policy landing_public_read on storage.objects
  for select to public using (bucket_id = 'landing');

drop policy if exists landing_admin_write on storage.objects;
create policy landing_admin_write on storage.objects
  for all to authenticated
  using (bucket_id = 'landing' and public.has_role(auth.uid(), 'admin'))
  with check (bucket_id = 'landing' and public.has_role(auth.uid(), 'admin'));

-- tenant-messages (migration 22; staff insert added by 28) ----------------------
drop policy if exists tenant_messages_attachments_select on storage.objects;
create policy tenant_messages_attachments_select on storage.objects
  for select to authenticated
  using (bucket_id = 'tenant-messages' and (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.tenant_id is not null
        and (storage.foldername(name))[1] = p.tenant_id::text
    )
  ));

drop policy if exists tenant_messages_attachments_insert on storage.objects;
create policy tenant_messages_attachments_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'tenant-messages' and exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.tenant_id is not null
      and (storage.foldername(name))[1] = p.tenant_id::text
  ));

drop policy if exists tenant_messages_attachments_insert_staff on storage.objects;
create policy tenant_messages_attachments_insert_staff on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'tenant-messages'
    and public.is_staff(auth.uid())
  );

-- company-documents (migration 49) ----------------------------------------------
drop policy if exists company_documents_read on storage.objects;
create policy company_documents_read on storage.objects
  for select to authenticated
  using (bucket_id = 'company-documents' and public.is_staff(auth.uid()));

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
