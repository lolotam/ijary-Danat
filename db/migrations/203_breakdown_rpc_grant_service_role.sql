-- 203_breakdown_rpc_grant_service_role.sql
--
-- منح دور الخادم صلاحية تنفيذ لقطة سداد الفاتورة صراحةً لا اعتماداً على الافتراضات.
--
-- `renderInvoiceDocumentPdf` and `paymentReceiptPdf` call
-- get_invoice_payment_breakdown through supabaseAdmin (service_role). Migration
-- 192 granted it only to `authenticated`; service_role has worked so far solely
-- through the schema's default privileges, which a future re-issue could drop
-- without anyone noticing until every attachment came back null. Make the
-- grant explicit, the convention every other definer function here follows.

grant execute on function public.get_invoice_payment_breakdown(uuid) to service_role;
