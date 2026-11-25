-- 129 - chronological order when marking an invoice paid
--
-- Admin mark-as-paid had no ordering check. The portal and the KNET link
-- generator already refuse a non-prefix selection via
-- evaluate_portal_payable_invoices; this path did not.
--
-- The hard invariant lives HERE, not in a TypeScript pre-check: setInvoicePaid
-- receives only { invoiceId, paid, reason }, a client-supplied contract id
-- could not be trusted, and a check-then-pay race would let two admins mark
-- later invoices in parallel. The tenant, contract and period are taken from
-- the locked invoice row in the same transaction.
--
-- Scope is PER CONTRACT, even though the KNET link button in the same table
-- is tenant-wide. That is a product decision, not an oversight: a tenant with
-- two shops can have shop B's March marked paid while shop A's January is
-- unpaid. Do not "harmonise" this with the portal.
--
-- The guard runs ONLY when p_paid is true. Marking unpaid stays unrestricted
-- so an admin who marked the wrong invoice paid can undo it.
--
-- Body copied from db/migrations/108_manual_payment_reason.sql (the highest-
-- numbered, therefore live, definition) then the guard inserted after the
-- lock and the zero-balance early return.

create or replace function public.set_invoice_paid(
  p_invoice_id uuid,
  p_paid boolean,
  p_manual_payment_reason text default null
)
returns table (payment_id uuid, invoice_state text)
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_tenant public.tenants%rowtype;
  v_reference text;
  v_payment_id uuid;
  v_payment record;
  v_new_paid numeric(14,3);
  v_new_state public.invoice_states;
  v_grace integer;
  v_method public.payment_methods;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select i.* into v_invoice from public.invoices i where i.id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  select t.* into v_tenant from public.tenants t where t.id = v_invoice.tenant_id;
  v_reference := 'AUTO-INV:' || v_invoice.code;

  if p_paid then
    if v_invoice.balance <= 0 then
      return query select null::uuid, v_invoice.state::text;
      return;
    end if;

    -- Same contract, earlier period, still payable. Waived/cancelled are not
    -- unpaid; a later invoice on a different contract is not this contract's
    -- debt. Compared as (year, month) so January always precedes February
    -- regardless of due_date quirks.
    if exists (
      select 1
      from public.invoices earlier
      where earlier.contract_id = v_invoice.contract_id
        and earlier.id <> v_invoice.id
        and earlier.balance > 0
        and earlier.state in ('due', 'overdue', 'partially_paid')
        and (earlier.period_year, earlier.period_month)
            < (v_invoice.period_year, v_invoice.period_month)
    ) then
      raise exception 'Invoices must be paid in chronological order.';
    end if;

    -- The reason decides how the money is recorded as having arrived. An
    -- unmapped or unknown reason falls back to 'cash', which is exactly what
    -- migration 23 always did, so a hand-added reason cannot break settlement.
    select (oli.metadata ->> 'payment_method')::public.payment_methods
      into v_method
    from public.option_list_items oli
    join public.option_lists ol on ol.id = oli.list_id
    where ol.code = 'manual_payment_reasons'
      and oli.value = p_manual_payment_reason
      and oli.is_active;
    v_method := coalesce(v_method, 'cash'::public.payment_methods);

    insert into public.payments (
      code, company_id, tenant_id, unit_id, account_type, method, amount, currency,
      payment_date, reference, note, status
    ) values (
      public.next_payment_code(), v_tenant.company_id, v_invoice.tenant_id, v_invoice.unit_id,
      'commercial_account', v_method, v_invoice.balance, 'KWD',
      -- Dated inside the invoice's own period so month-by-month reporting lines up.
      least(v_invoice.due_date, current_date),
      v_reference, 'Marked paid from invoice ' || v_invoice.code, 'confirmed'
    )
    returning payments.id into v_payment_id;

    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (v_payment_id, v_invoice.id, v_invoice.balance);
  else
    -- Remove only the auto-created payments for this invoice.
    for v_payment in
      select p.id from public.payments p
      where p.tenant_id = v_invoice.tenant_id and p.reference = v_reference
    loop
      -- A confirmed payment gets a receipt from a trigger; drop it first or
      -- the receipts FK blocks the delete.
      delete from public.receipts r where r.payment_id = v_payment.id;
      delete from public.payment_allocations pa where pa.payment_id = v_payment.id;
      delete from public.payments p where p.id = v_payment.id;
    end loop;
    v_payment_id := null;
  end if;

  -- Recompute the invoice from its surviving allocations.
  select coalesce(sum(pa.amount), 0) into v_new_paid
  from public.payment_allocations pa where pa.invoice_id = v_invoice.id;
  select c.grace_days into v_grace from public.contracts c where c.id = v_invoice.contract_id;

  v_new_state := case
    when v_new_paid >= v_invoice.total then 'paid'
    when v_new_paid > 0 then 'partially_paid'
    when (v_invoice.due_date + coalesce(v_grace, 0)) < current_date then 'overdue'
    else 'due'
  end;

  -- `balance` is a generated column (total - paid); assigning it is rejected.
  -- payment_method is owned by trg_invoice_payment_method and deliberately not
  -- set here; the reason is cleared on the way out because an invoice nobody
  -- settled by hand has no reason for having been settled by hand.
  update public.invoices i
    set paid = v_new_paid,
        state = v_new_state,
        manual_payment_reason = case when p_paid then p_manual_payment_reason else null end
    where i.id = v_invoice.id;

  return query select v_payment_id, v_new_state::text;
end;
$$;

-- Grants do NOT carry across a replace of a SECURITY DEFINER function in a way
-- we can rely on: anon holds its own grant separate from PUBLIC (migration 96).
revoke all on function public.set_invoice_paid(uuid, boolean, text) from public, anon;
grant execute on function public.set_invoice_paid(uuid, boolean, text) to authenticated, service_role;
