-- Migration 282: Tenant isolation & company_service audit for closeout, electricity,
-- and salary functions (T036).

-- يلغي مسودة تصفية العقد ضمن نطاق شركة المستدعي.
CREATE OR REPLACE FUNCTION public.cancel_contract_closeout(p_closeout_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_closeout public.contract_closeouts%rowtype;
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
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
  v_caller_company uuid := public.current_company_id();
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
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;

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

-- ينفذ تصفية العقد ذرياً مع الحفاظ على عدم الكتابة على profiles وتقييد مفتاح التكرار بالشركة.
CREATE OR REPLACE FUNCTION public.close_out_contract(
  p_contract_id uuid, p_move_out_date date, p_outcome text,
  p_final_contract_state text, p_archive_tenant boolean,
  p_deductions jsonb, p_invoice_actions jsonb, p_refund_amount numeric,
  p_note text, p_idempotency_key text, p_expected_contract_updated_at timestamp with time zone
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_contract_company uuid;
  v_contract public.contracts%rowtype;
  v_closeout public.contract_closeouts%rowtype;
  v_settlement jsonb;
  v_payment_id uuid;
  v_refund_id uuid;
  v_refund_code text;
  v_result jsonb;
  v_unit_status public.unit_status;
  v_final_state public.contract_states;
  v_header_final public.contract_states;
  v_tenant_company uuid;
  v_building_id uuid;
  v_action record;
  v_invoice public.invoices%rowtype;
  v_prev_state public.invoice_states;
  v_new_state public.invoice_states;
  v_action_amount numeric(14,3);
  v_settle_lines jsonb := '[]'::jsonb;
  v_deductions jsonb := coalesce(p_deductions, '[]'::jsonb);
  v_actions jsonb := coalesce(p_invoice_actions, '[]'::jsonb);
  v_archive_tenant boolean := coalesce(p_archive_tenant, false);
  v_actor uuid := auth.uid();
  v_deposit_held numeric(14,3);
  v_deductions_total numeric(14,3);
  v_settled_total numeric(14,3);
  v_written_off_total numeric(14,3);
  v_refund_total numeric(14,3);
  v_balance_due numeric(14,3);
  v_tenant_archived boolean := false;
  v_action_rows jsonb := '[]'::jsonb;
  v_deduction_rows jsonb := '[]'::jsonb;
  v_contract_before jsonb;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated'
     and not public.has_permission(v_actor, 'contracts.close_out') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated'
     and not public.has_permission(v_actor, 'payments.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_actor is null then
    raise exception 'Authentication required to complete a close-out';
  end if;

  if p_outcome is null or p_outcome not in ('keep_terminated', 'freeze', 'archive') then
    raise exception 'p_outcome must be keep_terminated, freeze, or archive';
  end if;
  if p_final_contract_state is null or p_final_contract_state not in ('terminated', 'expired') then
    raise exception 'p_final_contract_state must be terminated or expired';
  end if;
  if p_move_out_date is null then
    raise exception 'p_move_out_date is required';
  end if;
  if p_move_out_date > (current_date + interval '1 year') then
    raise exception 'p_move_out_date cannot be more than one year in the future';
  end if;
  if v_archive_tenant and p_outcome <> 'archive' then
    raise exception 'p_archive_tenant is only allowed when p_outcome = archive';
  end if;
  if nullif(trim(p_idempotency_key), '') is null then
    raise exception 'p_idempotency_key is required';
  end if;

  select c.company_id into v_contract_company
    from public.contracts c
   where c.id = p_contract_id
     and (v_caller_company is null or c.company_id = v_caller_company);
  if not found then
    raise exception 'Contract not found';
  end if;

  if p_outcome = 'freeze' then
    v_header_final := 'frozen'::public.contract_states;
    v_final_state := 'frozen'::public.contract_states;
  else
    v_header_final := p_final_contract_state::public.contract_states;
    v_final_state := p_final_contract_state::public.contract_states;
  end if;

  -- Idempotency key is unique per (company_id, idempotency_key).
  select c.* into v_closeout
    from public.contract_closeouts c
   where c.idempotency_key = p_idempotency_key
     and c.company_id = v_contract_company
   for update;

  if found then
    if v_closeout.status = 'completed' then
      return v_closeout.result;
    end if;
    if v_closeout.status = 'cancelled' then
      raise exception 'This close-out was cancelled. Start a new one.';
    end if;
    if v_closeout.contract_id is distinct from p_contract_id then
      raise exception 'Idempotency key is bound to a different contract';
    end if;
  end if;

  -- Lock order: contracts -> tenants -> invoices (never lock units here).
  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id and c.company_id = v_contract_company
   for update;
  if not found then
    raise exception 'Contract not found';
  end if;

  perform 1 from public.tenants t where t.id = v_contract.tenant_id and t.company_id = v_contract_company for update;
  perform 1 from public.invoices i where i.contract_id = p_contract_id and i.company_id = v_contract_company order by i.id for update;

  if p_expected_contract_updated_at is not null
     and v_contract.updated_at is distinct from p_expected_contract_updated_at then
    raise exception 'Contract was modified concurrently; refresh and retry'
      using errcode = 'serialization_failure';
  end if;
  if v_contract.archived_at is not null then
    raise exception 'Contract is already archived';
  end if;
  if v_contract.state in ('expired', 'terminated', 'renewed') then
    raise exception 'Contract is already ended (state = %)', v_contract.state;
  end if;

  v_settlement := public.closeout_compute_settlement(
    p_contract_id, v_deductions, v_actions, p_refund_amount
  );
  v_deposit_held := (v_settlement ->> 'deposit_held')::numeric;
  v_deductions_total := (v_settlement ->> 'deductions_total')::numeric;
  v_settled_total := (v_settlement ->> 'settled_total')::numeric;
  v_written_off_total := (v_settlement ->> 'written_off_total')::numeric;
  v_refund_total := (v_settlement ->> 'refund_total')::numeric;
  v_balance_due := (v_settlement ->> 'balance_due_tenant')::numeric;

  v_tenant_company := v_contract.company_id;
  select u.building_id into v_building_id
    from public.units u
    join public.contract_units cu on cu.unit_id = u.id
   where cu.contract_id = v_contract.id
   order by cu.line_order, cu.unit_id
   limit 1;

  if v_closeout.id is null then
    insert into public.contract_closeouts (
      contract_id, tenant_id, unit_id, building_id, company_id,
      status, outcome, final_contract_state, archive_tenant,
      move_out_date, deposit_held, deductions_total, settled_total,
      written_off_total, refund_total, balance_due_tenant,
      idempotency_key, contract_updated_at, note, created_by
    ) values (
      p_contract_id, v_contract.tenant_id,
      (select cu.unit_id from public.contract_units cu
        where cu.contract_id = v_contract.id
          and (select count(*) from public.contract_units c2 where c2.contract_id = v_contract.id) = 1),
      v_building_id, v_tenant_company,
      'draft', p_outcome, v_header_final, v_archive_tenant,
      p_move_out_date, v_deposit_held, v_deductions_total, v_settled_total,
      v_written_off_total, v_refund_total, v_balance_due,
      p_idempotency_key, v_contract.updated_at, p_note, v_actor
    ) returning * into v_closeout;
  else
    update public.contract_closeouts c
       set outcome = p_outcome,
           final_contract_state = v_header_final,
           archive_tenant = v_archive_tenant,
           move_out_date = p_move_out_date,
           deposit_held = v_deposit_held,
           deductions_total = v_deductions_total,
           settled_total = v_settled_total,
           written_off_total = v_written_off_total,
           refund_total = v_refund_total,
           balance_due_tenant = v_balance_due,
           contract_updated_at = v_contract.updated_at,
           note = p_note,
           unit_id = (select cu.unit_id from public.contract_units cu
             where cu.contract_id = v_contract.id
               and (select count(*) from public.contract_units c2 where c2.contract_id = v_contract.id) = 1),
           building_id = v_building_id,
           company_id = v_tenant_company
     where c.id = v_closeout.id and c.company_id = v_tenant_company
    returning * into v_closeout;
  end if;

  delete from public.contract_closeout_deductions d
   where d.closeout_id = v_closeout.id and d.company_id = v_tenant_company;
  insert into public.contract_closeout_deductions (
    company_id, closeout_id, line, kind, description_ar, description_en, amount
  )
  select v_tenant_company, v_closeout.id, row_number() over (),
         d.kind, d.description_ar, d.description_en, round(d.amount, 3)
    from jsonb_to_recordset(v_deductions) as d(
      kind text, description_ar text, description_en text, amount numeric
    );

  delete from public.contract_closeout_invoice_actions a
   where a.closeout_id = v_closeout.id and a.company_id = v_tenant_company;

  for v_action in
    select a.invoice_id, a.action, a.amount
      from jsonb_to_recordset(v_actions) as a(invoice_id uuid, action text, amount numeric)
     order by a.invoice_id
  loop
    select i.* into v_invoice
      from public.invoices i
     where i.id = v_action.invoice_id and i.company_id = v_tenant_company
     for update;

    v_prev_state := v_invoice.state;
    v_action_amount := 0;
    v_new_state := v_invoice.state;

    if v_action.action = 'leave' then
      v_action_amount := 0;
    elsif v_action.action = 'cancel' then
      update public.invoices i
         set state = 'cancelled'::public.invoice_states
       where i.id = v_invoice.id and i.company_id = v_tenant_company;
      v_new_state := 'cancelled'::public.invoice_states;
    elsif v_action.action = 'write_off' then
      v_action_amount := round(v_invoice.balance, 3);
      update public.invoices i
         set state = 'waived'::public.invoice_states
       where i.id = v_invoice.id and i.company_id = v_tenant_company;
      v_new_state := 'waived'::public.invoice_states;
    elsif v_action.action = 'mark_disputed' then
      update public.invoices i
         set disputed_at = now(),
             dispute_reason = coalesce(nullif(trim(p_note), ''), 'Disputed at contract close-out ' || v_contract.code),
             disputed_by = v_actor
       where i.id = v_invoice.id and i.company_id = v_tenant_company;
    elsif v_action.action = 'settle_from_deposit' then
      v_action_amount := round(v_action.amount, 3);
      v_settle_lines := v_settle_lines || jsonb_build_array(
        jsonb_build_object('invoice_id', v_invoice.id, 'amount', v_action_amount)
      );
    end if;

    insert into public.contract_closeout_invoice_actions (
      company_id, closeout_id, invoice_id, action, amount, previous_state, resulting_state
    ) values (
      v_tenant_company, v_closeout.id, v_invoice.id, v_action.action,
      v_action_amount, v_prev_state, v_new_state
    );
  end loop;

  if jsonb_array_length(v_settle_lines) > 0 then
    insert into public.payments (
      company_id, tenant_id, unit_id, method, amount, payment_date,
      reference, status, created_by
    ) values (
      v_tenant_company, v_contract.tenant_id,
      (select cu.unit_id from public.contract_units cu
        where cu.contract_id = v_contract.id
          and (select count(*) from public.contract_units c2 where c2.contract_id = v_contract.id) = 1),
      'cash'::public.payment_methods, v_settled_total, p_move_out_date,
      'CLOSEOUT:' || v_contract.code, 'confirmed', v_actor
    ) returning id into v_payment_id;

    perform * from public.apply_payment_allocation(v_payment_id, v_settle_lines);

    update public.contract_closeout_invoice_actions a
       set resulting_state = i.state
      from public.invoices i
     where a.closeout_id = v_closeout.id
       and a.company_id = v_tenant_company
       and a.invoice_id = i.id
       and a.action = 'settle_from_deposit';
  end if;

  if v_refund_total > 0 then
    v_refund_code := public.next_refund_code();
    insert into public.refunds (
      code, company_id, contract_id, tenant_id, unit_id, building_id,
      amount, refund_date, reason, post_action, status, created_by
    ) values (
      v_refund_code, v_tenant_company, p_contract_id, v_contract.tenant_id,
      (select cu.unit_id from public.contract_units cu
        where cu.contract_id = v_contract.id
          and (select count(*) from public.contract_units c2 where c2.contract_id = v_contract.id) = 1),
      v_building_id, v_refund_total, p_move_out_date,
      'Contract close-out ' || v_contract.code,
      'store'::public.refund_post_actions, 'posted', v_actor
    ) returning id into v_refund_id;
  end if;

  v_contract_before := to_jsonb(v_contract);

  update public.contracts
     set state = v_final_state,
         archived_at = case when p_outcome = 'archive' then now() else null end
   where id = p_contract_id and company_id = v_tenant_company;

  select c.* into v_contract from public.contracts c where c.id = p_contract_id;

  -- Portal account deactivation stays exclusively in trg_contract_deactivate_portal.
  if v_archive_tenant then
    update public.tenants
       set archived_at = now(), tenant_portal_enabled = false
     where id = v_contract.tenant_id and company_id = v_tenant_company;
    v_tenant_archived := true;
  end if;

  select u.status into v_unit_status
    from public.units u
    join public.contract_units cu on cu.unit_id = u.id
   where cu.contract_id = v_contract.id
   order by cu.line_order, cu.unit_id limit 1;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'line', d.line, 'kind', d.kind,
      'description_ar', d.description_ar, 'description_en', d.description_en, 'amount', d.amount
    ) order by d.line
  ), '[]'::jsonb) into v_deduction_rows
  from public.contract_closeout_deductions d
  where d.closeout_id = v_closeout.id and d.company_id = v_tenant_company;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'invoice_id', a.invoice_id, 'invoice_code', i.code,
      'action', a.action, 'amount', a.amount,
      'previous_state', a.previous_state::text, 'resulting_state', a.resulting_state::text
    ) order by a.invoice_id
  ), '[]'::jsonb) into v_action_rows
  from public.contract_closeout_invoice_actions a
  join public.invoices i on i.id = a.invoice_id
  where a.closeout_id = v_closeout.id and a.company_id = v_tenant_company;

  v_result := jsonb_build_object(
    'settlement_payment_id', v_payment_id, 'closeout_id', v_closeout.id, 'status', 'completed',
    'contract_id', p_contract_id, 'contract_code', v_contract.code,
    'contract_state', v_contract.state::text, 'archived_at', v_contract.archived_at,
    'tenant_archived', v_tenant_archived, 'deposit_held', v_deposit_held,
    'deductions_total', v_deductions_total, 'settled_total', v_settled_total,
    'written_off_total', v_written_off_total, 'refund_total', v_refund_total,
    'balance_due_tenant', v_balance_due, 'refund_id', v_refund_id, 'refund_code', v_refund_code,
    'unit_id', (select cu.unit_id from public.contract_units cu
      where cu.contract_id = v_contract.id
        and (select count(*) from public.contract_units c2 where c2.contract_id = v_contract.id) = 1),
    'unit_ids', (select coalesce(jsonb_agg(cu.unit_id order by cu.line_order), '[]'::jsonb)
                   from public.contract_units cu where cu.contract_id = v_contract.id),
    'unit_status', v_unit_status::text, 'deductions', v_deduction_rows, 'invoice_actions', v_action_rows
  );

  update public.contract_closeouts c
     set status = 'completed', completed_by = v_actor, completed_at = now(),
         deposit_held = v_deposit_held, deductions_total = v_deductions_total,
         settled_total = v_settled_total, written_off_total = v_written_off_total,
         refund_total = v_refund_total, balance_due_tenant = v_balance_due,
         refund_id = v_refund_id, result = v_result
   where c.id = v_closeout.id and c.company_id = v_tenant_company;

  perform public.write_audit(
    'contract.close_out', 'contract', p_contract_id, v_contract_before, v_result, 'success', null
  );

  if v_refund_id is not null then
    perform public.write_audit(
      'refund.create', 'refund', v_refund_id, null,
      jsonb_build_object(
        'refund_id', v_refund_id, 'refund_code', v_refund_code,
        'amount', v_refund_total, 'contract_id', p_contract_id
      ), 'success', null
    );
  end if;

  for v_action in
    select a.invoice_id, a.action, a.amount, a.previous_state
      from public.contract_closeout_invoice_actions a
     where a.closeout_id = v_closeout.id
       and a.company_id = v_tenant_company
       and a.action in ('write_off', 'cancel')
  loop
    if v_action.action = 'write_off' then
      perform public.write_audit(
        'invoice.write_off', 'invoice', v_action.invoice_id,
        jsonb_build_object('state', v_action.previous_state::text),
        jsonb_build_object('state', 'waived', 'balance_written_off', v_action.amount, 'closeout_id', v_closeout.id),
        'success', null
      );
    elsif v_action.action = 'cancel' then
      perform public.write_audit(
        'invoice.update', 'invoice', v_action.invoice_id,
        jsonb_build_object('state', v_action.previous_state::text),
        jsonb_build_object('state', 'cancelled', 'closeout_id', v_closeout.id),
        'success', null
      );
    end if;
  end loop;

  if v_tenant_archived then
    perform public.write_audit(
      'tenant.archive', 'tenant', v_contract.tenant_id, null,
      jsonb_build_object('tenant_id', v_contract.tenant_id, 'closeout_id', v_closeout.id),
      'success', null
    );
  end if;

  insert into public.contract_operational_events (
    company_id, contract_id, tenant_id, closeout_id, event_type, actor_id, payload, note
  ) values (
    v_tenant_company, p_contract_id, v_contract.tenant_id, v_closeout.id,
    'closeout_completed', v_actor, v_result, p_note
  );

  if v_tenant_archived then
    insert into public.contract_operational_events (
      company_id, contract_id, tenant_id, closeout_id, event_type, actor_id, payload
    ) values (
      v_tenant_company, p_contract_id, v_contract.tenant_id, v_closeout.id,
      'archived', v_actor, jsonb_build_object('tenant_id', v_contract.tenant_id)
    );
  end if;

  insert into public.contract_operational_events (
    company_id, contract_id, tenant_id, closeout_id, event_type, actor_id, payload
  )
  select v_tenant_company, p_contract_id, v_contract.tenant_id, v_closeout.id,
         case a.action
           when 'write_off' then 'invoice_written_off'
           when 'mark_disputed' then 'invoice_disputed'
         end,
         v_actor,
         jsonb_build_object('invoice_id', a.invoice_id, 'action', a.action, 'amount', a.amount)
    from public.contract_closeout_invoice_actions a
   where a.closeout_id = v_closeout.id
     and a.company_id = v_tenant_company
     and a.action in ('write_off', 'mark_disputed');

  return v_result;
end;
$function$;

-- يرجع معاينة تصفية العقد دون كتابة مع التحقق من نطاق الشركة.
CREATE OR REPLACE FUNCTION public.get_contract_closeout_preview(
  p_contract_id uuid, p_deductions jsonb, p_invoice_actions jsonb, p_refund_amount numeric
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_contract public.contracts%rowtype;
  v_settlement jsonb;
  v_unit_status public.unit_status;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'contracts.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
     and (v_caller_company is null or c.company_id = v_caller_company);
  if not found then
    raise exception 'Contract not found';
  end if;

  v_settlement := public.closeout_compute_settlement(
    p_contract_id, coalesce(p_deductions, '[]'::jsonb), coalesce(p_invoice_actions, '[]'::jsonb), p_refund_amount
  );

  select u.status into v_unit_status
    from public.units u
    join public.contract_units cu on cu.unit_id = u.id
   where cu.contract_id = v_contract.id
   order by cu.line_order, cu.unit_id limit 1;

  return v_settlement || jsonb_build_object(
    'contract_id', p_contract_id, 'contract_code', v_contract.code,
    'contract_state', v_contract.state::text, 'archived_at', v_contract.archived_at,
    'unit_id', (select cu.unit_id from public.contract_units cu
      where cu.contract_id = v_contract.id
        and (select count(*) from public.contract_units c2 where c2.contract_id = v_contract.id) = 1),
    'unit_ids', (select coalesce(jsonb_agg(cu.unit_id order by cu.line_order), '[]'::jsonb)
                   from public.contract_units cu where cu.contract_id = v_contract.id),
    'unit_status', v_unit_status::text
  );
end;
$function$;

-- يستعيد العقد المؤرشف ضمن نطاق شركة المستدعي بعد التحقق من خلو وحداته.
CREATE OR REPLACE FUNCTION public.restore_contract(
  p_contract_id uuid, p_target_state text, p_restore_tenant boolean, p_reason text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_contract public.contracts%rowtype;
  v_actor uuid := auth.uid();
  v_unit_status public.unit_status;
  v_result jsonb;
  v_holder uuid;
  v_holder_unit uuid;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated'
     and not public.has_permission(v_actor, 'contracts.restore') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A restore reason is required';
  end if;
  if p_target_state is null or p_target_state not in (
    'draft', 'active', 'frozen', 'suspended', 'expired', 'terminated', 'renewed'
  ) then
    raise exception 'Invalid p_target_state: %', p_target_state;
  end if;

  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
     and (v_caller_company is null or c.company_id = v_caller_company)
   for update;
  if not found then
    raise exception 'Contract not found';
  end if;

  perform 1 from public.tenants t where t.id = v_contract.tenant_id and t.company_id = v_contract.company_id for update;
  if v_contract.archived_at is null then
    raise exception 'Contract is not archived';
  end if;

  select c2.id, cu2.unit_id into v_holder, v_holder_unit
    from public.contract_units cu
    join public.contract_units cu2 on cu2.unit_id = cu.unit_id
    join public.contracts c2 on c2.id = cu2.contract_id
   where cu.contract_id = p_contract_id
     and c2.company_id = v_contract.company_id
     and c2.id <> p_contract_id
     and c2.archived_at is null
     and c2.state in ('draft', 'active', 'frozen', 'suspended')
   order by cu2.unit_id limit 1;
  if v_holder is not null then
    raise exception 'Cannot restore: another live contract (%) holds unit %', v_holder, v_holder_unit;
  end if;

  update public.contracts
     set state = p_target_state::public.contract_states, archived_at = null
   where id = p_contract_id and company_id = v_contract.company_id;

  select c.* into v_contract from public.contracts c where c.id = p_contract_id;

  if coalesce(p_restore_tenant, false) then
    update public.tenants
       set archived_at = null, tenant_portal_enabled = true
     where id = v_contract.tenant_id and company_id = v_contract.company_id;
  end if;

  select u.status into v_unit_status
    from public.units u
    join public.contract_units cu on cu.unit_id = u.id
   where cu.contract_id = v_contract.id
   order by cu.line_order, cu.unit_id limit 1;

  v_result := jsonb_build_object(
    'contract_id', p_contract_id, 'contract_code', v_contract.code,
    'contract_state', v_contract.state::text, 'archived_at', v_contract.archived_at,
    'unit_id', (select cu.unit_id from public.contract_units cu
      where cu.contract_id = v_contract.id
        and (select count(*) from public.contract_units c2 where c2.contract_id = v_contract.id) = 1),
    'unit_ids', (select coalesce(jsonb_agg(cu.unit_id order by cu.line_order), '[]'::jsonb)
                   from public.contract_units cu where cu.contract_id = v_contract.id),
    'unit_status', v_unit_status::text, 'tenant_id', v_contract.tenant_id, 'reason', trim(p_reason)
  );

  perform public.write_audit(
    'contract.restore', 'contract', p_contract_id, null, v_result, 'success', null
  );

  insert into public.contract_operational_events (
    company_id, contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    v_contract.company_id, p_contract_id, v_contract.tenant_id,
    'restored', v_actor, v_result, trim(p_reason)
  );

  return v_result;
end;
$function$;

-- يحسب مبلغ الكهرباء وفق التعرفة والشرائح ضمن نطاق شركة المستدعي.
CREATE OR REPLACE FUNCTION public.compute_electricity_amount(p_tariff_id uuid, p_consumption numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_tariff public.electricity_tariffs%rowtype;
  v_tier jsonb;
  v_from numeric;
  v_to numeric;
  v_price numeric;
  v_expected_from numeric := 0;
  v_amount numeric := 0;
  v_open_ended boolean := false;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
  if p_consumption is null or p_consumption < 0 then
    raise exception 'Consumption must be zero or positive';
  end if;

  select et.* into v_tariff
    from public.electricity_tariffs et
   where et.id = p_tariff_id
     and (v_caller_company is null or et.company_id = v_caller_company);
  if not found then raise exception 'Electricity tariff not found'; end if;

  if v_tariff.type = 'flat' then return round(v_tariff.unit_price, 3); end if;
  if v_tariff.type = 'per_unit' then return round(p_consumption * v_tariff.unit_price, 3); end if;
  if v_tariff.tiers is null or jsonb_typeof(v_tariff.tiers) <> 'array'
    or jsonb_array_length(v_tariff.tiers) = 0 then
    raise exception 'Tiered tariff requires a non-empty tiers array';
  end if;

  for v_tier in select value from jsonb_array_elements(v_tariff.tiers)
  loop
    if jsonb_typeof(v_tier) <> 'object'
      or jsonb_typeof(v_tier -> 'from_kwh') <> 'number'
      or jsonb_typeof(v_tier -> 'price_per_kwh') <> 'number'
      or not (v_tier ? 'to_kwh')
      or jsonb_typeof(v_tier -> 'to_kwh') not in ('number', 'null') then
      raise exception 'Each tariff tier requires numeric from_kwh and price_per_kwh and a numeric or null to_kwh';
    end if;

    v_from := (v_tier ->> 'from_kwh')::numeric;
    v_price := (v_tier ->> 'price_per_kwh')::numeric;
    v_to := case when jsonb_typeof(v_tier -> 'to_kwh') = 'null'
      then null else (v_tier ->> 'to_kwh')::numeric end;

    if v_open_ended or v_from <> v_expected_from then
      raise exception 'Tariff tiers must be ordered, contiguous, and start at zero';
    end if;
    if v_from < 0 or v_price < 0 or (v_to is not null and v_to <= v_from) then
      raise exception 'Tariff tier boundaries and prices are invalid';
    end if;

    if p_consumption > v_from then
      v_amount := v_amount + (
        case when v_to is null then p_consumption - v_from
          else greatest(0, least(p_consumption, v_to) - v_from) end
      ) * v_price;
    end if;

    if v_to is null then v_open_ended := true; else v_expected_from := v_to; end if;
  end loop;

  if not v_open_ended and p_consumption > v_expected_from then
    raise exception 'Tiered tariff does not cover the supplied consumption';
  end if;
  return round(v_amount, 3);
end;
$function$;

-- يولّد رسوم الكهرباء المسودة للفترة المحددة ضمن نطاق شركة المستدعي.
CREATE OR REPLACE FUNCTION public.generate_electricity_charges(
  p_period_year integer, p_period_month integer, p_unit_id uuid DEFAULT NULL::uuid
)
 RETURNS TABLE(charge_id uuid, code text, unit_id uuid, amount numeric, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_period_start date;
  v_period_end date;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'electricity.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if p_period_year < 2000 or p_period_year > 2200
    or p_period_month < 1 or p_period_month > 12 then
    raise exception 'Electricity charge period is invalid';
  end if;

  v_period_start := make_date(p_period_year, p_period_month, 1);
  v_period_end := (v_period_start + interval '1 month - 1 day')::date;

  return query
  with eligible as (
    select em.company_id, em.id as meter_id, em.unit_id, em.ownership, em.tariff_id,
      mr.id as reading_id, mr.consumption_kwh,
      case when em.ownership = 'tenant_owned' then c.tenant_id else null end as tenant_id,
      et.currency
    from public.electricity_meters em
    join public.meter_readings mr on mr.meter_id = em.id
      and mr.company_id = em.company_id
      and mr.period_year = p_period_year and mr.period_month = p_period_month
    join public.electricity_tariffs et on et.id = em.tariff_id
      and et.company_id = em.company_id and et.is_active
    left join lateral (
      select ct.tenant_id
        from public.contract_units cu
        join public.contracts ct on ct.id = cu.contract_id
       where cu.unit_id = em.unit_id
         and ct.company_id = em.company_id
         and ct.state = 'active'
         and ct.start_date <= v_period_end
         and ct.end_date >= v_period_start
       order by ct.start_date desc, ct.id
       limit 1
    ) c on true
    where em.is_active
      and (v_caller_company is null or em.company_id = v_caller_company)
      and (p_unit_id is null or em.unit_id = p_unit_id)
      and (em.ownership = 'company_owned' or c.tenant_id is not null)
  ), inserted as (
    insert into public.electricity_charges (
      company_id, meter_id, unit_id, tenant_id, reading_id, period_year, period_month,
      consumption_kwh, amount, currency, status
    )
    select e.company_id, e.meter_id, e.unit_id, e.tenant_id, e.reading_id,
      p_period_year, p_period_month, e.consumption_kwh,
      public.compute_electricity_amount(e.tariff_id, e.consumption_kwh),
      e.currency, 'draft'
    from eligible e
    on conflict (meter_id, period_year, period_month) do nothing
    returning electricity_charges.id, electricity_charges.code,
      electricity_charges.unit_id, electricity_charges.amount, electricity_charges.status
  )
  select inserted.id, inserted.code, inserted.unit_id,
    inserted.amount, inserted.status from inserted;
end;
$function$;

-- يحمي قراءات العدادات بعد اعتماد رسومها ويحذف المسودات المتأثرة ضمن الشركة.
CREATE OR REPLACE FUNCTION public.protect_charged_meter_reading()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_old_company uuid := coalesce(public.current_company_id(), old.company_id);
  v_new_company uuid := coalesce(public.current_company_id(), new.company_id);
begin
  if exists (
    select 1 from public.electricity_charges ec
     where ec.meter_id = old.meter_id and ec.company_id = v_old_company
       and ec.status <> 'draft'
       and (ec.period_year, ec.period_month) >= (old.period_year, old.period_month)
  ) then
    raise exception 'Reading cannot change after this or a following charge is finalized';
  end if;
  if tg_op = 'UPDATE'
    and (new.meter_id, new.period_year, new.period_month)
      is distinct from (old.meter_id, old.period_year, old.period_month)
    and exists (
      select 1 from public.electricity_charges ec
       where ec.meter_id = new.meter_id and ec.company_id = v_new_company
         and ec.status <> 'draft'
         and (ec.period_year, ec.period_month) >= (new.period_year, new.period_month)
    ) then
    raise exception 'Reading cannot move before a finalized charge';
  end if;
  if tg_op = 'DELETE' or (
    new.meter_id, new.period_year, new.period_month
  ) is distinct from (old.meter_id, old.period_year, old.period_month) then
    delete from public.electricity_charges ec
     where ec.meter_id = old.meter_id and ec.company_id = v_old_company
       and ec.period_year = old.period_year and ec.period_month = old.period_month
       and ec.status = 'draft';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

-- يحدّث مسودة رسم الكهرباء عند تغيّر القراءة ضمن الشركة.
CREATE OR REPLACE FUNCTION public.refresh_draft_charge_for_reading()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
begin
  update public.electricity_charges ec
     set reading_id = new.id,
         consumption_kwh = new.consumption_kwh,
         amount = public.compute_electricity_amount(em.tariff_id, new.consumption_kwh),
         currency = et.currency
    from public.electricity_meters em
    join public.electricity_tariffs et on et.id = em.tariff_id and et.company_id = v_company_id
   where ec.meter_id = new.meter_id
     and ec.company_id = v_company_id
     and ec.period_year = new.period_year
     and ec.period_month = new.period_month
     and ec.status = 'draft'
     and em.id = new.meter_id
     and em.company_id = v_company_id;
  return null;
end;
$function$;

-- يعيد احتساب القراءة اللاحقة للعداد بعد الإدراج أو التعديل أو الحذف ضمن الشركة.
CREATE OR REPLACE FUNCTION public.sync_following_meter_reading()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id, old.company_id);
  v_old_next uuid;
  v_new_next uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select mr.id into v_old_next
      from public.meter_readings mr
     where mr.meter_id = old.meter_id and mr.company_id = v_company_id
       and (mr.period_year, mr.period_month) > (old.period_year, old.period_month)
     order by mr.period_year, mr.period_month limit 1;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select mr.id into v_new_next
      from public.meter_readings mr
     where mr.meter_id = new.meter_id and mr.company_id = v_company_id
       and (mr.period_year, mr.period_month) > (new.period_year, new.period_month)
     order by mr.period_year, mr.period_month limit 1;
  end if;

  if v_old_next is not null then
    update public.meter_readings set reading = reading where id = v_old_next and company_id = v_company_id;
  end if;
  if v_new_next is not null and v_new_next is distinct from v_old_next then
    update public.meter_readings set reading = reading where id = v_new_next and company_id = v_company_id;
  end if;
  return null;
end;
$function$;

-- يتحقق من صحة إدراج رسم الكهرباء ويربطه بالشركة والوحدة والتعرفة.
CREATE OR REPLACE FUNCTION public.validate_electricity_charge_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
  v_meter public.electricity_meters%rowtype;
  v_reading public.meter_readings%rowtype;
  v_tariff public.electricity_tariffs%rowtype;
  v_tenant_id uuid;
  v_period_start date;
  v_period_end date;
begin
  if new.status <> 'draft' then
    raise exception 'Electricity charges must be created as drafts';
  end if;

  select em.* into v_meter
    from public.electricity_meters em
   where em.id = new.meter_id
     and (v_company_id is null or em.company_id = v_company_id)
     and em.is_active;
  if not found then raise exception 'Active electricity meter not found'; end if;

  select mr.* into v_reading
    from public.meter_readings mr
   where mr.id = new.reading_id
     and mr.meter_id = new.meter_id
     and mr.company_id = v_meter.company_id
     and mr.period_year = new.period_year
     and mr.period_month = new.period_month;
  if not found then raise exception 'Matching meter reading not found'; end if;

  select et.* into v_tariff
    from public.electricity_tariffs et
   where et.id = v_meter.tariff_id
     and et.company_id = v_meter.company_id
     and et.is_active;
  if not found then raise exception 'Active electricity tariff not found'; end if;

  v_period_start := make_date(new.period_year, new.period_month, 1);
  v_period_end := (v_period_start + interval '1 month - 1 day')::date;
  if v_meter.ownership = 'tenant_owned' then
    select c.tenant_id into v_tenant_id
      from public.contract_units cu
      join public.contracts c on c.id = cu.contract_id
     where cu.unit_id = v_meter.unit_id
       and c.company_id = v_meter.company_id
       and c.state = 'active'
       and c.start_date <= v_period_end and c.end_date >= v_period_start
     order by c.start_date desc, c.id limit 1;
    if v_tenant_id is null then
      raise exception 'Tenant-owned meter has no active contract for the charge period';
    end if;
  end if;

  new.company_id := v_meter.company_id;
  new.unit_id := v_meter.unit_id;
  new.tenant_id := v_tenant_id;
  new.consumption_kwh := v_reading.consumption_kwh;
  new.amount := public.compute_electricity_amount(v_meter.tariff_id, v_reading.consumption_kwh);
  new.currency := v_tariff.currency;
  return new;
end;
$function$;

-- يولّد مسيّر رواتب الشهر للموظفين النشطين ضمن نطاق الشركة ومفتاح التكرار المحدّث.
CREATE OR REPLACE FUNCTION public.generate_salaries_for_month(
  p_year integer DEFAULT NULL::integer, p_month integer DEFAULT NULL::integer
)
 RETURNS SETOF salaries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_year integer := coalesce(p_year, extract(year from current_date)::integer);
  v_month integer := coalesce(p_month, extract(month from current_date)::integer);
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'salaries.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_year < 2000 or v_year > 2200 then
    raise exception 'Target year is outside the supported range';
  end if;
  if v_month < 1 or v_month > 12 then
    raise exception 'Target month is outside the supported range';
  end if;

  return query
  insert into public.salaries (company_id, employee_id, year, month, amount)
  select e.company_id, e.id, v_year, v_month, e.salary
    from public.employees e
   where e.is_active
     and (v_caller_company is null or e.company_id = v_caller_company)
   order by e.code
  on conflict (company_id, employee_id, year, month) do nothing
  returning *;
end;
$function$;

REVOKE ALL ON FUNCTION public.protect_charged_meter_reading() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.refresh_draft_charge_for_reading() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sync_following_meter_reading() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.validate_electricity_charge_insert() FROM PUBLIC, anon;

REVOKE ALL ON FUNCTION public.cancel_contract_closeout(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_contract_closeout(uuid, text) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.closeout_compute_settlement(uuid, jsonb, jsonb, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.closeout_compute_settlement(uuid, jsonb, jsonb, numeric) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.close_out_contract(uuid, date, text, text, boolean, jsonb, jsonb, numeric, text, text, timestamp with time zone) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_out_contract(uuid, date, text, text, boolean, jsonb, jsonb, numeric, text, text, timestamp with time zone) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.get_contract_closeout_preview(uuid, jsonb, jsonb, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_contract_closeout_preview(uuid, jsonb, jsonb, numeric) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.restore_contract(uuid, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_contract(uuid, text, boolean, text) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.compute_electricity_amount(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_electricity_amount(uuid, numeric) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.generate_electricity_charges(integer, integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_electricity_charges(integer, integer, uuid) TO authenticated, company_service, service_role;

REVOKE ALL ON FUNCTION public.generate_salaries_for_month(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_salaries_for_month(integer, integer) TO authenticated, company_service, service_role;
