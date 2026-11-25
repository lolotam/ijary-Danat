-- 175_hide_receipts_when_suppression_enabled.sql
-- تفعيل الكبت على عقد قائم يُخفي إيصالاته الموجودة، لا الجديدة فقط.
--
-- Migration 174 hides a receipt when an allocation NAMES a suppressed contract.
-- That covers money settled from now on, and its one-off backfill covered the
-- eight contracts flagged by migration 173. It leaves one gap, and it is
-- precisely the case the admin toggle was added for:
--
--   an admin flips `suppress_tenant_billing_docs` on for a NINTH roof contract
--   next month. Its allocations already exist, so 174's trigger will never fire
--   for them, and 173's backfill has long since run. Every receipt that
--   contract already has stays `visible_to_tenant = true`, and the receipts RLS
--   policy keeps letting the tenant read the snapshot.
--
-- So the flag needs the same correction applied at the moment it is ENABLED.
-- Together the two triggers cover both orders of events: allocation after
-- suppression (174) and suppression after allocation (this one).
--
-- Placed on the table rather than inside `save_contract_with_units` for the
-- reason migration 174 gave: the RPC is not the only writer, and a flag set by
-- a future admin screen, a bulk import or a hand-run UPDATE must behave the
-- same way.
--
-- Only ever HIDES. Turning suppression back OFF deliberately does NOT reveal
-- the receipts again: `tenants.receipt_visible_to_tenant` is the office's own
-- decision about whether a tenant sees receipts at all, and this trigger has no
-- business overruling it in the permissive direction. Re-showing a specific
-- receipt stays a manual act.

create or replace function public.tg_hide_receipts_on_suppression_enabled()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  update public.receipts r
     set visible_to_tenant = false
   where r.visible_to_tenant
     and exists (
       select 1
         from public.payment_allocations pa
         join public.invoices i on i.id = pa.invoice_id
        where pa.payment_id = r.payment_id
          and i.contract_id = new.id
     );
  return null;
end;
$$;

revoke all on function public.tg_hide_receipts_on_suppression_enabled() from public, anon;

drop trigger if exists hide_receipts_on_suppression_enabled on public.contracts;
create trigger hide_receipts_on_suppression_enabled
after update of suppress_tenant_billing_docs on public.contracts
for each row
when (new.suppress_tenant_billing_docs and not old.suppress_tenant_billing_docs)
execute function public.tg_hide_receipts_on_suppression_enabled();
