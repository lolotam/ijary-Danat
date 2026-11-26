-- 294_functions_closeout_settlement.sql
-- T036: function audit — closeout cancel and settlement computation.
-- Split from 282_functions_closeout_electricity_hr.sql (T052l) to keep each migration under 600 lines;
-- T052o: callable functions read the company from `public.current_company_id_strict()`,
-- which raises COMPANY_REQUIRED for an API role with no company. Trigger and internal
-- functions fall back to the row's own company_id; no API role can execute them. Idempotent.

-- يلغي مسودة تصفية العقد ضمن نطاق شركة المستدعي.
CREATE OR REPLACE FUNCTION public.cancel_contract_closeout(p_closeout_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_closeout public.contract_closeouts%rowtype;
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(v_actor, 'contracts.close_out') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_actor is null then
    raise exception 'Authentication required to cancel a close-out';
  end if;

  select c.* into v_closeout
    from public.contract_closeouts c
   where c.id = p_closeout_id
     and (v_caller_company is null or c.company_id = v_caller_company)
   for update;
  if not found then
    raise exception 'Close-out not found';
  end if;
  if v_closeout.status <> 'draft' then
    raise exception 'Only a draft close-out can be cancelled (status = %)', v_closeout.status;
  end if;

  update public.contract_closeouts c
     set status = 'cancelled',
         cancelled_by = v_actor,
         cancelled_at = now(),
         note = case
           when nullif(trim(p_reason), '') is null then c.note
           when c.note is null or c.note = '' then trim(p_reason)
           else c.note || E'\n' || trim(p_reason)
         end
   where c.id = p_closeout_id and c.company_id = v_closeout.company_id
  returning * into v_closeout;

  v_result := jsonb_build_object(
    'closeout_id', v_closeout.id,
    'status', 'cancelled',
    'contract_id', v_closeout.contract_id
  );

  perform public.write_audit(
    'contract.closeout_cancel', 'contract', v_closeout.contract_id,
    null, v_result, 'success', null
  );

  insert into public.contract_operational_events (
    company_id, contract_id, tenant_id, closeout_id, event_type, actor_id, payload, note
  ) values (
    v_closeout.company_id, v_closeout.contract_id, v_closeout.tenant_id,
    v_closeout.id, 'closeout_cancelled', v_actor, v_result, p_reason
  );

  return v_result;
end;
$function$;

-- يحسب تسوية تصفية العقد (الاستقطاعات والتسويات والمسترد) ضمن نطاق شركة العقد.
CREATE OR REPLACE FUNCTION public.closeout_compute_settlement(
  p_contract_id uuid, p_deductions jsonb, p_invoice_actions jsonb, p_refund_amount numeric
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_contract_company uuid;
  v_deductions jsonb := coalesce(p_deductions, '[]'::jsonb);
  v_actions jsonb := coalesce(p_invoice_actions, '[]'::jsonb);
  v_deposit_held numeric(14,3);
  v_deductions_total numeric(14,3);
  v_settled_total numeric(14,3) := 0;
  v_written_off_total numeric(14,3) := 0;
  v_available numeric(14,3);
  v_refund_total numeric(14,3);
  v_balance_due numeric(14,3);
  v_action record;
  v_invoice public.invoices%rowtype;
  v_action_amount numeric(14,3);
  v_resulting public.invoice_states;
  v_deduction_lines jsonb := '[]'::jsonb;
  v_action_lines jsonb := '[]'::jsonb;
  v_missing uuid;
  v_orphan uuid;
begin

  select c.company_id into v_contract_company
    from public.contracts c
   where c.id = p_contract_id
     and (v_caller_company is null or c.company_id = v_caller_company);
  if not found then
    raise exception 'Contract not found';
  end if;

  if jsonb_typeof(v_deductions) is distinct from 'array' then
    raise exception 'p_deductions must be a JSON array';
  end if;
  if jsonb_typeof(v_actions) is distinct from 'array' then
    raise exception 'p_invoice_actions must be a JSON array';
  end if;

  if exists (
    select 1
      from jsonb_to_recordset(v_deductions) as d(
        kind text, description_ar text, description_en text, amount numeric
      )
     where d.kind is null
        or d.kind not in ('damages', 'cleaning', 'utilities', 'unpaid_rent', 'other')
        or d.amount is null or d.amount <= 0
  ) then
    raise exception 'Each deduction requires a valid kind and amount > 0';
  end if;

  select coalesce(
    (select ip.amount from public.insurance_payments ip
      where ip.contract_id = p_contract_id and ip.company_id = v_contract_company),
    0
  ) into v_deposit_held;
  v_deposit_held := round(v_deposit_held, 3);

  select round(coalesce(sum(d.amount), 0), 3) into v_deductions_total
    from jsonb_to_recordset(v_deductions) as d(
      kind text, description_ar text, description_en text, amount numeric
    );

  select jsonb_agg(
    jsonb_build_object(
      'line', x.line, 'kind', x.kind,
      'description_ar', x.description_ar, 'description_en', x.description_en, 'amount', x.amount
    ) order by x.line
  ) into v_deduction_lines
  from (
    select row_number() over () as line,
           d.kind, d.description_ar, d.description_en, round(d.amount, 3) as amount
      from jsonb_to_recordset(v_deductions) as d(
        kind text, description_ar text, description_en text, amount numeric
      )
  ) x;
  v_deduction_lines := coalesce(v_deduction_lines, '[]'::jsonb);

  select i.id into v_missing
    from public.invoices i
   where i.contract_id = p_contract_id and i.company_id = v_contract_company
     and i.balance > 0
     and not exists (
       select 1 from jsonb_to_recordset(v_actions) as a(invoice_id uuid, action text, amount numeric)
        where a.invoice_id = i.id
     )
   limit 1;
  if v_missing is not null then
    raise exception 'Invoice % has a remaining balance but is missing from p_invoice_actions', v_missing;
  end if;

  select a.invoice_id into v_orphan
    from jsonb_to_recordset(v_actions) as a(invoice_id uuid, action text, amount numeric)
   where a.invoice_id is null
      or not exists (
        select 1 from public.invoices i
         where i.id = a.invoice_id and i.contract_id = p_contract_id and i.company_id = v_contract_company
      )
   limit 1;
  if v_orphan is not null then
    raise exception 'Invoice % is not on this contract', v_orphan;
  end if;
  if exists (
    select 1 from jsonb_to_recordset(v_actions) as a(invoice_id uuid, action text, amount numeric)
     where a.invoice_id is null
  ) then
    raise exception 'Every invoice action requires an invoice_id';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(v_actions) as a(invoice_id uuid, action text, amount numeric)
     group by a.invoice_id having count(*) > 1
  ) then
    raise exception 'Duplicate invoice action';
  end if;

  for v_action in
    select a.invoice_id, a.action, a.amount
      from jsonb_to_recordset(v_actions) as a(invoice_id uuid, action text, amount numeric)
     order by a.invoice_id
  loop
    if v_action.action is null
       or v_action.action not in ('leave', 'settle_from_deposit', 'write_off', 'cancel', 'mark_disputed') then
      raise exception 'Invalid invoice action: %', v_action.action;
    end if;

    select i.* into v_invoice
      from public.invoices i where i.id = v_action.invoice_id and i.company_id = v_contract_company;

    v_action_amount := 0;
    v_resulting := v_invoice.state;

    if v_action.action = 'leave' then
      v_action_amount := 0;
    elsif v_action.action = 'cancel' then
      if v_invoice.state in ('cancelled', 'waived') then
        raise exception 'Invoice % cannot be cancelled in its current state', v_invoice.id;
      end if;
      v_resulting := 'cancelled'::public.invoice_states;
    elsif v_action.action = 'write_off' then
      if v_invoice.state in ('paid', 'cancelled', 'waived') then
        raise exception 'Invoice % cannot be written off in its current state', v_invoice.id;
      end if;
      if v_invoice.balance <= 0 then
        raise exception 'Invoice % has no remaining balance to write off', v_invoice.id;
      end if;
      v_action_amount := round(v_invoice.balance, 3);
      v_written_off_total := v_written_off_total + v_action_amount;
      v_resulting := 'waived'::public.invoice_states;
    elsif v_action.action = 'mark_disputed' then
      v_action_amount := 0;
    elsif v_action.action = 'settle_from_deposit' then
      if v_action.amount is null or v_action.amount <= 0 then
        raise exception 'settle_from_deposit requires amount > 0 for invoice %', v_invoice.id;
      end if;
      if v_invoice.state in ('cancelled', 'waived') then
        raise exception 'Invoice % cannot receive a settlement in its current state', v_invoice.id;
      end if;
      if round(v_action.amount, 3) > v_invoice.balance then
        raise exception 'Settlement exceeds balance for invoice %', v_invoice.id;
      end if;
      v_action_amount := round(v_action.amount, 3);
      v_settled_total := v_settled_total + v_action_amount;
      if v_invoice.paid + v_action_amount >= v_invoice.total then
        v_resulting := 'paid'::public.invoice_states;
      elsif v_invoice.paid + v_action_amount > 0 then
        v_resulting := 'partially_paid'::public.invoice_states;
      end if;
    end if;

    v_action_lines := v_action_lines || jsonb_build_array(
      jsonb_build_object(
        'invoice_id', v_invoice.id, 'invoice_code', v_invoice.code,
        'action', v_action.action, 'amount', v_action_amount,
        'previous_state', v_invoice.state::text, 'resulting_state', v_resulting::text
      )
    );
  end loop;

  v_settled_total := round(v_settled_total, 3);
  v_written_off_total := round(v_written_off_total, 3);

  if v_deductions_total + v_settled_total > v_deposit_held then
    raise exception 'Deductions plus settlements (%) exceed deposit held (%)',
      v_deductions_total + v_settled_total, v_deposit_held;
  end if;

  v_available := round(v_deposit_held - v_deductions_total - v_settled_total, 3);
  v_refund_total := round(coalesce(p_refund_amount, greatest(v_available, 0)), 3);
  v_balance_due := round(greatest(-v_available, 0), 3);

  if v_refund_total < 0 then
    raise exception 'Refund amount cannot be negative';
  end if;
  if v_refund_total > greatest(v_available, 0) then
    raise exception 'Refund amount (%) exceeds available deposit (%)',
      v_refund_total, greatest(v_available, 0);
  end if;

  return jsonb_build_object(
    'deposit_held', v_deposit_held, 'deductions_total', v_deductions_total,
    'settled_total', v_settled_total, 'written_off_total', v_written_off_total,
    'refund_total', v_refund_total, 'balance_due_tenant', v_balance_due,
    'available', v_available, 'deductions', v_deduction_lines, 'invoice_actions', v_action_lines
  );
end;
$function$;


REVOKE ALL ON FUNCTION public.cancel_contract_closeout(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_contract_closeout(uuid, text) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.closeout_compute_settlement(uuid, jsonb, jsonb, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.closeout_compute_settlement(uuid, jsonb, jsonb, numeric) TO authenticated, company_service, service_role;
