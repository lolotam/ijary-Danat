-- T039: تقييد سياسات التخزين بالبادئة companies/<company_id>/ عبر جميع الحاويات الأربع عشرة
-- Scopes storage.objects policies across all 14 buckets to the companies/<company_id>/ prefix,
-- grants company_service storage privileges, and hoists all auth/company helper calls.

grant usage on schema storage to company_service;
grant select, insert, update, delete on storage.objects to company_service;

do $$
declare
  v_pol record;
begin
  for v_pol in
    select policyname from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
  loop
    execute format('drop policy if exists %I on storage.objects', v_pol.policyname);
  end loop;
end;
$$;

-- الحاويات العامة الثلاث (branding, landing, property-images): قراءة صفوف الكائنات لمستخدمي الشركة نفسها فقط.
-- Public buckets serve `/object/public/...` without consulting RLS, so public URLs
-- keep working with no select policy. A `to public` select here only let anyone
-- list and enumerate every company's file names (T052m).
create policy storage_public_buckets_select
  on storage.objects for select to authenticated
  using (bucket_id in ('branding', 'landing', 'property-images') and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text);

-- وصول خدمة الشركة إلى كائنات الشركة الحالية في جميع الحاويات الأربع عشرة.
create policy storage_company_service_all
  on storage.objects for all to company_service
  using ((storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text)
  with check ((storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text);

create policy storage_service_role_all
  on storage.objects for all to service_role using (true) with check (true);

-- branding
create policy storage_branding_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'branding' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_role((select auth.uid()), 'admin'::public.app_role)));
create policy storage_branding_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'branding' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_role((select auth.uid()), 'admin'::public.app_role)))
  with check (bucket_id = 'branding' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_role((select auth.uid()), 'admin'::public.app_role)));
create policy storage_branding_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'branding' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_role((select auth.uid()), 'admin'::public.app_role)));

-- landing
create policy storage_landing_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'landing' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'landing_page.update')));
create policy storage_landing_update on storage.objects for update to authenticated
  using (bucket_id = 'landing' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'landing_page.update')))
  with check (bucket_id = 'landing' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'landing_page.update')));
create policy storage_landing_delete on storage.objects for delete to authenticated
  using (bucket_id = 'landing' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'landing_page.update')));

-- property-images
create policy storage_property_images_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'property-images' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))));
create policy storage_property_images_update on storage.objects for update to authenticated
  using (bucket_id = 'property-images' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))))
  with check (bucket_id = 'property-images' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))));
create policy storage_property_images_delete on storage.objects for delete to authenticated
  using (bucket_id = 'property-images' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))));

-- backups
create policy storage_backups_select on storage.objects for select to authenticated
  using (bucket_id = 'backups' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'settings.backup')));
create policy storage_backups_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'backups' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'settings.backup')));
create policy storage_backups_update on storage.objects for update to authenticated
  using (bucket_id = 'backups' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'settings.backup')))
  with check (bucket_id = 'backups' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'settings.backup')));
create policy storage_backups_delete on storage.objects for delete to authenticated
  using (bucket_id = 'backups' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'settings.backup')));

-- company-documents
create policy storage_company_documents_select on storage.objects for select to authenticated
  using (bucket_id = 'company-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))));
create policy storage_company_documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'company-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'notifications.send')));
create policy storage_company_documents_update on storage.objects for update to authenticated
  using (bucket_id = 'company-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_role((select auth.uid()), 'admin'::public.app_role)))
  with check (bucket_id = 'company-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_role((select auth.uid()), 'admin'::public.app_role)));
create policy storage_company_documents_delete on storage.objects for delete to authenticated
  using (bucket_id = 'company-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_role((select auth.uid()), 'admin'::public.app_role)));

-- deposit-attachments
create policy storage_deposit_attachments_select on storage.objects for select to authenticated
  using (bucket_id = 'deposit-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))));
create policy storage_deposit_attachments_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'deposit-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and ((select public.has_permission((select auth.uid()), 'deposits.create')) or (select public.has_permission((select auth.uid()), 'deposits.update'))));
create policy storage_deposit_attachments_update on storage.objects for update to authenticated
  using (bucket_id = 'deposit-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'deposits.update')))
  with check (bucket_id = 'deposit-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'deposits.update')));
create policy storage_deposit_attachments_delete on storage.objects for delete to authenticated
  using (bucket_id = 'deposit-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and ((select public.has_permission((select auth.uid()), 'deposits.delete')) or (select public.has_permission((select auth.uid()), 'deposits.update'))));

-- employee-documents
create policy storage_employee_documents_select on storage.objects for select to authenticated
  using (bucket_id = 'employee-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))));
create policy storage_employee_documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'employee-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'employees.update')));
create policy storage_employee_documents_update on storage.objects for update to authenticated
  using (bucket_id = 'employee-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'employees.update')))
  with check (bucket_id = 'employee-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'employees.update')));
create policy storage_employee_documents_delete on storage.objects for delete to authenticated
  using (bucket_id = 'employee-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'employees.delete')));

-- expense-attachments
create policy storage_expense_attachments_select on storage.objects for select to authenticated
  using (bucket_id = 'expense-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))));
create policy storage_expense_attachments_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'expense-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'expenses.create')));
create policy storage_expense_attachments_update on storage.objects for update to authenticated
  using (bucket_id = 'expense-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'expenses.update')))
  with check (bucket_id = 'expense-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'expenses.update')));
create policy storage_expense_attachments_delete on storage.objects for delete to authenticated
  using (bucket_id = 'expense-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'expenses.delete')));

-- gmail-attachments
create policy storage_gmail_attachments_select on storage.objects for select to authenticated
  using (bucket_id = 'gmail-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'notifications.read')));
create policy storage_gmail_attachments_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'gmail-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'notifications.send')));
create policy storage_gmail_attachments_update on storage.objects for update to authenticated
  using (bucket_id = 'gmail-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'notifications.send')))
  with check (bucket_id = 'gmail-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'notifications.send')));
create policy storage_gmail_attachments_delete on storage.objects for delete to authenticated
  using (bucket_id = 'gmail-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_role((select auth.uid()), 'admin'::public.app_role)));

-- payment-attachments
create policy storage_payment_attachments_select on storage.objects for select to authenticated
  using (bucket_id = 'payment-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))));
create policy storage_payment_attachments_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'payment-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))) and (select public.has_permission((select auth.uid()), 'payments.create')));
create policy storage_payment_attachments_update on storage.objects for update to authenticated
  using (bucket_id = 'payment-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))) and (select public.has_permission((select auth.uid()), 'payments.update')))
  with check (bucket_id = 'payment-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))) and (select public.has_permission((select auth.uid()), 'payments.update')));
create policy storage_payment_attachments_delete on storage.objects for delete to authenticated
  using (bucket_id = 'payment-attachments' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))) and (select public.has_permission((select auth.uid()), 'payments.update')));

-- report-documents
create policy storage_report_documents_select on storage.objects for select to authenticated
  using (bucket_id = 'report-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))));
create policy storage_report_documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'report-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'reports.read')));
create policy storage_report_documents_update on storage.objects for update to authenticated
  using (bucket_id = 'report-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_role((select auth.uid()), 'admin'::public.app_role)))
  with check (bucket_id = 'report-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_role((select auth.uid()), 'admin'::public.app_role)));
create policy storage_report_documents_delete on storage.objects for delete to authenticated
  using (bucket_id = 'report-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_role((select auth.uid()), 'admin'::public.app_role)));

-- tenant-documents (المستأجر يقرأ ملفاته ضمن companies/<cid>/tenants/<tid>/، والموظفون بالصلاحية)
create policy storage_tenant_documents_select on storage.objects for select to authenticated
  using (
    bucket_id = 'tenant-documents'
    and (storage.foldername(name))[1] = 'companies'
    and (storage.foldername(name))[2] = ((select public.current_company_id()))::text
    and (
      (select public.is_staff((select auth.uid())))
      or ((storage.foldername(name))[3] = 'tenants' and exists (
        select 1 from public.profiles p
         where p.company_id = (select public.current_company_id()) and p.id = (select auth.uid())
           and p.tenant_id is not null and (p.tenant_id)::text = (storage.foldername(storage.objects.name))[4]
      ))
    )
  );
create policy storage_tenant_documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'tenant-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'tenants.update')));
create policy storage_tenant_documents_update on storage.objects for update to authenticated
  using (bucket_id = 'tenant-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'tenants.update')))
  with check (bucket_id = 'tenant-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'tenants.update')));
create policy storage_tenant_documents_delete on storage.objects for delete to authenticated
  using (bucket_id = 'tenant-documents' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'tenants.update')));

-- tenant-messages (نقل البادئة من <tenant_id>/... إلى companies/<company_id>/...)
create policy storage_tenant_messages_select on storage.objects for select to authenticated
  using (
    bucket_id = 'tenant-messages'
    and (storage.foldername(name))[1] = 'companies'
    and (storage.foldername(name))[2] = ((select public.current_company_id()))::text
    and (
      (select public.is_staff((select auth.uid())))
      or exists (
        select 1 from public.profiles p
         where p.company_id = (select public.current_company_id()) and p.id = (select auth.uid())
           and p.tenant_id is not null and (p.tenant_id)::text in ((storage.foldername(storage.objects.name))[3], (storage.foldername(storage.objects.name))[4])
      )
    )
  );
create policy storage_tenant_messages_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'tenant-messages'
    and (storage.foldername(name))[1] = 'companies'
    and (storage.foldername(name))[2] = ((select public.current_company_id()))::text
    and (
      (select public.is_staff((select auth.uid())))
      or exists (
        select 1 from public.profiles p
         where p.company_id = (select public.current_company_id()) and p.id = (select auth.uid())
           and p.tenant_id is not null and (p.tenant_id)::text in ((storage.foldername(storage.objects.name))[3], (storage.foldername(storage.objects.name))[4])
      )
    )
  );
create policy storage_tenant_messages_update on storage.objects for update to authenticated
  using (bucket_id = 'tenant-messages' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))))
  with check (bucket_id = 'tenant-messages' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))));
create policy storage_tenant_messages_delete on storage.objects for delete to authenticated
  using (bucket_id = 'tenant-messages' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.is_staff((select auth.uid()))));

-- whatsapp-media
create policy storage_whatsapp_media_select on storage.objects for select to authenticated
  using (bucket_id = 'whatsapp-media' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'notifications.read')));
create policy storage_whatsapp_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'whatsapp-media' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'notifications.send')));
create policy storage_whatsapp_media_update on storage.objects for update to authenticated
  using (bucket_id = 'whatsapp-media' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'notifications.send')))
  with check (bucket_id = 'whatsapp-media' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_permission((select auth.uid()), 'notifications.send')));
create policy storage_whatsapp_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'whatsapp-media' and (storage.foldername(name))[1] = 'companies' and (storage.foldername(name))[2] = ((select public.current_company_id()))::text and (select public.has_role((select auth.uid()), 'admin'::public.app_role)));
