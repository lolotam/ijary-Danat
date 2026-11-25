-- Migration 28: Allow staff to upload tenant-message attachments while previewing the portal
--
-- Background: the tenant portal can be previewed by staff (profiles.is_staff = true)
-- using ?tenant=<id>. In that case the staff user's own profile has tenant_id = null,
-- so the existing INSERT policy on storage.objects for bucket 'tenant-messages'
-- (migration 22, lines 117-125) rejects the upload. The throw aborts the entire
-- send flow before the tenant_messages row is inserted, so the message never
-- reaches the admin inbox.
--
-- Fix: add a parallel INSERT policy that lets any staff user upload into the
-- bucket, regardless of their tenant_id. The path-naming convention is preserved
-- on the client side (the first path segment is the previewed tenant's id).

-- Storage INSERT policy for staff (additive — does not change the tenant policy)
drop policy if exists tenant_messages_attachments_insert_staff on storage.objects;
create policy tenant_messages_attachments_insert_staff on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'tenant-messages'
    and public.is_staff(auth.uid())
  );

-- Also allow staff to insert tenant_messages rows when sending from the portal preview.
-- The existing tenant_messages_insert policy (migration 22) keys on the sender's own
-- tenant_id, which is null for staff — so we add a parallel staff-insert policy.
drop policy if exists tenant_messages_insert_staff on public.tenant_messages;
create policy tenant_messages_insert_staff on public.tenant_messages
  for insert to authenticated
  with check (
    sender_profile_id = auth.uid()
    and public.is_staff(auth.uid())
  );
