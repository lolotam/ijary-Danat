-- 310 (T071): the money event outbox — the contract close-out events.
-- close_out_contract emits contract.closed_out and refund.recorded, and
-- restore_contract emits contract.restored, each from the transaction that
-- changed the contract (FR-018). The grants of both functions are unchanged.

-- 1. contract.closed_out and refund.recorded — the close-out of a contract

/** ينفّذ تصفية العقد ذرياً، ويخرج حدثي `contract.closed_out` و`refund.recorded` مع المعاملة نفسها (FR-018). */

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
  v_caller_company uuid := public.current_company_id_strict();
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
    -- Money outbox (T071): the refund row exists, so the event leaves with the
    -- row that records it (FR-018).
    if v_caller_company is not null then
      perform public.enqueue_job(
        'refund.recorded', jsonb_build_object('refundId', v_refund_id),
        'refund.recorded:' || v_refund_id::text);
    else
      -- A platform close-out has no company context: the event goes to that company.
      perform public.enqueue_job_for_company(v_tenant_company, 'refund.recorded',
        jsonb_build_object('refundId', v_refund_id), 'refund.recorded:' || v_refund_id::text);
    end if;
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
  -- Money outbox (T071): the close-out is completed, so the event leaves with
  -- it (FR-018). The close-out row id is part of the key because a contract
  -- that was restored can be closed out again, and that second close-out is a
  -- new event, not a duplicate of the first.
  if v_caller_company is not null then
    perform public.enqueue_job(
      'contract.closed_out', jsonb_build_object('contractId', p_contract_id),
      'contract.closed_out:' || p_contract_id::text || ':' || v_closeout.id::text);
  else
    -- A platform close-out has no company context: the event goes to that company.
    perform public.enqueue_job_for_company(v_tenant_company, 'contract.closed_out',
      jsonb_build_object('contractId', p_contract_id), 'contract.closed_out:' || p_contract_id::text || ':' || v_closeout.id::text);
  end if;

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

-- 2. contract.restored — the restore of a closed-out contract

/** يستعيد العقد المؤرشف ضمن نطاق شركة المستدعي، ويخرج حدث `contract.restored` مع المعاملة نفسها (FR-018). */

CREATE OR REPLACE FUNCTION public.restore_contract(
  p_contract_id uuid, p_target_state text, p_restore_tenant boolean, p_reason text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_contract public.contracts%rowtype;
  v_actor uuid := auth.uid();
  v_unit_status public.unit_status;
  v_result jsonb;
  v_holder uuid;
  v_holder_unit uuid;
  v_audit_id uuid;
begin
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

  v_audit_id := public.write_audit(
    'contract.restore', 'contract', p_contract_id, null, v_result, 'success', null
  );
  -- Money outbox (T071): the contract is live again, so the event leaves with
  -- the restore (FR-018). The audit row id is part of the key because a
  -- contract can be restored again after another close-out, and each restore
  -- is its own event.
  if v_caller_company is not null then
    perform public.enqueue_job(
      'contract.restored', jsonb_build_object('contractId', p_contract_id),
      'contract.restored:' || p_contract_id::text || ':' || v_audit_id::text);
  else
    -- A platform restore has no company context: the event goes to that company.
    perform public.enqueue_job_for_company(v_contract.company_id, 'contract.restored',
      jsonb_build_object('contractId', p_contract_id), 'contract.restored:' || p_contract_id::text || ':' || v_audit_id::text);
  end if;

  insert into public.contract_operational_events (
    company_id, contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    v_contract.company_id, p_contract_id, v_contract.tenant_id,
    'restored', v_actor, v_result, trim(p_reason)
  );

  return v_result;
end;
$function$;
