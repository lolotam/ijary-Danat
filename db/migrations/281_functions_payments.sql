-- Migration 281: Tenant isolation & company_service audit for payment, allocation,
-- reversal, deposit, partial-payment, receipt, insurance, and refund functions (T035).

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
  if current_user in ('authenticated', 'anon', 'service_role', 'company_service') then
    raise exception 'deposit_settlement_internal_only' using errcode = '42501';
  end if;

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
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if current_user in ('authenticated', 'anon', 'service_role', 'company_service') then
    raise exception 'partial_payment_settlement_internal_only' using errcode = '42501';
  end if;
  perform public.current_company_id();
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
  if current_user in ('authenticated', 'anon', 'service_role', 'company_service') then
    raise exception 'partial_payment_settlement_internal_only' using errcode = '42501';
  end if;

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
  v_caller_company uuid := public.current_company_id();
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
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
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

-- يحذف سجل التأمين المرتبط بالعقد ضمن شركة المستدعي ويسجّل الحدث.
CREATE OR REPLACE FUNCTION public.delete_contract_insurance(p_contract_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_row public.insurance_payments;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'insurance_delete_forbidden' using errcode = '42501';
  end if;
  if current_user in ('authenticated', 'anon')
     and not public.has_permission(auth.uid(), 'insurance.delete') then
    raise exception 'insurance_delete_forbidden' using errcode = '42501';
  end if;

  delete from public.insurance_payments
   where contract_id = p_contract_id
     and (v_caller_company is null or company_id = v_caller_company)
  returning * into v_row;

  if v_row.id is null then
    return false;
  end if;

  perform public.write_audit(
    'insurance_payments.delete', 'insurance_payments', v_row.id, to_jsonb(v_row), null
  );
  return true;
end;
$function$;

-- يعدّل الدفعة الجزئية بأقفال العقود المرتبطة ضمن شركة المستدعي.
CREATE OR REPLACE FUNCTION public.edit_partial_payment(
  p_id uuid, p_amount numeric, p_paid_date date, p_invoice_id uuid, p_note text,
  p_tenant_id uuid, p_contract_id uuid, p_unit_id uuid, p_building_id uuid, p_status text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_partial public.partial_payments%rowtype;
  v_old_contract uuid;
  v_new_contract uuid;
  v_lock_key uuid;
  v_updated public.partial_payments%rowtype;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'partial_payments.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select pp.* into v_partial
    from public.partial_payments pp
   where pp.id = p_id
     and (v_caller_company is null or pp.company_id = v_caller_company);
  if not found then
    raise exception 'partial_payment_not_found' using errcode = 'P0002';
  end if;

  if p_invoice_id is not null and not exists (
    select 1 from public.invoices i
     where i.id = p_invoice_id and i.company_id = v_partial.company_id
  ) then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  if p_contract_id is not null and not exists (
    select 1 from public.contracts c
     where c.id = p_contract_id and c.company_id = v_partial.company_id
  ) then
    raise exception 'Contract not found' using errcode = 'P0002';
  end if;

  select i.contract_id into v_old_contract
    from public.invoices i where i.id = v_partial.invoice_id and i.company_id = v_partial.company_id;
  select i.contract_id into v_new_contract
    from public.invoices i where i.id = p_invoice_id and i.company_id = v_partial.company_id;

  for v_lock_key in
    select distinct c
      from unnest(array[v_old_contract, v_new_contract, p_contract_id]) as c
     where c is not null order by c
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key::text, 0));
  end loop;

  update public.partial_payments
     set amount = p_amount,
         paid_date = p_paid_date,
         invoice_id = p_invoice_id,
         note = p_note,
         tenant_id = coalesce(p_tenant_id, tenant_id),
         contract_id = p_contract_id,
         unit_id = p_unit_id,
         building_id = p_building_id,
         status = case when p_invoice_id is null then coalesce(p_status, status) else status end
   where id = p_id and company_id = v_partial.company_id;

  select pp.* into v_updated from public.partial_payments pp where pp.id = p_id;
  return to_jsonb(v_updated);
end;
$function$;

-- يرجع تفصيل مدفوعات الفاتورة المجمّع حسب المصدر والوسيلة ضمن نطاق الشركة.
CREATE OR REPLACE FUNCTION public.get_invoice_payment_breakdown(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_invoice public.invoices%rowtype;
  v_paid_from numeric(14,3);
  v_groups jsonb;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    return null;
  end if;

  if auth.role() not in ('service_role', 'company_service') then
    if not exists (
      select 1 from public.invoices
       where id = p_invoice_id
         and (v_caller_company is null or company_id = v_caller_company)
         and (
           public.is_staff(auth.uid()) or (
             is_visible_to_tenant and exists (
               select 1 from public.profiles p
                where p.id = auth.uid() and p.tenant_id = invoices.tenant_id
             )
           )
         )
    ) then
      return null;
    end if;
  end if;

  select i.* into v_invoice
    from public.invoices i
   where i.id = p_invoice_id
     and (v_caller_company is null or i.company_id = v_caller_company);
  if not found then return null; end if;

  select coalesce(sum(pa.amount), 0)::numeric(14,3) into v_paid_from
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id
   where pa.invoice_id = v_invoice.id
     and pa.company_id = v_invoice.company_id
     and p.company_id = v_invoice.company_id
     and p.status = 'confirmed';

  select coalesce(jsonb_agg(g.row order by g.first_paid_on, g.source, g.method), '[]'::jsonb)
    into v_groups
    from (
      select jsonb_build_object(
               'source', case
                 when p.source_partial_payment_id is not null then 'partial'
                 when p.payment_request_id is not null then 'gateway'
                 else 'manual'
               end,
               'method', p.method,
               'amount', sum(pa.amount)::numeric(14,3),
               'first_paid_on', min(p.payment_date),
               'last_paid_on', max(p.payment_date),
               'payments', count(distinct p.id)
             ) as row,
             min(p.payment_date) as first_paid_on,
             case
               when p.source_partial_payment_id is not null then 'partial'
               when p.payment_request_id is not null then 'gateway'
               else 'manual'
             end as source,
             p.method
        from public.payment_allocations pa
        join public.payments p on p.id = pa.payment_id
       where pa.invoice_id = v_invoice.id
         and pa.company_id = v_invoice.company_id
         and p.company_id = v_invoice.company_id
         and p.status = 'confirmed'
       group by
         case
           when p.source_partial_payment_id is not null then 'partial'
           when p.payment_request_id is not null then 'gateway'
           else 'manual'
         end,
         p.method
    ) g;

  return jsonb_build_object(
    'invoice', jsonb_build_object(
      'code', v_invoice.code,
      'subtotal', v_invoice.subtotal,
      'discount', v_invoice.discount,
      'total', v_invoice.total,
      'paid', v_invoice.paid,
      'balance', v_invoice.balance,
      'state', v_invoice.state
    ),
    'paid_from_allocations', v_paid_from,
    'reconciled', v_paid_from = v_invoice.paid,
    'groups', v_groups
  );
end;
$function$;

-- يرجع معرفات الدفعات المخفية عن بوابة المستأجر ضمن نطاق الشركة.
CREATE OR REPLACE FUNCTION public.portal_hidden_payment_ids(p_tenant_id uuid)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
begin
  if p_tenant_id is null then
    raise exception 'Tenant is required';
  end if;
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if auth.role() = 'authenticated' and not (
    public.is_staff(auth.uid()) or (
      public.has_role(auth.uid(), 'tenant') and exists (
        select 1 from public.profiles p
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
     and (v_caller_company is null or p.company_id = v_caller_company)
     and exists (
       select 1 from public.payment_allocations pa
        where pa.payment_id = p.id and pa.company_id = p.company_id
     )
     and p.amount <= (
       select coalesce(sum(pa.amount), 0)
         from public.payment_allocations pa
        where pa.payment_id = p.id and pa.company_id = p.company_id
     )
     and not exists (
       select 1
         from public.payment_allocations pa
         join public.invoices i on i.id = pa.invoice_id and i.company_id = p.company_id
         join public.contracts c on c.id = i.contract_id and c.company_id = p.company_id
        where pa.payment_id = p.id
          and pa.company_id = p.company_id
          and not coalesce(c.hide_from_portal, false)
     );
end;
$function$;

-- يحسب صافي التأمين المحتجز للمستأجر (المحصّل ناقص المصرّف) ضمن نطاق الشركة.
CREATE OR REPLACE FUNCTION public.portal_insurance_total(
  p_tenant_id uuid,
  p_contract_id uuid DEFAULT NULL::uuid
)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_total numeric(14, 3);
begin
  if p_tenant_id is null then
    raise exception 'Tenant is required';
  end if;
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if auth.role() = 'authenticated' and not (
    public.is_staff(auth.uid()) or (
      public.has_role(auth.uid(), 'tenant') and exists (
        select 1 from public.profiles p
         where p.id = auth.uid() and p.tenant_id = p_tenant_id
      )
    )
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select coalesce(sum(greatest(collected.amount - coalesce(disposed.amount, 0), 0)), 0)
    into v_total
    from (
      select ins.contract_id, c.company_id, sum(ins.amount) as amount
        from public.insurance_payments ins
        join public.contracts c on c.id = ins.contract_id
       where c.tenant_id = p_tenant_id
         and (v_caller_company is null or c.company_id = v_caller_company)
         and ins.company_id = c.company_id
         and (p_contract_id is null or c.id = p_contract_id)
         and c.state <> 'draft'
         and not coalesce(c.hide_from_portal, false)
       group by ins.contract_id, c.company_id
    ) collected
    left join (
      select co.contract_id, co.company_id,
             sum(
               co.deductions_total
               + case when settlement.status = 'reversed' then 0 else co.settled_total end
               + case when r.status in ('voided', 'reversed') then 0 else co.refund_total end
             ) as amount
        from public.contract_closeouts co
        left join public.refunds r on r.id = co.refund_id and r.company_id = co.company_id
        left join public.payments settlement
          on settlement.id::text = co.result ->> 'settlement_payment_id'
         and settlement.company_id = co.company_id
       where co.status = 'completed'
       group by co.contract_id, co.company_id
    ) disposed
      on disposed.contract_id = collected.contract_id
     and disposed.company_id = collected.company_id;

  return v_total;
end;
$function$;

-- يولّد لقطة HTML لإيصال الدفعة مع فرض عزل الشركة على المستدعي.
CREATE OR REPLACE FUNCTION public.receipt_html_for_payment(p_payment_id uuid)
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select '<article dir="rtl"><header>'
    || case when c.logo_url is null then ''
            else '<img src="' || public.html_escape(c.logo_url) || '" alt="" />' end
    || '<h1>قيمة استثمار</h1><h2>'
    || public.html_escape(coalesce(c.name_ar, c.name_en, '')) || '</h2></header><p>'
    || public.html_escape(coalesce(t.name, '')) || ' — '
    || public.html_escape(p.code) || '</p><ul>'
    || coalesce((
      select string_agg(
        '<li>قيمة استثمار ' || i.period_month::text || '/' || i.period_year::text
        || ': ' || pa.amount::text || ' ' || public.html_escape(p.currency) || '</li>',
        '' order by i.period_year, i.period_month
      )
      from public.payment_allocations pa
      join public.invoices i on i.id = pa.invoice_id and i.company_id = p.company_id
      where pa.payment_id = p.id and pa.company_id = p.company_id
    ), '')
    || '</ul><strong>' || p.amount::text || ' ' || public.html_escape(p.currency)
    || '</strong><p>قيمة استثمار للوحدة</p><footer>'
    || public.html_escape(coalesce(c.address_ar, c.address_en, '')) || ' · '
    || public.html_escape(coalesce(c.phone, '')) || ' · '
    || public.html_escape(coalesce(c.map_url, ''))
    || ' · ' || public.html_escape(coalesce(c.name_ar, c.name_en, '')) || '</footer></article>'
  from public.payments p
  join public.tenants t on t.id = p.tenant_id and t.company_id = p.company_id
  left join public.companies c on c.id = p.company_id
  where p.id = p_payment_id
    and (
      public.current_company_id() = p.company_id
      or (
        public.current_company_id() is null
        and current_user not in ('authenticated', 'company_service', 'anon')
      )
    )
$function$;

-- يعكس دفعة مؤكدة ويعيد أرصدة الفواتير ضمن نطاق شركة المستدعي.
CREATE OR REPLACE FUNCTION public.reverse_payment(p_payment_id uuid, p_reason text)
 RETURNS TABLE(reversal_payment_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_original public.payments%rowtype;
  v_reversal_id uuid;
  v_allocation public.payment_allocations%rowtype;
  v_invoice public.invoices%rowtype;
  v_new_paid numeric(14,3);
  v_new_state public.invoice_states;
  v_grace_days integer;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
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
  v_caller_company uuid := public.current_company_id();
  v_original public.refunds%rowtype;
  v_reversal_id uuid;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
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
  v_company_id uuid := public.current_company_id();
  v_payment_id uuid;
  v_invoice_id uuid;
begin
  if current_user in ('authenticated', 'anon', 'service_role', 'company_service') then
    raise exception 'deposit_settlement_internal_only' using errcode = '42501';
  end if;

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
  v_company_id uuid := public.current_company_id();
  v_payment_id uuid;
  v_invoice_id uuid;
begin
  if current_user in ('authenticated', 'anon', 'service_role', 'company_service') then
    raise exception 'partial_payment_settlement_internal_only' using errcode = '42501';
  end if;

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
  v_caller_company uuid := public.current_company_id();
  v_row public.contracts;
  v_contract_id uuid;
  v_company_id uuid;
  v_amount numeric;
  v_old numeric;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
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

-- يزامن وسيلة الدفع في الفاتورة عند تغيّر تخصيصاتها ضمن نفس الشركة.
CREATE OR REPLACE FUNCTION public.sync_invoice_payment_method()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id, old.company_id);
  v_invoice_id uuid := coalesce(new.invoice_id, old.invoice_id);
  v_method text;
begin
  select p.method::text into v_method
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id and p.company_id = v_company_id
   where pa.invoice_id = v_invoice_id
     and pa.company_id = v_company_id
     and p.status = 'confirmed'
   order by p.payment_date desc, p.created_at desc
   limit 1;

  update public.invoices i
     set payment_method = v_method,
         manual_payment_reason = case when v_method is null then null else i.manual_payment_reason end
   where i.id = v_invoice_id and i.company_id = v_company_id;

  return null;
end;
$function$;

-- يزامن وسيلة الدفع وسبب السداد اليدوي للفواتير المرتبطة بالدفعة ضمن الشركة.
CREATE OR REPLACE FUNCTION public.sync_invoice_payment_method_for_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
begin
  update public.invoices i
     set payment_method = (
           select p.method::text
             from public.payment_allocations pa
             join public.payments p on p.id = pa.payment_id and p.company_id = v_company_id
            where pa.invoice_id = i.id
              and pa.company_id = v_company_id
              and p.status = 'confirmed'
            order by p.payment_date desc, p.created_at desc
            limit 1
         )
   where i.company_id = v_company_id
     and i.id in (
       select pa.invoice_id from public.payment_allocations pa
        where pa.payment_id = new.id and pa.company_id = v_company_id
     );

  update public.invoices i
     set manual_payment_reason = null
   where i.company_id = v_company_id
     and i.id in (
       select pa.invoice_id from public.payment_allocations pa
        where pa.payment_id = new.id and pa.company_id = v_company_id
     )
     and not exists (
       select 1
         from public.payment_allocations pa
         join public.payments p on p.id = pa.payment_id and p.company_id = v_company_id
        where pa.invoice_id = i.id
          and pa.company_id = v_company_id
          and p.status = 'confirmed'
          and p.reference = 'AUTO-INV:' || i.code
     );

  return null;
end;
$function$;

-- يتراجع عن تسوية الإيداع عند حذفه ويسجل الأثر ضمن شركة السجل.
CREATE OR REPLACE FUNCTION public.tg_deposits_revert_on_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), old.company_id);
  v_invoice_id uuid;
begin
  if old.company_id <> v_company_id then
    raise exception 'deposit_company_mismatch' using errcode = '42501';
  end if;
  v_invoice_id := public.revert_deposit_settlement(old.id);
  if v_invoice_id is not null then
    perform public.write_audit(
      'deposit.invoice.revert', 'deposit', old.id,
      jsonb_build_object('invoice_id', v_invoice_id, 'status', old.status, 'amount', old.amount),
      jsonb_build_object('reason', 'deposit deleted'), 'success', null
    );
  end if;
  return old;
end;
$function$;

-- يعيد تسوية الإيداع عند تعديله أو تأكيده بأقفال مرتّبة للعقود ضمن الشركة.
CREATE OR REPLACE FUNCTION public.tg_deposits_sync_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
  v_old_invoice uuid;
  v_new_invoice uuid;
  v_contract uuid;
begin
  if new.company_id <> v_company_id then
    raise exception 'deposit_company_mismatch' using errcode = '42501';
  end if;

  for v_contract in
    select distinct c
      from unnest(array[case when tg_op = 'UPDATE' then old.contract_id else null end, new.contract_id]) as c
     where c is not null order by c
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_contract::text, 0));
  end loop;

  v_old_invoice := public.revert_deposit_settlement(new.id);
  if new.status = 'confirmed' and new.invoice_id is not null then
    v_new_invoice := public.apply_deposit_settlement(new.id);
  end if;

  if v_old_invoice is not null and v_old_invoice is distinct from v_new_invoice then
    perform public.recompute_invoice_from_confirmed(v_old_invoice);
  end if;

  if v_old_invoice is not null or v_new_invoice is not null then
    perform public.write_audit(
      case when v_new_invoice is not null then 'deposit.invoice.settle' else 'deposit.invoice.revert' end,
      'deposit', new.id,
      jsonb_build_object('invoice_id', v_old_invoice, 'status', case when tg_op = 'UPDATE' then old.status else null end),
      jsonb_build_object('invoice_id', v_new_invoice, 'status', new.status, 'amount', new.amount),
      'success', null
    );
  end if;
  return null;
end;
$function$;

-- يخفي إيصالات العقد عن المستأجر عند تفعيل إخفاء الوثائق ضمن الشركة.
CREATE OR REPLACE FUNCTION public.tg_hide_receipts_on_suppression_enabled()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
begin
  update public.receipts r
     set visible_to_tenant = false
   where r.visible_to_tenant
     and r.company_id = v_company_id
     and exists (
       select 1
         from public.payment_allocations pa
         join public.invoices i on i.id = pa.invoice_id and i.company_id = v_company_id
        where pa.payment_id = r.payment_id
          and pa.company_id = v_company_id
          and i.contract_id = new.id
     );
  return null;
end;
$function$;

-- يخفي الإيصال عند تخصيص دفعة لفاتورة عقد مخفي ضمن الشركة.
CREATE OR REPLACE FUNCTION public.tg_hide_suppressed_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
begin
  if exists (
    select 1
      from public.invoices i
      join public.contracts c on c.id = i.contract_id and c.company_id = v_company_id
     where i.id = new.invoice_id
       and i.company_id = v_company_id
       and (c.suppress_tenant_billing_docs or c.hide_from_portal)
  ) then
    update public.receipts
       set visible_to_tenant = false
     where payment_id = new.payment_id
       and company_id = v_company_id
       and visible_to_tenant;
  end if;
  return new;
end;
$function$;

-- يفك ارتباط الإيداعات غير المسواة عند حذف الفاتورة ضمن الشركة.
CREATE OR REPLACE FUNCTION public.tg_invoices_unlink_deposits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), old.company_id);
  v_unlinked integer;
begin
  update public.deposits d
     set contract_id = null, invoice_id = null
   where d.invoice_id = old.id
     and d.company_id = v_company_id
     and not exists (
       select 1 from public.payments p
        where p.source_deposit_id = d.id and p.company_id = v_company_id
     );
  get diagnostics v_unlinked = row_count;

  if v_unlinked > 0 then
    perform public.write_audit(
      'deposit.invoice.unlink', 'invoice', old.id,
      jsonb_build_object('invoice_code', old.code),
      jsonb_build_object('reason', 'invoice deleted', 'deposits_unlinked', v_unlinked),
      'success', null
    );
  end if;
  return old;
end;
$function$;

-- يعيد حساب الفاتورة بعد حذف الدفعة الجزئية ضمن الشركة.
CREATE OR REPLACE FUNCTION public.tg_partial_payments_recompute_after_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if old.company_id = coalesce(public.current_company_id(), old.company_id) then
    perform public.recompute_invoice_from_confirmed(old.invoice_id);
  end if;
  return null;
end;
$function$;

-- يعيد تسوية الدفعة الجزئية عند تغيير المبلغ أو الفاتورة أو التاريخ ضمن الشركة.
CREATE OR REPLACE FUNCTION public.tg_partial_payments_resync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id, old.company_id);
  v_owned boolean;
  v_old_contract uuid;
  v_new_contract uuid;
  v_lock_key uuid;
  v_old_state text;
begin
  if new.amount is not distinct from old.amount
     and new.invoice_id is not distinct from old.invoice_id
     and new.paid_date is not distinct from old.paid_date then
    return null;
  end if;
  if new.company_id <> v_company_id then
    raise exception 'partial_payment_company_mismatch' using errcode = '42501';
  end if;

  select exists (
    select 1 from public.payments p
     where p.source_partial_payment_id = old.id and p.company_id = v_company_id
  ) into v_owned;

  if v_owned then
    select i.state::text into v_old_state
      from public.invoices i where i.id = old.invoice_id and i.company_id = v_company_id;
    if v_old_state in ('cancelled', 'waived') then
      raise exception 'partial_payment_invoice_terminal_state' using errcode = '23514';
    end if;
  end if;

  select i.contract_id into v_old_contract
    from public.invoices i where i.id = old.invoice_id and i.company_id = v_company_id;
  select i.contract_id into v_new_contract
    from public.invoices i where i.id = new.invoice_id and i.company_id = v_company_id;

  for v_lock_key in
    select distinct c from unnest(array[v_old_contract, v_new_contract]) as c
     where c is not null order by c
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key::text, 0));
  end loop;

  perform public.revert_partial_payment_settlement(old.id);
  if old.invoice_id is not null then
    perform public.recompute_invoice_from_confirmed(old.invoice_id);
  end if;
  if new.invoice_id is not null then
    perform public.apply_partial_payment_settlement(
      new.id, v_owned, new.invoice_id is not distinct from old.invoice_id
    );
  end if;
  return null;
end;
$function$;

-- يتراجع عن تسوية الدفعة الجزئية قبل حذفها ضمن الشركة.
CREATE OR REPLACE FUNCTION public.tg_partial_payments_revert_on_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), old.company_id);
  v_contract uuid;
begin
  if old.company_id <> v_company_id then
    raise exception 'partial_payment_company_mismatch' using errcode = '42501';
  end if;
  if old.invoice_id is not null then
    select i.contract_id into v_contract
      from public.invoices i where i.id = old.invoice_id and i.company_id = v_company_id;
    if v_contract is not null then
      perform pg_advisory_xact_lock(hashtextextended(v_contract::text, 0));
    end if;
  end if;
  perform public.revert_partial_payment_settlement(old.id);
  return old;
end;
$function$;

-- يشغّل تسوية الدفعة الجزئية بعد إدراجها ضمن الشركة.
CREATE OR REPLACE FUNCTION public.tg_partial_payments_settle()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.company_id = coalesce(public.current_company_id(), new.company_id) then
    perform public.apply_partial_payment_settlement(new.id);
  end if;
  return null;
end;
$function$;

-- يزامن حالة الدفعات الجزئية عند اكتمال سداد الفاتورة أو إعادة فتحها ضمن الشركة.
CREATE OR REPLACE FUNCTION public.tg_partial_payments_sync_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id, old.company_id);
begin
  if new.state = 'paid' then
    update public.partial_payments
       set status = 'complete'
     where invoice_id = new.id and company_id = v_company_id and status <> 'complete';
  elsif old.state = 'paid' then
    update public.partial_payments
       set status = 'incomplete'
     where invoice_id = new.id and company_id = v_company_id and status <> 'incomplete';
  end if;
  return null;
end;
$function$;

-- يستدل على طلب الدفع المرتبط بدفعة البوابة ضمن نفس الشركة.
CREATE OR REPLACE FUNCTION public.tg_payments_infer_gateway_provenance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
begin
  if new.payment_request_id is null and new.note like 'MyFatoorah %' then
    select pr.id into new.payment_request_id
      from public.payment_requests pr
     where pr.company_id = v_company_id
       and new.note like 'MyFatoorah ' || pr.code || ' %'
     limit 1;
  end if;
  return new;
end;
$function$;

-- ينشئ أو يحدّث الإيصال عند تأكيد الدفعة مع تمرير company_id صراحةً.
CREATE OR REPLACE FUNCTION public.tg_sync_payment_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
  v_visible boolean;
begin
  if new.status <> 'confirmed' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'confirmed' then return new; end if;

  select t.receipt_visible_to_tenant into v_visible
    from public.tenants t where t.id = new.tenant_id and t.company_id = v_company_id;

  insert into public.receipts (
    company_id, payment_id, tenant_id, amount, currency, html_snapshot, visible_to_tenant
  ) values (
    v_company_id, new.id, new.tenant_id, new.amount, new.currency,
    public.receipt_html_for_payment(new.id), coalesce(v_visible, false)
  )
  on conflict (payment_id) do update set
    amount = excluded.amount,
    currency = excluded.currency,
    html_snapshot = excluded.html_snapshot;
  return new;
end;
$function$;

-- يلغي سجل استرداد مرحّل (voided) ضمن نطاق شركة المستدعي.
CREATE OR REPLACE FUNCTION public.void_refund(p_refund_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_original public.refunds%rowtype;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'refunds.void') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A void reason is required';
  end if;

  select r.* into v_original
    from public.refunds r
   where r.id = p_refund_id
     and (v_caller_company is null or r.company_id = v_caller_company)
   for update;
  if not found then raise exception 'Refund not found'; end if;
  if v_original.status <> 'posted' then
    raise exception 'Only a posted refund can be voided';
  end if;

  update public.refunds r
     set status = 'voided',
         voided_at = now(),
         voided_by = auth.uid(),
         void_reason = trim(p_reason)
   where r.id = v_original.id and r.company_id = v_original.company_id;

  perform public.write_audit(
    'refund.void', 'refund', v_original.id, to_jsonb(v_original),
    jsonb_build_object('status', 'voided', 'void_reason', trim(p_reason)),
    'success', null
  );

  if v_original.contract_id is not null then
    insert into public.contract_operational_events (
      company_id, contract_id, tenant_id, event_type, actor_id, payload, note
    ) values (
      v_original.company_id, v_original.contract_id, v_original.tenant_id,
      'refund_voided', auth.uid(),
      jsonb_build_object('refund_id', v_original.id, 'amount', v_original.amount),
      trim(p_reason)
    );
  end if;
end;
$function$;

-- Revoke public/anon execution on all payment-group SECURITY DEFINER functions; grant RPCs to app roles.
REVOKE ALL ON FUNCTION public.apply_deposit_settlement(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_partial_payment_settlement(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.apply_partial_payment_settlement(uuid, boolean, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revert_deposit_settlement(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revert_partial_payment_settlement(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_invoice_payment_method() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_invoice_payment_method_for_payment() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_deposits_revert_on_delete() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_deposits_sync_invoice() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_hide_receipts_on_suppression_enabled() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_hide_suppressed_receipt() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_invoices_unlink_deposits() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_partial_payments_recompute_after_delete() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_partial_payments_resync() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_partial_payments_revert_on_delete() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_partial_payments_settle() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_partial_payments_sync_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_payments_infer_gateway_provenance() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_sync_payment_receipt() FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION public.apply_payment_allocation(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_payment_allocation(uuid, jsonb) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.delete_contract_insurance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_contract_insurance(uuid) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.edit_partial_payment(uuid, numeric, date, uuid, text, uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_partial_payment(uuid, numeric, date, uuid, text, uuid, uuid, uuid, uuid, text) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.get_invoice_payment_breakdown(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoice_payment_breakdown(uuid) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.portal_hidden_payment_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.portal_hidden_payment_ids(uuid) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.portal_insurance_total(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.portal_insurance_total(uuid, uuid) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.receipt_html_for_payment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipt_html_for_payment(uuid) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.reverse_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_payment(uuid, text) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.reverse_refund(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_refund(uuid, text) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.sync_contract_deposit_from_insurance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_contract_deposit_from_insurance(uuid) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.void_refund(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_refund(uuid, text) TO authenticated, company_service, service_role;
