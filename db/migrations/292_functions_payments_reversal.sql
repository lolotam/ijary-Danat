-- 292_functions_payments_reversal.sql
-- T035: function audit — payment/refund reversal, settlement revert, deposit sync.
-- Split from 281_functions_payments.sql (T052l) to keep each migration under 600 lines;
-- T052o: callable functions read the company from `public.current_company_id_strict()`,
-- which raises COMPANY_REQUIRED for an API role with no company. Trigger and internal
-- functions fall back to the row's own company_id; no API role can execute them. Idempotent.

-- يعكس دفعة مؤكدة ويعيد أرصدة الفواتير ضمن نطاق شركة المستدعي.
CREATE OR REPLACE FUNCTION public.reverse_payment(p_payment_id uuid, p_reason text)
 RETURNS TABLE(reversal_payment_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_original public.payments%rowtype;
  v_reversal_id uuid;
  v_allocation public.payment_allocations%rowtype;
  v_invoice public.invoices%rowtype;
  v_new_paid numeric(14,3);
  v_new_state public.invoice_states;
  v_grace_days integer;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'payments.reverse') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A reversal reason is required';
  end if;

  select p.* into v_original
    from public.payments p
   where p.id = p_payment_id
     and (v_caller_company is null or p.company_id = v_caller_company)
   for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_original.status <> 'confirmed' or v_original.reversed_by_payment_id is not null then
    raise exception 'Only an unreversed confirmed payment can be reversed';
  end if;
  if exists (
    select 1 from public.payments p
     where p.reversed_by_payment_id = v_original.id
       and p.company_id = v_original.company_id
       and p.status = 'reversed'
  ) then
    raise exception 'Payment has already been reversed';
  end if;

  insert into public.payments (
    code, company_id, tenant_id, account_type, method, amount, currency,
    payment_date, reference, unit_id, note, created_by, status, reversed_by_payment_id
  ) values (
    public.next_payment_code(), v_original.company_id, v_original.tenant_id,
    v_original.account_type, v_original.method, v_original.amount, v_original.currency,
    current_date, trim(p_reason), v_original.unit_id, trim(p_reason), auth.uid(),
    'reversed', v_original.id
  ) returning id into v_reversal_id;

  for v_allocation in
    select pa.* from public.payment_allocations pa
     where pa.payment_id = v_original.id and pa.company_id = v_original.company_id
     order by pa.invoice_id
  loop
    select i.* into v_invoice
      from public.invoices i
     where i.id = v_allocation.invoice_id and i.company_id = v_original.company_id
     for update;
    select c.grace_days into v_grace_days
      from public.contracts c where c.id = v_invoice.contract_id;

    v_new_paid := greatest(0, v_invoice.paid - v_allocation.amount);
    v_new_state := case
      when v_invoice.total = 0 or v_new_paid >= v_invoice.total then 'paid'::public.invoice_states
      when (v_invoice.due_date + coalesce(v_grace_days, 0)) < current_date then 'overdue'::public.invoice_states
      when v_new_paid > 0 then 'partially_paid'::public.invoice_states
      else 'due'::public.invoice_states
    end;

    update public.invoices i
       set paid = v_new_paid, state = v_new_state
     where i.id = v_invoice.id and i.company_id = v_original.company_id;
    insert into public.payment_allocations (company_id, payment_id, invoice_id, amount)
    values (v_original.company_id, v_reversal_id, v_invoice.id, v_allocation.amount);
  end loop;

  update public.payments p
     set status = 'reversed'
   where p.id = v_original.id and p.company_id = v_original.company_id;

  perform public.write_audit(
    'payment.reverse', 'payment', p_payment_id, null,
    jsonb_build_object('reason', trim(p_reason), 'reversal_payment_id', v_reversal_id)
  );

  reversal_payment_id := v_reversal_id;
  return next;
end;
$function$;

-- يعكس سجل استرداد مرحّل ضمن نطاق شركة المستدعي.
CREATE OR REPLACE FUNCTION public.reverse_refund(p_refund_id uuid, p_reason text)
 RETURNS TABLE(reversal_refund_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_original public.refunds%rowtype;
  v_reversal_id uuid;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'refunds.reverse') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A reversal reason is required';
  end if;

  select r.* into v_original
    from public.refunds r
   where r.id = p_refund_id
     and (v_caller_company is null or r.company_id = v_caller_company)
   for update;
  if not found then raise exception 'Refund not found'; end if;
  if v_original.status <> 'posted' or v_original.reversal_of_id is not null then
    raise exception 'Only an unreversed posted refund can be reversed';
  end if;
  if exists (
    select 1 from public.refunds r
     where r.reversal_of_id = v_original.id
       and r.company_id = v_original.company_id
       and r.status = 'reversed'
  ) then
    raise exception 'Refund has already been reversed';
  end if;

  insert into public.refunds (
    code, company_id, contract_id, tenant_id, unit_id, building_id,
    amount, currency, refund_date, reason, post_action, note, created_by,
    status, reversal_of_id
  ) values (
    public.next_refund_code(), v_original.company_id, v_original.contract_id,
    v_original.tenant_id, v_original.unit_id, v_original.building_id,
    v_original.amount, v_original.currency, current_date, trim(p_reason),
    v_original.post_action, v_original.note, auth.uid(),
    'reversed', v_original.id
  ) returning id into v_reversal_id;

  update public.refunds r
     set status = 'reversed'
   where r.id = v_original.id and r.company_id = v_original.company_id;

  perform public.write_audit(
    'refund.reverse', 'refund', v_original.id, to_jsonb(v_original),
    jsonb_build_object('reversal_id', v_reversal_id), 'success', null
  );

  if v_original.contract_id is not null then
    insert into public.contract_operational_events (
      company_id, contract_id, tenant_id, event_type, actor_id, payload, note
    ) values (
      v_original.company_id, v_original.contract_id, v_original.tenant_id,
      'refund_reversed', auth.uid(),
      jsonb_build_object('refund_id', v_original.id, 'reversal_id', v_reversal_id, 'amount', v_original.amount),
      trim(p_reason)
    );
  end if;

  reversal_refund_id := v_reversal_id;
  return next;
end;
$function$;

-- يتراجع عن تسوية الإيداع بحذف الدفعة المولدة ضمن الشركة (داخلي للمحفّزات فقط).
CREATE OR REPLACE FUNCTION public.revert_deposit_settlement(p_deposit_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_payment_id uuid;
  v_invoice_id uuid;
begin

  select p.id into v_payment_id
    from public.payments p
   where p.source_deposit_id = p_deposit_id
     and (v_company_id is null or p.company_id = v_company_id);
  if v_payment_id is null then return null; end if;

  select pa.invoice_id into v_invoice_id
    from public.payment_allocations pa
   where pa.payment_id = v_payment_id limit 1;

  delete from public.receipts r where r.payment_id = v_payment_id;
  delete from public.payment_allocations pa where pa.payment_id = v_payment_id;
  delete from public.payments p where p.id = v_payment_id;

  if v_invoice_id is not null then
    perform public.recompute_invoice_from_confirmed(v_invoice_id);
  end if;
  return v_invoice_id;
end;
$function$;

-- يتراجع عن تسوية الدفعة الجزئية بحذف الدفعة المولدة ضمن الشركة (داخلي للمحفّزات فقط).
CREATE OR REPLACE FUNCTION public.revert_partial_payment_settlement(p_partial_payment_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_payment_id uuid;
  v_invoice_id uuid;
begin

  select p.id into v_payment_id
    from public.payments p
   where p.source_partial_payment_id = p_partial_payment_id
     and (v_company_id is null or p.company_id = v_company_id);
  if v_payment_id is null then return null; end if;

  select pa.invoice_id into v_invoice_id
    from public.payment_allocations pa
   where pa.payment_id = v_payment_id limit 1;

  delete from public.receipts r where r.payment_id = v_payment_id;
  delete from public.payment_allocations pa where pa.payment_id = v_payment_id;
  delete from public.payments p where p.id = v_payment_id;

  return v_invoice_id;
end;
$function$;

-- يزامن قيمة التأمين في العقد من سجل التأمين ضمن شركة المستدعي.
CREATE OR REPLACE FUNCTION public.sync_contract_deposit_from_insurance(p_insurance_id uuid)
 RETURNS contracts
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_row public.contracts;
  v_contract_id uuid;
  v_company_id uuid;
  v_amount numeric;
  v_old numeric;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'insurance.create')
     and not public.has_permission(auth.uid(), 'insurance.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select ip.contract_id, ip.company_id, ip.amount
    into v_contract_id, v_company_id, v_amount
    from public.insurance_payments ip
   where ip.id = p_insurance_id
     and (v_caller_company is null or ip.company_id = v_caller_company);
  if v_contract_id is null then
    raise exception 'Insurance record not found';
  end if;

  select * into v_row
    from public.contracts
   where id = v_contract_id and company_id = v_company_id
   for update;
  if v_row.id is null then
    raise exception 'Contract not found';
  end if;
  if v_row.deposit = v_amount then
    return v_row;
  end if;

  v_old := v_row.deposit;
  update public.contracts
     set deposit = v_amount, updated_at = now()
   where id = v_contract_id and company_id = v_company_id
  returning * into v_row;

  perform public.write_audit(
    'contract.deposit.sync_from_insurance', 'contract', v_contract_id,
    jsonb_build_object('deposit', v_old),
    jsonb_build_object('deposit', v_amount, 'insurance_id', p_insurance_id)
  );
  return v_row;
end;
$function$;


REVOKE ALL ON FUNCTION public.revert_deposit_settlement(uuid) FROM PUBLIC, anon, authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.revert_partial_payment_settlement(uuid) FROM PUBLIC, anon, authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.reverse_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_payment(uuid, text) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.reverse_refund(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_refund(uuid, text) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.sync_contract_deposit_from_insurance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_contract_deposit_from_insurance(uuid) TO authenticated, company_service, service_role;
