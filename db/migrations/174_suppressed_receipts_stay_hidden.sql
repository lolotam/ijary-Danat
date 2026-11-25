-- 174_suppressed_receipts_stay_hidden.sql
-- إيصال العقد المكبوت يبقى مخفياً عن المستأجر مهما كان المسار الذي أنشأ الدفعة.
--
-- Migration 173 stopped the tenant portal from BUILDING a roof receipt and
-- stopped `notifyPaymentSuccess` from MAILING one. It did not stop the receipt
-- row from being born visible, and for seven of the eight roof tenants it is:
--
--   `tg_sync_payment_receipt` (migration 05) inserts the receipt with
--   `visible_to_tenant = coalesce(tenants.receipt_visible_to_tenant, false)`
--   the moment a payment reaches `confirmed` — and those seven tenants have
--   that flag set to true. The trigger fires on the PAYMENT, so it runs before
--   any `payment_allocations` row exists; at that instant nothing in the
--   database can yet say which contract the money settles.
--
-- `makeReceiptsVisibleToTenant` only ever writes `true`, so skipping a
-- suppressed payment there leaves the `true` the trigger already wrote. The
-- receipt stays readable through the receipts RLS policy.
--
-- The allocation is the first moment the contract is knowable, so that is where
-- the correction belongs. Putting it in SQL rather than in the webhook covers
-- every path that settles money — the gateway webhook, the admin's manual
-- payment (`usePayments`), the deposit sync of migration 153, and whatever
-- path is added next — instead of the one path we happened to think of.
--
-- ONLY ever hides. It must not write `true`, or it would override
-- `tenants.receipt_visible_to_tenant = false` for an ordinary contract and
-- start showing receipts the office chose to withhold.

create or replace function public.tg_hide_suppressed_receipt()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if exists (
    select 1
      from public.invoices i
      join public.contracts c on c.id = i.contract_id
     where i.id = new.invoice_id
       and c.suppress_tenant_billing_docs
  ) then
    update public.receipts
       set visible_to_tenant = false
     where payment_id = new.payment_id
       and visible_to_tenant;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_hide_suppressed_receipt() from public, anon;

drop trigger if exists hide_suppressed_receipt on public.payment_allocations;
create trigger hide_suppressed_receipt
after insert on public.payment_allocations
for each row execute function public.tg_hide_suppressed_receipt();

-- Existing rows: the eight contracts were flagged by migration 173 after their
-- receipts had already been created, so their allocations will never fire the
-- trigger above. Correct them once, here.
update public.receipts r
   set visible_to_tenant = false
 where r.visible_to_tenant
   and exists (
     select 1
       from public.payment_allocations pa
       join public.invoices i on i.id = pa.invoice_id
       join public.contracts c on c.id = i.contract_id
      where pa.payment_id = r.payment_id
        and c.suppress_tenant_billing_docs
   );
