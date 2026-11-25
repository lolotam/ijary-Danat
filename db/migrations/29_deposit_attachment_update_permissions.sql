-- Editing a deposit can replace or remove its receipt. Storage must therefore
-- authorize those file operations with the same deposits.update permission as
-- the deposits row update policy.

drop policy if exists deposit_attachments_insert_permitted on storage.objects;
create policy deposit_attachments_insert_permitted on storage.objects for insert to authenticated
with check (
  bucket_id = 'deposit-attachments'
  and (
    public.has_permission(auth.uid(), 'deposits.create')
    or public.has_permission(auth.uid(), 'deposits.update')
  )
);

drop policy if exists deposit_attachments_delete_permitted on storage.objects;
create policy deposit_attachments_delete_permitted on storage.objects for delete to authenticated
using (
  bucket_id = 'deposit-attachments'
  and (
    public.has_permission(auth.uid(), 'deposits.delete')
    or public.has_permission(auth.uid(), 'deposits.update')
  )
);
