-- ---------------------------------------------------------------------------
-- 190. Reassigning a contract's tenant must carry its financial records along
--
-- `tenant_id` is denormalised onto invoices, payments and receipts at creation
-- time, and nothing propagated a later change on the contract. Editing the
-- tenant of CON-00084 on 2026-09-06 moved the contract alone and left 34
-- invoices (42,500.000 KWD, 7,500.000 of it paid), 6 payments and 6 receipts
-- filed under the previous tenant — invisible on the new tenant's statement
-- and still counted against the old one's balance.
--
-- The read paths use these copies rather than joining back through contracts,
-- so the stale rows are not a cosmetic drift. The `invoices_select_allowed`
-- RLS policy (migration 05) matches profiles.tenant_id against
-- invoices.tenant_id, so the new tenant's portal user cannot see their own
-- invoices at all; overdueRemindersJob groups by invoice.tenant_id, so the
-- chasing goes to whoever the stale copy names.
-- ---------------------------------------------------------------------------

/**
 * ينقل الفواتير والمدفوعات والإيصالات الخاصة بعقد ما إلى المستأجر الجديد
 * عند تغيير المستأجر المرتبط بالعقد.
 *
 * Only the ownership label moves. Amounts, allocations, invoice codes and
 * receipt codes are deliberately untouched — a receipt the tenant already
 * holds must keep the number printed on it.
 *
 * Scoped by contract, never by tenant: a tenant reassigning one of several
 * contracts must keep the records of the others.
 */
create or replace function public.reassign_contract_tenant_records(
  _contract uuid,
  _old_tenant uuid,
  _new_tenant uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  -- payment_allocations is the only link between a payment and the contract it
  -- settled, and the same set drives both the payments and the receipts update.
  _settling_payments uuid[];
begin
  select array_agg(distinct pa.payment_id)
    into _settling_payments
    from public.payment_allocations pa
    join public.invoices i on i.id = pa.invoice_id
   where i.contract_id = _contract;

  update public.invoices
     set tenant_id = _new_tenant
   where contract_id = _contract
     and tenant_id = _old_tenant;

  update public.payments
     set tenant_id = _new_tenant
   where tenant_id = _old_tenant
     and id = any(_settling_payments);

  update public.receipts
     set tenant_id = _new_tenant
   where tenant_id = _old_tenant
     and payment_id = any(_settling_payments);

  -- Notifications carry a tenant_id too, and are deliberately left alone: they
  -- record what was sent to whom at the time. Rewriting them would claim the
  -- new tenant received mail that went to the old one's address.
end;
$$;

/**
 * يستدعي نقل السجلات المالية بعد تغيير المستأجر على العقد.
 */
create or replace function public.tg_contract_propagate_tenant_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.reassign_contract_tenant_records(
    new.id, old.tenant_id, new.tenant_id
  );

  return new;
end;
$$;

drop trigger if exists trg_contract_propagate_tenant_change on public.contracts;
create trigger trg_contract_propagate_tenant_change
  after update of tenant_id on public.contracts
  for each row
  when (new.tenant_id is distinct from old.tenant_id)
  execute function public.tg_contract_propagate_tenant_change();

revoke execute on function public.tg_contract_propagate_tenant_change() from public, anon;
revoke execute on function public.reassign_contract_tenant_records(uuid, uuid, uuid) from public, anon;
