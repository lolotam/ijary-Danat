-- 293_functions_payments_triggers.sql
-- T035: function audit — payment triggers and refund void.
-- Split from 281_functions_payments.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

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
REVOKE ALL ON FUNCTION public.void_refund(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_refund(uuid, text) TO authenticated, company_service, service_role;
