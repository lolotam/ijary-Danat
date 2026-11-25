-- ---------------------------------------------------------------------------
-- 80 — manual payment for an invoice: event workflow
-- ---------------------------------------------------------------------------
--
-- Ticking an invoice paid on /admin/invoices records a cash payment for the
-- remaining balance but sent nothing. This registers the workflow that emails
-- the receipt, dispatched by `notifyManualPaymentInvoice` in
-- src/fns/notifyPaymentSuccess.ts.
--
-- No notification_templates rows: the sender reuses the existing
-- receipt-ar/-en and payment-admin-alert-ar/-en copy, so a manually settled
-- invoice produces the same receipt as a card payment and there is one place to
-- edit that wording rather than two.
--
-- A row with this key already exists on the live database — it was inserted by
-- hand on 2026-08-03 as a placeholder reminder while the code did not exist,
-- then switched off because it did nothing. `on conflict` therefore has to
-- adopt that row rather than fail.
--
-- Idempotent, and applied by hand to the live database before deploy.

insert into public.cron_jobs (key, kind, name_ar, name_en, description_ar, description_en)
values
  ('manual-payment-invoice', 'event',
   'دفع يدوي لفاتورة', 'Manual payment for an invoice',
   'يرسل إيصالاً إلى المستأجر وتنبيهاً إلى مستلمي الإدارة عندما يعلّم المسؤول فاتورة كمدفوعة يدوياً.',
   'Emails the receipt to the tenant and an alert to the admin recipients when an admin marks an invoice manually paid.')
on conflict (key) do update
  set kind = excluded.kind,
      name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      description_ar = excluded.description_ar,
      description_en = excluded.description_en;

-- Unlike migration 72, this DOES set is_active. The convention there — never
-- re-enable a workflow an admin switched off — protects a deliberate opt-out.
-- Here the row was switched off only because it was an inert placeholder, and
-- turning the finished feature on is the explicit request this migration exists
-- to satisfy. Scoped to the one key so no other workflow is touched.
update public.cron_jobs
  set is_active = true,
      recipient_targets = array['admin','company','tenant']::text[]
  where key = 'manual-payment-invoice';
