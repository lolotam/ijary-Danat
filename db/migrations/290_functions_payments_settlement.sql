-- 290_functions_payments_settlement.sql
-- T035: function audit — deposit/partial settlement and payment allocation.
-- Split from 281_functions_payments.sql (T052l) to keep each migration under 600 lines;
-- T052o: callable functions read the company from `public.current_company_id_strict()`,
-- which raises COMPANY_REQUIRED for an API role with no company. Trigger and internal
-- functions fall back to the row's own company_id; no API role can execute them. Idempotent.

-- يسوّي الإيداع المؤكد إلى دفعة وتوزيع ضمن شركة الإيداع (داخلي للمحفّزات فقط).
CREATE OR REPLACE FUNCTION public.apply_deposit_settlement(p_deposit_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_deposit public.deposits%rowtype;
  v_invoice public.invoices%rowtype;
  v_company_id uuid;
  v_amount numeric(14,3);
  v_payment_id uuid;
begin

  select d.* into v_deposit from public.deposits d where d.id = p_deposit_id;
  if not found or v_deposit.invoice_id is null or v_deposit.status <> 'confirmed' then
    return null;
  end if;

  v_company_id := coalesce(public.current_company_id(), v_deposit.company_id);
  if v_deposit.company_id <> v_company_id then
    raise exception 'deposit_company_mismatch' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_deposit.contract_id::text, 0));

  select i.* into v_invoice
    from public.invoices i
   where i.id = v_deposit.invoice_id and i.company_id = v_company_id
   for update;
  if not found then return null; end if;

  if v_invoice.state in ('cancelled', 'waived') then
    raise exception 'deposit_invoice_terminal_state' using errcode = '23514';
  end if;
  if v_invoice.balance <= 0 then
    return v_invoice.id;
  end if;

  if exists (
    select 1 from public.invoices earlier
     where earlier.contract_id = v_invoice.contract_id
       and earlier.company_id = v_company_id
       and earlier.id <> v_invoice.id
       and earlier.balance > 0
       and earlier.state in ('due', 'overdue', 'partially_paid')
       and (earlier.period_year, earlier.period_month)
           < (v_invoice.period_year, v_invoice.period_month)
  ) then
    raise exception 'deposit_invoice_out_of_order' using errcode = '23514';
  end if;

  v_amount := least(v_deposit.amount, v_invoice.balance);

  insert into public.payments (
    code, company_id, tenant_id, unit_id, account_type, method, amount, currency,
    payment_date, reference, note, status, source_deposit_id
  ) values (
    public.next_payment_code(), v_company_id, v_invoice.tenant_id, v_invoice.unit_id,
    'commercial_account',
    case when v_deposit.deposit_type = 'cheque'
      then 'cheque'::public.payment_methods
      else 'cash'::public.payment_methods end,
    v_amount, 'KWD', v_deposit.deposit_date,
    v_deposit.code, 'Settled from bank deposit ' || v_deposit.code, 'confirmed',
    v_deposit.id
  )
  on conflict (source_deposit_id) where source_deposit_id is not null do nothing
  returning payments.id into v_payment_id;

  if v_payment_id is null then
    return v_invoice.id;
  end if;

  insert into public.payment_allocations (company_id, payment_id, invoice_id, amount)
  values (v_company_id, v_payment_id, v_invoice.id, v_amount);

  update public.receipts r
     set html_snapshot = public.receipt_html_for_payment(v_payment_id)
   where r.payment_id = v_payment_id and r.company_id = v_company_id;

  perform public.recompute_invoice_from_confirmed(v_invoice.id);
  return v_invoice.id;
end;
$function$;

-- غلاف داخلي لتسوية الدفعة الجزئية بالخيارات الافتراضية (للمحفّزات فقط).
CREATE OR REPLACE FUNCTION public.apply_partial_payment_settlement(p_partial_payment_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
begin
  -- Only delegates: the three-argument version below holds the company check.
  return public.apply_partial_payment_settlement(p_partial_payment_id, false, false);
end;
$function$;

-- يسوّي الدفعة الجزئية إلى دفعة وتوزيع ضمن نفس الشركة (داخلي للمحفّزات فقط).
CREATE OR REPLACE FUNCTION public.apply_partial_payment_settlement(
  p_partial_payment_id uuid,
  p_correction boolean,
  p_skip_order_check boolean
)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_partial public.partial_payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_company_id uuid;
  v_invoice_contract uuid;
  v_payment_id uuid;
  v_note text;
begin

  select pp.* into v_partial
    from public.partial_payments pp where pp.id = p_partial_payment_id;
  if not found or v_partial.invoice_id is null then
    return null;
  end if;

  v_company_id := coalesce(public.current_company_id(), v_partial.company_id);
  if v_partial.company_id <> v_company_id then
    raise exception 'partial_payment_company_mismatch' using errcode = '42501';
  end if;

  select i.contract_id into v_invoice_contract
    from public.invoices i
   where i.id = v_partial.invoice_id and i.company_id = v_company_id;
  if v_invoice_contract is null then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_invoice_contract::text, 0));

  select i.* into v_invoice
    from public.invoices i
   where i.id = v_partial.invoice_id and i.company_id = v_company_id
   for update;
  if not found then return null; end if;

  if v_invoice.state in ('cancelled', 'waived') then
    raise exception 'partial_payment_invoice_terminal_state' using errcode = '23514';
  end if;
  if v_partial.amount > v_invoice.balance then
    raise exception 'partial_payment_exceeds_balance' using errcode = '23514';
  end if;

  if not p_skip_order_check and exists (
    select 1 from public.invoices earlier
     where earlier.contract_id = v_invoice.contract_id
       and earlier.company_id = v_company_id
       and earlier.id <> v_invoice.id
       and earlier.balance > 0
       and earlier.state in ('due', 'overdue', 'partially_paid')
       and (earlier.period_year, earlier.period_month)
           < (v_invoice.period_year, v_invoice.period_month)
  ) then
    raise exception 'partial_payment_invoice_out_of_order' using errcode = '23514';
  end if;

  v_note := 'Settled from partial payment on invoice ' || v_invoice.code;
  if p_correction then
    v_note := v_note || ' (corrected)';
  end if;

  insert into public.payments (
    code, company_id, tenant_id, unit_id, account_type, method, amount, currency,
    payment_date, note, status, source_partial_payment_id
  ) values (
    public.next_payment_code(), v_company_id, v_invoice.tenant_id, v_invoice.unit_id,
    'commercial_account', 'cash', v_partial.amount, 'KWD',
    v_partial.paid_date, v_note, 'confirmed', v_partial.id
  )
  on conflict (source_partial_payment_id) where source_partial_payment_id is not null
  do nothing
  returning payments.id into v_payment_id;

  if v_payment_id is null then
    return v_invoice.id;
  end if;

  insert into public.payment_allocations (company_id, payment_id, invoice_id, amount)
  values (v_company_id, v_payment_id, v_invoice.id, v_partial.amount);

  update public.receipts r
     set html_snapshot = public.receipt_html_for_payment(v_payment_id)
   where r.payment_id = v_payment_id and r.company_id = v_company_id;

  perform public.recompute_invoice_from_confirmed(v_invoice.id);
  return v_invoice.id;
end;
$function$;

-- يوزّع مبلغ الدفعة المؤكدة على الفواتير مع التحقق من نطاق الشركة وصلاحية الدفع.
CREATE OR REPLACE FUNCTION public.apply_payment_allocation(p_payment_id uuid, p_allocations jsonb)
 RETURNS TABLE(invoice_id uuid, applied numeric, new_state text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_payment public.payments%rowtype;
  v_allocation record;
  v_invoice public.invoices%rowtype;
  v_allocated numeric(14,3);
  v_requested numeric(14,3);
  v_new_paid numeric(14,3);
  v_new_state public.invoice_states;
  v_grace_days integer;
  v_blocked_code text;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'payments.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Allocations must be a non-empty JSON array';
  end if;

  select p.* into v_payment
    from public.payments p
   where p.id = p_payment_id
     and (v_caller_company is null or p.company_id = v_caller_company)
   for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_payment.status <> 'confirmed' then
    raise exception 'Only confirmed payments can be allocated';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
    where x.invoice_id is null or x.amount is null or x.amount <= 0
  ) then
    raise exception 'Every allocation requires an invoice and a positive amount';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
    group by x.invoice_id having count(*) > 1
  ) then
    raise exception 'Duplicate invoice allocation';
  end if;

  select coalesce(sum(pa.amount), 0) into v_allocated
    from public.payment_allocations pa
   where pa.payment_id = p_payment_id and pa.company_id = v_payment.company_id;
  select coalesce(sum(x.amount), 0) into v_requested
    from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric);
  if v_allocated + v_requested > v_payment.amount then
    raise exception 'Allocations exceed the remaining payment amount';
  end if;

  -- Direct authenticated sessions must settle oldest open invoice first;
  -- service_role and company_service webhook/worker paths remain exempt.
  if auth.role() = 'authenticated' then
    with requested as (
      select x.invoice_id, x.amount
      from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
    )
    select target.code into v_blocked_code
      from public.invoices target
      join requested r on r.invoice_id = target.id
     where target.company_id = v_payment.company_id
       and exists (
         select 1
           from public.invoices earlier
           left join requested paid_now on paid_now.invoice_id = earlier.id
          where earlier.contract_id = target.contract_id
            and earlier.company_id = v_payment.company_id
            and earlier.id <> target.id
            and earlier.state not in ('cancelled', 'waived')
            and round((earlier.balance - coalesce(paid_now.amount, 0)) * 1000) > 0
            and (earlier.period_year, earlier.period_month)
                < (target.period_year, target.period_month)
       )
     order by target.period_year, target.period_month, target.code
     limit 1;
    if v_blocked_code is not null then
      raise exception
        'Settle the oldest open invoice first: an earlier month is still unpaid (invoice %).',
        v_blocked_code;
    end if;
  end if;

  for v_allocation in
    select x.invoice_id, x.amount
      from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
     order by x.invoice_id
  loop
    select i.* into v_invoice
      from public.invoices i
     where i.id = v_allocation.invoice_id
       and i.company_id = v_payment.company_id
     for update;
    if not found then raise exception 'Invoice not found'; end if;
    if v_invoice.tenant_id <> v_payment.tenant_id then
      raise exception 'Invoice and payment tenants do not match';
    end if;
    if v_invoice.state in ('cancelled', 'waived') then
      raise exception 'Cancelled or waived invoices cannot receive allocations';
    end if;
    if v_allocation.amount > v_invoice.balance then
      raise exception 'Allocation exceeds invoice balance';
    end if;

    select c.grace_days into v_grace_days
      from public.contracts c where c.id = v_invoice.contract_id;
    v_new_paid := least(v_invoice.total, v_invoice.paid + v_allocation.amount);
    v_new_state := case
      when v_new_paid >= v_invoice.total then 'paid'::public.invoice_states
      when (v_invoice.due_date + coalesce(v_grace_days, 0)) < current_date then 'overdue'::public.invoice_states
      when v_new_paid > 0 then 'partially_paid'::public.invoice_states
      else 'due'::public.invoice_states
    end;

    insert into public.payment_allocations (company_id, payment_id, invoice_id, amount)
    values (v_payment.company_id, p_payment_id, v_invoice.id, v_allocation.amount);
    update public.invoices i
       set paid = v_new_paid, state = v_new_state
     where i.id = v_invoice.id and i.company_id = v_payment.company_id;

    invoice_id := v_invoice.id;
    applied := v_allocation.amount;
    new_state := v_new_state::text;
    return next;
  end loop;

  update public.receipts r
     set html_snapshot = public.receipt_html_for_payment(p_payment_id)
   where r.payment_id = p_payment_id and r.company_id = v_payment.company_id;

  perform public.write_audit(
    'allocation.apply',
    'payment',
    p_payment_id,
    null,
    jsonb_build_object('allocations', (
      select coalesce(
        jsonb_agg(jsonb_build_object('invoice_id', x.invoice_id, 'amount', x.amount)),
        '[]'::jsonb
      )
      from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
    ))
  );
end;
$function$;


REVOKE ALL ON FUNCTION public.apply_deposit_settlement(uuid) FROM PUBLIC, anon, authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.apply_partial_payment_settlement(uuid) FROM PUBLIC, anon, authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.apply_partial_payment_settlement(uuid, boolean, boolean) FROM PUBLIC, anon, authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.apply_payment_allocation(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_payment_allocation(uuid, jsonb) TO authenticated, company_service, service_role;
