-- 214_hidden_contracts_receipts_and_payments.sql
--
-- إخفاء العقد عن البوابة يُخفي إيصالاته أيضًا، ويُميّز دفعاته عن الدفعات التي
-- تعذّر حلّ فواتيرها لسبب آخر.
--
-- Review round 3 on PR #209, two findings that live in the same place: what the
-- tenant can still reach once a contract is hidden.
--
-- 1. RECEIPTS. `receipts_select_allowed` (migration 05) authorises a tenant read
--    purely on `receipts.visible_to_tenant`, and the two corrective triggers
--    from migrations 174 and 175 only ever look at
--    `suppress_tenant_billing_docs`. Today every hidden contract also carries
--    that older flag, so nothing is exposed — but the whole point of migration
--    210 was that a ninth roof contract flips one switch. Hidden without
--    suppressed would keep serving `html_snapshot` over REST, which is the
--    printable receipt in full.
--
--    174's trigger fires on the allocation (the first moment the contract is
--    knowable); 175's fires when the flag is switched on for a contract whose
--    allocations already exist. Both cases need covering for the new flag, so
--    174's function gains the second column and 175's function — which reads
--    only `new.id` and never names a column — gains a second trigger. Then one
--    backfill, for contracts hidden before this migration ran.
--
--    Only ever HIDES, exactly as 174 and 175 say: turning the flag back off
--    does not reveal receipts again, because `tenants.receipt_visible_to_tenant`
--    is the office's own decision and these triggers have no business
--    overruling it in the permissive direction.
--
-- 2. PAYMENTS THE PORTAL CANNOT RESOLVE. Migration 212 stops a tenant reading a
--    hidden contract's invoices, so a payment that settled only that contract
--    arrives in the portal with allocations that resolve to nothing. The client
--    was dropping any such payment — but an invoice can also fail to resolve
--    because an admin set `is_visible_to_tenant = false`, which has nothing to
--    do with roofs, and those payments must stay in the tenant's history.
--
--    The client cannot tell the two apart: both look like an unreadable
--    invoice. `portal_hidden_payment_ids` answers the question on the server,
--    and returns nothing the caller does not already own — only ids of the
--    tenant's own payments, and only to say "this one is not shown".

begin;

-- يُخفي إيصال الدفعة عند أول تخصيص لها على فاتورة عقد مكبوت أو مخفي عن البوابة.
--
-- 174's function, with the new flag alongside the old one. The allocation is
-- the first moment the contract is knowable, which is why the correction lives
-- on this trigger rather than on the payment.
create or replace function public.tg_hide_suppressed_receipt()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if exists (
    select 1
      from public.invoices i
      join public.contracts c on c.id = i.contract_id
     where i.id = new.invoice_id
       and (c.suppress_tenant_billing_docs or c.hide_from_portal)
  ) then
    update public.receipts
       set visible_to_tenant = false
     where payment_id = new.payment_id
       and visible_to_tenant;
  end if;
  return new;
end;
$$;

comment on function public.tg_hide_suppressed_receipt() is
  'يُخفي إيصال الدفعة عند أول تخصيص لها على فاتورة عقد مكبوت أو مخفي عن البوابة. Hides a payment''s receipt at the first allocation onto an invoice of a contract that is suppressed or hidden from the portal. Only ever hides - writing true here would override the office''s own receipt_visible_to_tenant decision.';

revoke all on function public.tg_hide_suppressed_receipt() from public, anon;

-- 175's function is reused verbatim: its body reads only `new.id` and never
-- names the column that fired it, so a second trigger is the whole change.
drop trigger if exists hide_receipts_on_portal_hide_enabled on public.contracts;
create trigger hide_receipts_on_portal_hide_enabled
after update of hide_from_portal on public.contracts
for each row
when (new.hide_from_portal and not old.hide_from_portal)
execute function public.tg_hide_receipts_on_suppression_enabled();

-- Contracts hidden before this migration ran: their allocations predate the
-- trigger above and migration 210's seed predates this one, so correct them
-- once, here. Same shape as 174's own backfill.
update public.receipts r
   set visible_to_tenant = false
 where r.visible_to_tenant
   and exists (
     select 1
       from public.payment_allocations pa
       join public.invoices i on i.id = pa.invoice_id
       join public.contracts c on c.id = i.contract_id
      where pa.payment_id = r.payment_id
        and c.hide_from_portal
   );

-- يُرجع معرّفات دفعات المستأجر التي خُصّصت بالكامل على عقود مخفية عن البوابة،
-- ولم يتبقَّ منها مبلغ غير مخصَّص.
--
-- Answered on the server because the client cannot tell a hidden lease from an
-- invoice it may not read for some other reason — both arrive as an allocation
-- whose invoice will not resolve.
create or replace function public.portal_hidden_payment_ids(p_tenant_id uuid)
returns setof uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_tenant_id is null then
    raise exception 'Tenant is required';
  end if;

  -- Auth guard: re-stated from `evaluate_portal_payable_invoices`. This returns
  -- only ids of payments the caller already owns, but "already owns" is exactly
  -- what has to be checked.
  if auth.role() = 'authenticated' and not (
    public.is_staff(auth.uid()) or (
      public.has_role(auth.uid(), 'tenant') and exists (
        select 1
        from public.profiles p
        where p.id = auth.uid() and p.tenant_id = p_tenant_id
      )
    )
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  select p.id
  from public.payments p
  where p.tenant_id = p_tenant_id
    -- A payment with no allocations at all is the tenant's own money sitting
    -- unapplied. It has no lease to be hidden by, and it stays in their history.
    and exists (select 1 from public.payment_allocations pa where pa.payment_id = p.id)
    -- So is a PARTLY unapplied one, which review round 4 on PR #209 caught:
    -- `apply_payment_allocation` only refuses allocations whose total exceeds
    -- the payment, so KWD 300 of a KWD 500 payment may sit on a hidden lease
    -- with KWD 200 still unapplied. Hiding the whole payment would take that
    -- remainder out of the tenant's sight along with it.
    and p.amount <= (
      select coalesce(sum(pa.amount), 0)
      from public.payment_allocations pa
      where pa.payment_id = p.id
    )
    and not exists (
      select 1
      from public.payment_allocations pa
      join public.invoices i on i.id = pa.invoice_id
      join public.contracts c on c.id = i.contract_id
      where pa.payment_id = p.id
        and not coalesce(c.hide_from_portal, false)
    );
end;
$$;

comment on function public.portal_hidden_payment_ids(uuid) is
  'يُرجع معرّفات دفعات المستأجر التي خُصّصت بالكامل على عقود مخفية عن البوابة. Returns the ids of a tenant''s payments whose every allocation settles a hide_from_portal contract, so the portal can drop exactly those and keep payments whose invoices are unreadable for other reasons - an admin-set is_visible_to_tenant = false, say.';

revoke all on function public.portal_hidden_payment_ids(uuid) from public, anon;
grant execute on function public.portal_hidden_payment_ids(uuid) to authenticated, service_role;

commit;
