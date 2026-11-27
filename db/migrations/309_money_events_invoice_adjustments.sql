-- 309 (T071): the money event outbox — the invoice adjustment events.
--
-- write_off_invoice emits invoice.written_off and set_invoice_dispute emits
-- invoice.disputed, each from the transaction that changed the invoice
-- (FR-018). The bodies are the latest definitions copied verbatim with one
-- added enqueue call at the point the change succeeds.
--
-- Guarded by src/db/outbox/moneyEvents.sqltest.ts.

-- 1. invoice.written_off — the write-off of an invoice balance

/**
 * يشطب الرصيد المتبقي من الفاتورة ويحوّل حالتها إلى مُعفاة، ويخرج حدث
 * `invoice.written_off` مع المعاملة نفسها (FR-018).
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
  -- Money outbox (T071): the invoice is waived, so the event leaves with the
  -- write-off itself (FR-018).
  if v_company_id is not null then
    perform public.enqueue_job(
      'invoice.written_off', jsonb_build_object('invoiceId', v_invoice.id),
      'invoice.written_off:' || v_invoice.id::text);
  else
    -- A platform write-off has no company context: the event goes to that company.
    perform public.enqueue_job_for_company(v_invoice.company_id, 'invoice.written_off',
      jsonb_build_object('invoiceId', v_invoice.id), 'invoice.written_off:' || v_invoice.id::text);
  end if;
end;
$$;

-- 2. invoice.disputed — the dispute flag on an invoice

/**
 * يضع علامة نزاع على الفاتورة دون تغيير حالتها أو رصيدها، ويخرج حدث
 * `invoice.disputed` مع المعاملة نفسها (FR-018).
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
  v_audit_id uuid;
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

  v_audit_id := public.write_audit(
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
  -- Money outbox (T071): the invoice carries a dispute, so the event leaves
  -- with the dispute itself (FR-018). The key names the dispute instance —
  -- the invoice id and its own audit row — so a dispute that is cleared and
  -- raised again is a second event and not a swallowed one (GR-004).
  if v_company_id is not null then
    perform public.enqueue_job(
      'invoice.disputed', jsonb_build_object('invoiceId', v_invoice.id),
      'invoice.disputed:' || v_invoice.id::text || ':' || v_audit_id::text);
  else
    -- A platform dispute has no company context: the event goes to that company.
    perform public.enqueue_job_for_company(v_invoice.company_id, 'invoice.disputed',
      jsonb_build_object('invoiceId', v_invoice.id), 'invoice.disputed:' || v_invoice.id::text || ':' || v_audit_id::text);
  end if;
end;
$$;

-- The grants of every redefined function are unchanged; they are restated here
-- so the file states the permissions it depends on.
REVOKE ALL ON FUNCTION public.write_off_invoice(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.write_off_invoice(uuid, text) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.set_invoice_dispute(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.set_invoice_dispute(uuid, text) TO authenticated, company_service, service_role;
