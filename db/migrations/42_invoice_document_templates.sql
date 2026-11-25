-- 42_invoice_document_templates.sql
-- Seeds invoice-document template codes referenced by sendInvoiceToTenant.
-- Runtime HTML body is still built in code (invoiceDocumentTemplate); these rows
-- satisfy notifications.template_code FK and hold future WhatsApp provider mappings.
-- Idempotent.

insert into public.notification_templates (
  code, type, channel, locale, subject_ar, subject_en, body_ar, body_en
) values
  (
    'invoice-document-ar',
    'document_send',
    'email',
    'ar',
    'فاتورة {{invoice_code}}',
    'Invoice {{invoice_code}}',
    'تم إرسال فاتورة {{invoice_code}} بمبلغ {{total}}، الاستحقاق {{due_date}}.',
    'Invoice {{invoice_code}} for {{total}} was sent. Due {{due_date}}.'
  ),
  (
    'invoice-document-en',
    'document_send',
    'email',
    'en',
    'فاتورة {{invoice_code}}',
    'Invoice {{invoice_code}}',
    'تم إرسال فاتورة {{invoice_code}} بمبلغ {{total}}، الاستحقاق {{due_date}}.',
    'Invoice {{invoice_code}} for {{total}} was sent. Due {{due_date}}.'
  )
on conflict (code) do nothing;
