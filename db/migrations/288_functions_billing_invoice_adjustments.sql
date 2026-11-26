-- 288_functions_billing_invoice_adjustments.sql
-- T034: function audit — invoice recompute, write-off, dispute.
-- Split from 280_functions_billing.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

------------------------------------------------------------
-- 5. Invoice recompute, dispute, write-off, manual paid, bulk import
------------------------------------------------------------

/**
 * يعيد احتساب المبلغ المدفوع وحالة الفاتورة من الدفعات المؤكدة فقط ضمن الشركة.
 */
create or replace function public.recompute_invoice_from_confirmed(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_invoice public.invoices%rowtype;
  v_paid numeric(14,3);
  v_grace integer;
begin
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select i.* into v_invoice
    from public.invoices i
   where i.id = p_invoice_id
     and (v_company_id is null or i.company_id = v_company_id)
   for update;
  if not found then return; end if;
  if v_invoice.state in ('cancelled', 'waived') then return; end if;

  select coalesce(sum(pa.amount), 0) into v_paid
    from public.payment_allocations pa
    join public.payments p
      on p.id = pa.payment_id
     and p.company_id = pa.company_id
   where pa.invoice_id = v_invoice.id
     and pa.company_id = v_invoice.company_id
     and p.status = 'confirmed';

  select c.grace_days into v_grace
    from public.contracts c
   where c.id = v_invoice.contract_id
     and c.company_id = v_invoice.company_id;

  update public.invoices i
     set paid = v_paid,
         state = case
           when v_paid >= v_invoice.total then 'paid'::public.invoice_states
           when (v_invoice.due_date + coalesce(v_grace, 0)) < current_date
             then 'overdue'::public.invoice_states
           when v_paid > 0 then 'partially_paid'::public.invoice_states
           else 'due'::public.invoice_states
         end
   where i.id = v_invoice.id
     and i.company_id = v_invoice.company_id;
end;
$fn$;

revoke execute on function public.recompute_invoice_from_confirmed(uuid)
  from public, anon, authenticated, service_role;

/**
 * يشطب الرصيد المتبقي من الفاتورة ويحوّل حالتها إلى مُعفاة ضمن الشركة الحالية.
 */
create or replace function public.write_off_invoice(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_invoice public.invoices%rowtype;
begin
  if v_eff_role = 'authenticated'
     and not public.has_permission(auth.uid(), 'invoices.write_off') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A write-off reason is required';
  end if;

  select i.* into v_invoice
    from public.invoices i
   where i.id = p_invoice_id
     and (v_company_id is null or i.company_id = v_company_id)
   for update;
  if not found then raise exception 'Invoice not found'; end if;

  if v_invoice.state in ('paid', 'cancelled', 'waived') then
    raise exception 'Invoice cannot be written off in its current state';
  end if;
  if v_invoice.balance <= 0 then
    raise exception 'Invoice has no remaining balance to write off';
  end if;

  update public.invoices i
     set state = 'waived'::public.invoice_states
   where i.id = v_invoice.id
     and i.company_id = v_invoice.company_id;

  perform public.write_audit(
    'invoice.write_off',
    'invoice',
    v_invoice.id,
    to_jsonb(v_invoice),
    jsonb_build_object(
      'company_id', v_invoice.company_id,
      'state', 'waived',
      'reason', trim(p_reason),
      'balance_written_off', v_invoice.balance
    ),
    'success',
    null
  );

  insert into public.contract_operational_events (
    company_id, contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    v_invoice.company_id,
    v_invoice.contract_id,
    v_invoice.tenant_id,
    'invoice_written_off',
    auth.uid(),
    jsonb_build_object(
      'invoice_id', v_invoice.id,
      'balance_written_off', v_invoice.balance
    ),
    trim(p_reason)
  );
end;
$$;

revoke all on function public.write_off_invoice(uuid, text) from public, anon;
grant execute on function public.write_off_invoice(uuid, text)
  to authenticated, company_service, service_role;

/**
 * يضع علامة نزاع على الفاتورة دون تغيير حالتها أو رصيدها ضمن الشركة الحالية.
 */
create or replace function public.set_invoice_dispute(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_invoice public.invoices%rowtype;
begin
  if v_eff_role = 'authenticated'
     and not public.has_permission(auth.uid(), 'invoices.dispute') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A dispute reason is required';
  end if;

  select i.* into v_invoice
    from public.invoices i
   where i.id = p_invoice_id
     and (v_company_id is null or i.company_id = v_company_id)
   for update;
  if not found then raise exception 'Invoice not found'; end if;

  update public.invoices i
     set disputed_at = now(),
         dispute_reason = trim(p_reason),
         disputed_by = auth.uid()
   where i.id = v_invoice.id
     and i.company_id = v_invoice.company_id;

  perform public.write_audit(
    'invoice.dispute',
    'invoice',
    v_invoice.id,
    to_jsonb(v_invoice),
    jsonb_build_object(
      'company_id', v_invoice.company_id,
      'disputed', true,
      'dispute_reason', trim(p_reason)
    ),
    'success',
    null
  );

  insert into public.contract_operational_events (
    company_id, contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    v_invoice.company_id,
    v_invoice.contract_id,
    v_invoice.tenant_id,
    'invoice_disputed',
    auth.uid(),
    jsonb_build_object('invoice_id', v_invoice.id),
    trim(p_reason)
  );
end;
$$;

revoke all on function public.set_invoice_dispute(uuid, text) from public, anon;
grant execute on function public.set_invoice_dispute(uuid, text)
  to authenticated, company_service, service_role;

/**
 * يزيل علامة النزاع عن الفاتورة دون تغيير حالتها أو رصيدها ضمن الشركة الحالية.
 */
create or replace function public.clear_invoice_dispute(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_invoice public.invoices%rowtype;
begin
  if v_eff_role = 'authenticated'
     and not public.has_permission(auth.uid(), 'invoices.dispute') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select i.* into v_invoice
    from public.invoices i
   where i.id = p_invoice_id
     and (v_company_id is null or i.company_id = v_company_id)
   for update;
  if not found then raise exception 'Invoice not found'; end if;

  if v_invoice.disputed_at is null then
    raise exception 'Invoice is not disputed';
  end if;

  update public.invoices i
     set disputed_at = null,
         dispute_reason = null,
         disputed_by = null
   where i.id = v_invoice.id
     and i.company_id = v_invoice.company_id;

  perform public.write_audit(
    'invoice.dispute_clear',
    'invoice',
    v_invoice.id,
    to_jsonb(v_invoice),
    jsonb_build_object('company_id', v_invoice.company_id, 'disputed', false),
    'success',
    null
  );

  insert into public.contract_operational_events (
    company_id, contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    v_invoice.company_id,
    v_invoice.contract_id,
    v_invoice.tenant_id,
    'dispute_cleared',
    auth.uid(),
    jsonb_build_object('invoice_id', v_invoice.id),
    null
  );
end;
$$;

revoke all on function public.clear_invoice_dispute(uuid) from public, anon;
grant execute on function public.clear_invoice_dispute(uuid)
  to authenticated, company_service, service_role;
