-- ---------------------------------------------------------------------------
-- 107 - payment reconciliation job
-- ---------------------------------------------------------------------------
--
-- Registers the `payment-reconcile` scheduled job so it appears in
-- Settings > Cron with a pause switch, the same as every other cron entry.
--
-- Why this job exists: settleGatewayPayment is otherwise reachable only from
-- confirmGatewayPayment, which requires an authenticated browser sitting on
-- /portal/payments/callback. A tenant who pays a payment link without signing
-- in, or who closes the tab, leaves money taken and the invoice unpaid with no
-- path that ever corrects it. The MyFatoorah webhook was meant to be that path
-- and had not fired once in production as of 2026-08-06 (webhook_events was
-- empty). This job is the backstop that depends on neither.
--
-- recipient_targets is left to its default: this is a scheduled job, not an
-- event workflow, so only the is_active pause switch is read for it.
--
-- `do update` deliberately does NOT touch is_active: replaying this migration
-- must never silently re-enable a job an admin switched off.

insert into public.cron_jobs (
  key, kind, name_ar, name_en, description_ar, description_en
)
values
  (
    'payment-reconcile', 'scheduled',
    'تسوية مدفوعات البوابة',
    'Payment reconciliation',
    'يتحقق من طلبات الدفع المعلقة لدى ماي فاتورة ويسوّي المدفوعة منها.',
    'Polls pending payment requests against MyFatoorah and settles the paid ones.'
  )
on conflict (key) do update
  set kind = excluded.kind,
      name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      description_ar = excluded.description_ar,
      description_en = excluded.description_en;
