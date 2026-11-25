-- 223_payment_request_superseded_status.sql
--
-- يضيف الحالة "superseded" لطلب الدفع الذي استُبدل رابطه برابط جديد.
--
-- `createPayment` used to reset a stale pending request IN PLACE: same row,
-- new MyFatoorah link, provider ids cleared. The old link stays payable at the
-- gateway (`/v3/payments` documents no expiry field), and a charge on it then
-- matched no request at all — captured money recorded nowhere (Phase 2C, PR B).
--
-- Now a stale or mismatched pending request is marked `superseded`, its
-- idempotency key is released (set to null — the unique constraint allows many
-- nulls), and a NEW row carries the new link. Request and link are 1:1 again,
-- so a charge on an old link still finds its row by provider_invoice_id and
-- settles through the normal path (as #EXCESS when its invoices were already
-- paid). The guarantee changes from "one row per invoice selection" to "one
-- PENDING row per invoice selection".
--
-- Idempotent: the constraint is dropped by its real name and re-added.

begin;

alter table public.payment_requests
  drop constraint if exists payment_requests_status_check;

alter table public.payment_requests
  add constraint payment_requests_status_check
  check (status in ('pending', 'completed', 'failed', 'expired', 'cancelled', 'superseded'));

commit;
