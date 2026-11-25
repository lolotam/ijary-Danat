-- 151_partial_payment_tenant_guard_and_atomic_insurance_delete.sql
--
-- Two review findings against migrations 147 and 150. A new file rather than an
-- edit to those: both were already applied to production, and editing an applied
-- migration changes nothing on a database that has already run it.

------------------------------------------------------------
-- 1. The link guard has to check the tenant too
------------------------------------------------------------

-- 147 compared `contract_id` against the linked invoice and stopped there.
-- `partial_payments.tenant_id` is a third independent foreign key, so a row can
-- name tenant A while pointing at an invoice that belongs to tenant B — and the
-- status trigger would then move a row filed under the wrong tenant. The tenant
-- detail tab reads by `tenant_id`, so the mismatch is visible to the wrong
-- person, not merely untidy.
--
-- `tenant_id` also joins the trigger's UPDATE OF list. Without it a tenant-only
-- update slips past the guard entirely — the one edit that can *introduce* this
-- mismatch was the one edit that did not fire the check.
create or replace function public.tg_partial_payments_link_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_invoice_state text;
  v_invoice_contract uuid;
  v_invoice_tenant uuid;
begin
  if new.invoice_id is null then
    return new;
  end if;

  select i.state::text, i.contract_id, i.tenant_id
    into v_invoice_state, v_invoice_contract, v_invoice_tenant
    from public.invoices i
   where i.id = new.invoice_id;

  if not found then
    raise exception 'partial_payment_invoice_not_found' using errcode = '23503';
  end if;

  if new.contract_id is not null and v_invoice_contract is distinct from new.contract_id then
    raise exception 'partial_payment_invoice_contract_mismatch' using errcode = '23514';
  end if;

  if new.tenant_id is distinct from v_invoice_tenant then
    raise exception 'partial_payment_invoice_tenant_mismatch' using errcode = '23514';
  end if;

  new.status := case when v_invoice_state = 'paid' then 'complete' else 'incomplete' end;
  return new;
end;
$fn$;

drop trigger if exists partial_payments_link_guard on public.partial_payments;
create trigger partial_payments_link_guard
  before insert or update of invoice_id, contract_id, tenant_id, status
  on public.partial_payments
  for each row
  execute function public.tg_partial_payments_link_guard();

------------------------------------------------------------
-- 2. Delete and capture in one statement
------------------------------------------------------------

-- 150 selected the holding, then deleted it. Two concurrent calls can both pass
-- the select; the second deletes nothing and still writes an audit row claiming
-- a deletion it did not perform — the audit trail is the whole justification for
-- this feature, so a false entry in it is worse than a missing one.
--
-- `delete … returning` makes the read and the write one statement, so exactly
-- one caller sees the row and only that caller audits.
create or replace function public.delete_contract_insurance(p_contract_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $fn$
declare
  v_row public.insurance_payments;
begin
  -- SECURITY DEFINER bypasses the RLS policy that would otherwise enforce this,
  -- so the check has to be made explicitly. Roles are customisable, so the
  -- permission is the authority, not a role name.
  if not public.has_permission(auth.uid(), 'insurance.delete') then
    raise exception 'insurance_delete_forbidden' using errcode = '42501';
  end if;

  delete from public.insurance_payments
   where contract_id = p_contract_id
  returning * into v_row;

  -- No holding is not a failure: a contract whose insurance was always zero has
  -- nothing to remove, and the caller reports "unchanged".
  if v_row.id is null then
    return false;
  end if;

  perform public.write_audit(
    'insurance_payments.delete',
    'insurance_payments',
    v_row.id,
    to_jsonb(v_row),
    null
  );

  return true;
end;
$fn$;

revoke all on function public.delete_contract_insurance(uuid) from public, anon;
grant execute on function public.delete_contract_insurance(uuid) to authenticated, service_role;
