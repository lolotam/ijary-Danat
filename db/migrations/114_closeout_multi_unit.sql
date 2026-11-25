-- ---------------------------------------------------------------------------
-- 114 - contract close-out / restore onto contract_units
-- ---------------------------------------------------------------------------
--
-- Part of the multi-unit-contracts feature (see migration 113's header for
-- the shared context: contract_units replaces contracts.unit_id, which is
-- dropped at the end of the feature, so every SQL function reading it must
-- move onto contract_units first). This migration covers the close-out RPC
-- family from 87_contract_closeout_rpcs.sql, the last surviving reader of
-- v_contract.unit_id outside migration 113's two functions.
--
-- New file, not an edit: functions here are create-or-replace and the live
-- definition is whichever migration has the highest number (db/README.md).
-- 87 is still the only definition of every function it declares (confirmed
-- by grep across db/migrations) — editing 87 in place would not reach a
-- database that already applied it.
--
-- Functions re-issued below, and why: of the five functions in 87, only
-- three read v_contract.unit_id — close_out_contract, restore_contract,
-- get_contract_closeout_preview. closeout_compute_settlement is pure invoice/
-- deposit arithmetic and never touches unit_id; cancel_contract_closeout
-- never references v_contract at all. Neither is touched here, and neither
-- needs a grant/revoke restatement since their bodies are unchanged.
--
-- Signature check: none of the three re-issued functions change their
-- parameter list or return type (all `returns jsonb`, no `returns table`).
-- Plain `create or replace function` is therefore safe — this migration does
-- NOT hit the OUT-parameter-row-type trap called out in 87's own header for
-- identify_contract_expiry_reminders.
--
-- Single-unit-or-null expression (used everywhere v_contract.unit_id was
-- read to populate another row, i.e. change B1 and the 'unit_id' key in
-- change B4): the contract's unit_id when it has exactly one contract_units
-- row, NULL for zero or several. NOTE — corrected form per coordinator
-- review: an earlier draft used a bare `having count(*) = 1` with no
-- `group by`, which makes the subquery a single-group aggregate and raises
-- 42803 ("column cu.unit_id must appear in the GROUP BY clause or be used in
-- an aggregate function"). CREATE OR REPLACE does not execute the function
-- body, so that form would have created cleanly and only failed at call
-- time, inside close-out — a money path. The count is pushed into a WHERE
-- subquery instead, which is valid by construction:
--
--   (select cu.unit_id from public.contract_units cu
--     where cu.contract_id = v_contract.id
--       and (select count(*) from public.contract_units c2
--              where c2.contract_id = v_contract.id) = 1)
--
-- contract_closeouts.unit_id must tolerate NULL now that a closed-out
-- contract can hold more than one unit (the single-unit-or-null expression
-- above legitimately produces NULL for 0 or >1 units). Checked against the
-- source rather than assumed: 84_contract_closeouts.sql:27 declares the
-- column `unit_id uuid references public.units(id) on delete set null` —
-- already nullable, no NOT NULL anywhere in that file or any later one
-- (grepped `alter table public.contract_closeouts` across db/migrations —
-- only the RLS-enable statement in 84 matches). The DROP NOT NULL below is
-- therefore a no-op today, kept as defensive, self-documenting intent in
-- case a future migration ever tightens the column — not a fix for a
-- present constraint violation.

alter table public.contract_closeouts alter column unit_id drop not null;

------------------------------------------------------------
-- 0. closeout_compute_settlement — UNCHANGED, not re-issued.
--    Pure arithmetic over invoices/insurance_payments; never reads
--    contracts.unit_id. Live definition stays 87_contract_closeout_rpcs.sql.
------------------------------------------------------------

------------------------------------------------------------
-- 1. Re-issue close_out_contract
--    (live definition: 87_contract_closeout_rpcs.sql, ~line 292)
--
--    Changes from 87, by category:
--    * B2 (building resolution, ~line 466): lowest-line_order unit via
--      contract_units instead of `where u.id = v_contract.unit_id`.
--    * B1 (record the unit on the closeout row, ~lines 471/477 insert,
--      ~line 499 update): single-unit-or-null expression above.
--    * B2 (unit status read after the contracts update, ~line 674):
--      lowest-line_order unit via contract_units.
--    * B4 (result jsonb, ~line 722): kept the 'unit_id' key (now the
--      single-unit-or-null expression) and added 'unit_ids'.
--    * Additional, found while moving this function off contracts.unit_id
--      and not in the original B1-B4 categories, but confirmed required
--      (contracts.unit_id is dropped in migration 117 and these two writes
--      would fail at runtime on this money path once that lands):
--      the `payments` insert (~lines 592-606) and the `refunds` insert
--      (~lines 622-641) both now use the same single-unit-or-null
--      expression for unit_id instead of v_contract.unit_id. Both target
--      columns are nullable (payments.unit_id: 05_phase3_invoices_payments
--      line 83 "references units(id) on delete set null"; refunds.unit_id:
--      56_refunds_partial_insurance line 54, same shape, no `not null`), so
--      NULL — meaning "this payment/refund settles a consolidated
--      multi-unit contract, not any single unit" — is a legal, truthful
--      value, not a compile-only fix.
--
--    Everything else in the function body, including all step-numbered
--    comments, is byte-identical to 87.
------------------------------------------------------------

create or replace function public.close_out_contract(
  p_contract_id uuid,
  p_move_out_date date,
  p_outcome text,
  p_final_contract_state text,
  p_archive_tenant boolean,
  p_deductions jsonb,
  p_invoice_actions jsonb,
  p_refund_amount numeric,
  p_note text,
  p_idempotency_key text,
  p_expected_contract_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
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
  -- 1. Permission: close-out AND payments.create (settle path re-checks the
  -- latter inside apply_payment_allocation — fail early with a clear message).
  if auth.role() = 'authenticated'
     and not public.has_permission(v_actor, 'contracts.close_out') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated'
     and not public.has_permission(v_actor, 'payments.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- completed_by is required by closeout_completed_needs_actor. Close-out is
  -- operator-driven; there is no system/cron path.
  if v_actor is null then
    raise exception 'Authentication required to complete a close-out';
  end if;

  -- 2. Input validation
  if p_outcome is null
     or p_outcome not in ('keep_terminated', 'freeze', 'archive') then
    raise exception 'p_outcome must be keep_terminated, freeze, or archive';
  end if;
  if p_final_contract_state is null
     or p_final_contract_state not in ('terminated', 'expired') then
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

  -- Header final_contract_state: freeze stores frozen; otherwise the caller's
  -- terminated|expired (ignored for the contracts row when outcome = freeze).
  if p_outcome = 'freeze' then
    v_header_final := 'frozen'::public.contract_states;
    v_final_state := 'frozen'::public.contract_states;
  else
    v_header_final := p_final_contract_state::public.contract_states;
    v_final_state := p_final_contract_state::public.contract_states;
  end if;

  -- 3. Idempotency lookup BEFORE any write
  select c.* into v_closeout
    from public.contract_closeouts c
   where c.idempotency_key = p_idempotency_key
   for update;

  if found then
    if v_closeout.status = 'completed' then
      -- Exact replay of the stored result.
      return v_closeout.result;
    end if;
    if v_closeout.status = 'cancelled' then
      raise exception 'This close-out was cancelled. Start a new one.';
    end if;
    -- status = 'draft' → reuse that row id, fall through
    if v_closeout.contract_id is distinct from p_contract_id then
      raise exception 'Idempotency key is bound to a different contract';
    end if;
  end if;

  -- 4. LOCK ORDER — contracts, then tenants, then invoices ascending id.
  -- TAKE NO units LOCK.
  --
  -- Why: three AFTER triggers on contracts fire in name order —
  --   trg_contract_deactivate_portal  (writes profiles)
  --   trg_contract_sync_tenant_lifecycle (writes tenants)
  --   trg_contract_sync_unit_status   (locks units ascending-uuid, LAST)
  -- Taking units before updating contracts inverts that chain and IS the deadlock.
  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
   for update;
  if not found then
    raise exception 'Contract not found';
  end if;

  perform 1 from public.tenants t where t.id = v_contract.tenant_id for update;

  perform 1
    from public.invoices i
   where i.contract_id = p_contract_id
   order by i.id
   for update;

  -- 5. Staleness
  if p_expected_contract_updated_at is not null
     and v_contract.updated_at is distinct from p_expected_contract_updated_at then
    raise exception 'Contract was modified concurrently; refresh and retry'
      using errcode = 'serialization_failure';
  end if;

  -- 6–7. Already closed / already ended
  if v_contract.archived_at is not null then
    raise exception 'Contract is already archived';
  end if;
  if v_contract.state in ('expired', 'terminated', 'renewed') then
    raise exception 'Contract is already ended (state = %)', v_contract.state;
  end if;

  -- 8–14. Shared arithmetic (also validates invoice coverage / deposit math)
  v_settlement := public.closeout_compute_settlement(
    p_contract_id, v_deductions, v_actions, p_refund_amount
  );
  v_deposit_held := (v_settlement ->> 'deposit_held')::numeric;
  v_deductions_total := (v_settlement ->> 'deductions_total')::numeric;
  v_settled_total := (v_settlement ->> 'settled_total')::numeric;
  v_written_off_total := (v_settlement ->> 'written_off_total')::numeric;
  v_refund_total := (v_settlement ->> 'refund_total')::numeric;
  v_balance_due := (v_settlement ->> 'balance_due_tenant')::numeric;

  select t.company_id into v_tenant_company
    from public.tenants t where t.id = v_contract.tenant_id;
  select u.building_id into v_building_id
    from public.units u
    join public.contract_units cu on cu.unit_id = u.id
   where cu.contract_id = v_contract.id
   order by cu.line_order, cu.unit_id
   limit 1;

  -- Insert or refresh the draft header
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
          and (select count(*) from public.contract_units c2
                 where c2.contract_id = v_contract.id) = 1),
      v_building_id,
      v_tenant_company,
      'draft', p_outcome, v_header_final, v_archive_tenant,
      p_move_out_date, v_deposit_held, v_deductions_total, v_settled_total,
      v_written_off_total, v_refund_total, v_balance_due,
      p_idempotency_key, v_contract.updated_at, p_note, v_actor
    )
    returning * into v_closeout;
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
               and (select count(*) from public.contract_units c2
                      where c2.contract_id = v_contract.id) = 1),
           building_id = v_building_id,
           company_id = v_tenant_company
     where c.id = v_closeout.id
    returning * into v_closeout;
  end if;

  -- 9. Replace deduction lines
  delete from public.contract_closeout_deductions d where d.closeout_id = v_closeout.id;
  insert into public.contract_closeout_deductions (
    closeout_id, line, kind, description_ar, description_en, amount
  )
  select v_closeout.id,
         row_number() over (),
         d.kind,
         d.description_ar,
         d.description_en,
         round(d.amount, 3)
    from jsonb_to_recordset(v_deductions) as d(
      kind text, description_ar text, description_en text, amount numeric
    );

  -- Replace invoice action rows (rebuild after mutations for stored states)
  delete from public.contract_closeout_invoice_actions a where a.closeout_id = v_closeout.id;

  -- 12. Apply invoice actions, order by invoice_id
  for v_action in
    select a.invoice_id, a.action, a.amount
      from jsonb_to_recordset(v_actions) as a(invoice_id uuid, action text, amount numeric)
     order by a.invoice_id
  loop
    select i.* into v_invoice
      from public.invoices i
     where i.id = v_action.invoice_id
     for update;

    v_prev_state := v_invoice.state;
    v_action_amount := 0;
    v_new_state := v_invoice.state;

    if v_action.action = 'leave' then
      v_action_amount := 0;
      v_new_state := v_invoice.state;

    elsif v_action.action = 'cancel' then
      update public.invoices i
         set state = 'cancelled'::public.invoice_states
       where i.id = v_invoice.id;
      v_action_amount := 0;
      v_new_state := 'cancelled'::public.invoice_states;

    elsif v_action.action = 'write_off' then
      -- DO NOT TOUCH paid (migration 55 / 86). balance remains the written-off amount.
      v_action_amount := round(v_invoice.balance, 3);
      update public.invoices i
         set state = 'waived'::public.invoice_states
       where i.id = v_invoice.id;
      v_new_state := 'waived'::public.invoice_states;

    elsif v_action.action = 'mark_disputed' then
      update public.invoices i
         set disputed_at = now(),
             dispute_reason = coalesce(
               nullif(trim(p_note), ''),
               'Disputed at contract close-out ' || v_contract.code
             ),
             disputed_by = v_actor
       where i.id = v_invoice.id;
      v_action_amount := 0;
      v_new_state := v_invoice.state; -- state and balance UNCHANGED

    elsif v_action.action = 'settle_from_deposit' then
      v_action_amount := round(v_action.amount, 3);
      v_settle_lines := v_settle_lines || jsonb_build_array(
        jsonb_build_object(
          'invoice_id', v_invoice.id,
          'amount', v_action_amount
        )
      );
      -- resulting_state filled after apply_payment_allocation below
      v_new_state := v_invoice.state;
    end if;

    insert into public.contract_closeout_invoice_actions (
      closeout_id, invoice_id, action, amount, previous_state, resulting_state
    ) values (
      v_closeout.id, v_invoice.id, v_action.action, v_action_amount,
      v_prev_state, v_new_state
    );
  end loop;

  -- 13. Settle from deposit via real payment + apply_payment_allocation
  if jsonb_array_length(v_settle_lines) > 0 then
    insert into public.payments (
      company_id, tenant_id, unit_id, method, amount, payment_date,
      reference, status, created_by
    ) values (
      v_tenant_company,
      v_contract.tenant_id,
      (select cu.unit_id from public.contract_units cu
        where cu.contract_id = v_contract.id
          and (select count(*) from public.contract_units c2
                 where c2.contract_id = v_contract.id) = 1),
      'cash'::public.payment_methods,
      v_settled_total,
      p_move_out_date,
      'CLOSEOUT:' || v_contract.code,
      'confirmed',
      v_actor
    )
    returning id into v_payment_id;

    perform * from public.apply_payment_allocation(v_payment_id, v_settle_lines);

    -- Patch resulting_state for settle rows from the post-allocation invoice state
    update public.contract_closeout_invoice_actions a
       set resulting_state = i.state
      from public.invoices i
     where a.closeout_id = v_closeout.id
       and a.invoice_id = i.id
       and a.action = 'settle_from_deposit';
  end if;

  -- 15. Refund (post_action = 'store' deliberately — archive is atomic here)
  if v_refund_total > 0 then
    v_refund_code := public.next_refund_code();
    insert into public.refunds (
      code, company_id, contract_id, tenant_id, unit_id, building_id,
      amount, refund_date, reason, post_action, status, created_by
    ) values (
      v_refund_code,
      v_tenant_company,
      p_contract_id,
      v_contract.tenant_id,
      (select cu.unit_id from public.contract_units cu
        where cu.contract_id = v_contract.id
          and (select count(*) from public.contract_units c2
                 where c2.contract_id = v_contract.id) = 1),
      v_building_id,
      v_refund_total,
      p_move_out_date,
      'Contract close-out ' || v_contract.code,
      -- 'store' is deliberate: archive is performed by this function atomically.
      -- The client follow-up archiveRefundTarget in useRefunds.ts is retired.
      'store'::public.refund_post_actions,
      'posted',
      v_actor
    )
    returning id into v_refund_id;
  end if;

  -- 16. ONE update on contracts — trg_contract_sync_unit_status fires ONCE.
  -- archived_at is set ONLY when p_outcome = 'archive'. keep_terminated and
  -- freeze leave archived_at NULL. A close-out does NOT always archive.
  --
  -- 18. NEVER write public.units. The unit is released by migration 76's
  -- trigger. A direct write is rejected by trg_unit_enforce_derived_status.
  v_contract_before := to_jsonb(v_contract);

  update public.contracts
     set state = v_final_state,
         archived_at = case when p_outcome = 'archive' then now() else null end
   where id = p_contract_id;

  select c.* into v_contract from public.contracts c where c.id = p_contract_id;

  -- 17. Optional tenant archive (only legal under outcome = 'archive')
  if v_archive_tenant then
    update public.tenants
       set archived_at = now(),
           tenant_portal_enabled = false
     where id = v_contract.tenant_id;
    v_tenant_archived := true;
    -- DO NOT write profiles.is_active — trg_contract_deactivate_portal already
    -- did it when state left 'active'. Writing it again is redundant and would
    -- mask a regression in that trigger.
  end if;

  -- Read unit status AFTER the contracts update so it reflects the trigger.
  select u.status into v_unit_status
    from public.units u
    join public.contract_units cu on cu.unit_id = u.id
   where cu.contract_id = v_contract.id
   order by cu.line_order, cu.unit_id
   limit 1;

  -- Build action/deduction arrays for the result from what we stored
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'line', d.line,
      'kind', d.kind,
      'description_ar', d.description_ar,
      'description_en', d.description_en,
      'amount', d.amount
    ) order by d.line
  ), '[]'::jsonb)
  into v_deduction_rows
  from public.contract_closeout_deductions d
  where d.closeout_id = v_closeout.id;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'invoice_id', a.invoice_id,
      'invoice_code', i.code,
      'action', a.action,
      'amount', a.amount,
      'previous_state', a.previous_state::text,
      'resulting_state', a.resulting_state::text
    ) order by a.invoice_id
  ), '[]'::jsonb)
  into v_action_rows
  from public.contract_closeout_invoice_actions a
  join public.invoices i on i.id = a.invoice_id
  where a.closeout_id = v_closeout.id;

  -- 21. Result jsonb (stored on the header for exact idempotent replay)
  v_result := jsonb_build_object(
    'closeout_id', v_closeout.id,
    'status', 'completed',
    'contract_id', p_contract_id,
    'contract_code', v_contract.code,
    'contract_state', v_contract.state::text,
    'archived_at', v_contract.archived_at,
    'tenant_archived', v_tenant_archived,
    'deposit_held', v_deposit_held,
    'deductions_total', v_deductions_total,
    'settled_total', v_settled_total,
    'written_off_total', v_written_off_total,
    'refund_total', v_refund_total,
    'balance_due_tenant', v_balance_due,
    'refund_id', v_refund_id,
    'refund_code', v_refund_code,
    'unit_id', (select cu.unit_id from public.contract_units cu
      where cu.contract_id = v_contract.id
        and (select count(*) from public.contract_units c2
               where c2.contract_id = v_contract.id) = 1),
    'unit_ids', (select coalesce(jsonb_agg(cu.unit_id order by cu.line_order), '[]'::jsonb)
                   from public.contract_units cu where cu.contract_id = v_contract.id),
    'unit_status', v_unit_status::text,
    'deductions', v_deduction_rows,
    'invoice_actions', v_action_rows
  );

  -- 19. Complete the header
  update public.contract_closeouts c
     set status = 'completed',
         completed_by = v_actor,
         completed_at = now(),
         deposit_held = v_deposit_held,
         deductions_total = v_deductions_total,
         settled_total = v_settled_total,
         written_off_total = v_written_off_total,
         refund_total = v_refund_total,
         balance_due_tenant = v_balance_due,
         refund_id = v_refund_id,
         result = v_result
   where c.id = v_closeout.id;

  -- 20. Audit + operational events INSIDE this transaction.
  -- Action naming is singular_entity.verb — deliberately NOT the plural
  -- permission naming (contracts.close_out vs contract.close_out).
  perform public.write_audit(
    'contract.close_out',
    'contract',
    p_contract_id,
    v_contract_before,
    v_result,
    'success',
    null
  );

  if v_refund_id is not null then
    perform public.write_audit(
      'refund.create',
      'refund',
      v_refund_id,
      null,
      jsonb_build_object(
        'refund_id', v_refund_id,
        'refund_code', v_refund_code,
        'amount', v_refund_total,
        'contract_id', p_contract_id
      ),
      'success',
      null
    );
  end if;

  for v_action in
    select a.invoice_id, a.action, a.amount, a.previous_state, a.resulting_state
      from public.contract_closeout_invoice_actions a
     where a.closeout_id = v_closeout.id
       and a.action in ('write_off', 'cancel')
  loop
    if v_action.action = 'write_off' then
      perform public.write_audit(
        'invoice.write_off',
        'invoice',
        v_action.invoice_id,
        jsonb_build_object('state', v_action.previous_state::text),
        jsonb_build_object(
          'state', 'waived',
          'balance_written_off', v_action.amount,
          'closeout_id', v_closeout.id
        ),
        'success',
        null
      );
    elsif v_action.action = 'cancel' then
      perform public.write_audit(
        'invoice.update',
        'invoice',
        v_action.invoice_id,
        jsonb_build_object('state', v_action.previous_state::text),
        jsonb_build_object('state', 'cancelled', 'closeout_id', v_closeout.id),
        'success',
        null
      );
    end if;
  end loop;

  if v_tenant_archived then
    perform public.write_audit(
      'tenant.archive',
      'tenant',
      v_contract.tenant_id,
      null,
      jsonb_build_object(
        'tenant_id', v_contract.tenant_id,
        'closeout_id', v_closeout.id
      ),
      'success',
      null
    );
  end if;

  insert into public.contract_operational_events (
    contract_id, tenant_id, closeout_id, event_type, actor_id, payload, note
  ) values (
    p_contract_id,
    v_contract.tenant_id,
    v_closeout.id,
    'closeout_completed',
    v_actor,
    v_result,
    p_note
  );

  if v_tenant_archived then
    insert into public.contract_operational_events (
      contract_id, tenant_id, closeout_id, event_type, actor_id, payload
    ) values (
      p_contract_id,
      v_contract.tenant_id,
      v_closeout.id,
      'archived',
      v_actor,
      jsonb_build_object('tenant_id', v_contract.tenant_id)
    );
  end if;

  insert into public.contract_operational_events (
    contract_id, tenant_id, closeout_id, event_type, actor_id, payload
  )
  select p_contract_id,
         v_contract.tenant_id,
         v_closeout.id,
         case a.action
           when 'write_off' then 'invoice_written_off'
           when 'mark_disputed' then 'invoice_disputed'
         end,
         v_actor,
         jsonb_build_object(
           'invoice_id', a.invoice_id,
           'action', a.action,
           'amount', a.amount
         )
    from public.contract_closeout_invoice_actions a
   where a.closeout_id = v_closeout.id
     and a.action in ('write_off', 'mark_disputed');

  return v_result;
end;
$$;

revoke all on function public.close_out_contract(
  uuid, date, text, text, boolean, jsonb, jsonb, numeric, text, text, timestamptz
) from public, anon;
grant execute on function public.close_out_contract(
  uuid, date, text, text, boolean, jsonb, jsonb, numeric, text, text, timestamptz
) to authenticated, service_role;

------------------------------------------------------------
-- 2. cancel_contract_closeout — UNCHANGED, not re-issued.
--    Never reads v_contract.unit_id or any contract row at all (it only
--    touches contract_closeouts by id). Live definition stays
--    87_contract_closeout_rpcs.sql.
------------------------------------------------------------

------------------------------------------------------------
-- 3. Re-issue restore_contract
--    (live definition: 87_contract_closeout_rpcs.sql, ~line 975)
--
--    Changes from 87, by category:
--    * B3 (~lines 1028-1039): the "another live contract holds this unit"
--      pre-flight now fans out over every unit on p_contract_id via
--      contract_units and names the first conflicting unit explicitly.
--      v_holder_unit uuid declared alongside the existing v_holder.
--    * B2 (~line 1068): unit status read via contract_units, lowest
--      line_order.
--    * B4 (~line 1075): kept 'unit_id' (single-unit-or-null expression) and
--      added 'unit_ids'.
--
--    Everything else, including all step-numbered comments, is
--    byte-identical to 87.
------------------------------------------------------------

create or replace function public.restore_contract(
  p_contract_id uuid,
  p_target_state text,
  p_restore_tenant boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_contract public.contracts%rowtype;
  v_actor uuid := auth.uid();
  v_unit_status public.unit_status;
  v_result jsonb;
  v_holder uuid;
  v_holder_unit uuid;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(v_actor, 'contracts.restore') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if nullif(trim(p_reason), '') is null then
    raise exception 'A restore reason is required';
  end if;

  if p_target_state is null
     or p_target_state not in (
       'draft', 'active', 'frozen', 'suspended', 'expired', 'terminated', 'renewed'
     )
  then
    raise exception 'Invalid p_target_state: %', p_target_state;
  end if;

  -- Same lock order as close-out: contracts → tenants; no units lock.
  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
   for update;
  if not found then
    raise exception 'Contract not found';
  end if;

  perform 1 from public.tenants t where t.id = v_contract.tenant_id for update;

  -- 1. Nothing to restore
  if v_contract.archived_at is null then
    raise exception 'Contract is not archived';
  end if;

  -- 3. Another live contract holding one of this contract's units → readable
  -- error (not raw 23505). Fans out over every unit on this contract, not
  -- just the one legacy single-unit column used to name, and names the first
  -- conflicting unit.
  select c2.id, cu2.unit_id into v_holder, v_holder_unit
    from public.contract_units cu
    join public.contract_units cu2 on cu2.unit_id = cu.unit_id
    join public.contracts c2 on c2.id = cu2.contract_id
   where cu.contract_id = p_contract_id
     and c2.id <> p_contract_id
     and c2.archived_at is null
     and c2.state in ('draft', 'active', 'frozen', 'suspended')
   order by cu2.unit_id
   limit 1;
  if v_holder is not null then
    raise exception 'Cannot restore: another live contract (%) holds unit %',
      v_holder, v_holder_unit;
  end if;

  -- 4. One update: state + clear archived_at. Unit occupancy is derived by
  -- trg_contract_sync_unit_status — do not write public.units.
  -- 7. DO NOT regenerate invoices. Restoring visibility is not reactivating the lease.
  update public.contracts
     set state = p_target_state::public.contract_states,
         archived_at = null
   where id = p_contract_id;

  select c.* into v_contract from public.contracts c where c.id = p_contract_id;

  -- 5. Optional tenant restore
  if coalesce(p_restore_tenant, false) then
    update public.tenants
       set archived_at = null,
           tenant_portal_enabled = true
     where id = v_contract.tenant_id;
  end if;

  -- 6. EXPLICITLY re-enable portal profiles.
  -- Migration 21's deactivation trigger is ONE-WAY. Restore must undo it by
  -- hand or the tenant is silently locked out.
  update public.profiles
     set is_active = true
   where tenant_id = v_contract.tenant_id;

  select u.status into v_unit_status
    from public.units u
    join public.contract_units cu on cu.unit_id = u.id
   where cu.contract_id = v_contract.id
   order by cu.line_order, cu.unit_id
   limit 1;

  v_result := jsonb_build_object(
    'contract_id', p_contract_id,
    'contract_code', v_contract.code,
    'contract_state', v_contract.state::text,
    'archived_at', v_contract.archived_at,
    'unit_id', (select cu.unit_id from public.contract_units cu
      where cu.contract_id = v_contract.id
        and (select count(*) from public.contract_units c2
               where c2.contract_id = v_contract.id) = 1),
    'unit_ids', (select coalesce(jsonb_agg(cu.unit_id order by cu.line_order), '[]'::jsonb)
                   from public.contract_units cu where cu.contract_id = v_contract.id),
    'unit_status', v_unit_status::text,
    'tenant_id', v_contract.tenant_id,
    'reason', trim(p_reason)
  );

  -- 8. Audit + operational event
  perform public.write_audit(
    'contract.restore',
    'contract',
    p_contract_id,
    null,
    v_result,
    'success',
    null
  );

  insert into public.contract_operational_events (
    contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    p_contract_id,
    v_contract.tenant_id,
    'restored',
    v_actor,
    v_result,
    trim(p_reason)
  );

  return v_result;
end;
$$;

revoke all on function public.restore_contract(uuid, text, boolean, text)
  from public, anon;
grant execute on function public.restore_contract(uuid, text, boolean, text)
  to authenticated, service_role;

------------------------------------------------------------
-- 4. Re-issue get_contract_closeout_preview
--    (live definition: 87_contract_closeout_rpcs.sql, ~line 1116)
--
--    Changes from 87, by category:
--    * B2 (~line 1155): unit status read via contract_units, lowest
--      line_order.
--    * B4 (~line 1162): kept 'unit_id' (single-unit-or-null expression) and
--      added 'unit_ids'.
--
--    Everything else is byte-identical to 87.
------------------------------------------------------------

create or replace function public.get_contract_closeout_preview(
  p_contract_id uuid,
  p_deductions jsonb,
  p_invoice_actions jsonb,
  p_refund_amount numeric
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_contract public.contracts%rowtype;
  v_settlement jsonb;
  v_unit_status public.unit_status;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'contracts.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id;
  if not found then
    raise exception 'Contract not found';
  end if;

  -- Same arithmetic as close_out_contract steps 10–14; zero writes.
  v_settlement := public.closeout_compute_settlement(
    p_contract_id,
    coalesce(p_deductions, '[]'::jsonb),
    coalesce(p_invoice_actions, '[]'::jsonb),
    p_refund_amount
  );

  select u.status into v_unit_status
    from public.units u
    join public.contract_units cu on cu.unit_id = u.id
   where cu.contract_id = v_contract.id
   order by cu.line_order, cu.unit_id
   limit 1;

  return v_settlement || jsonb_build_object(
    'contract_id', p_contract_id,
    'contract_code', v_contract.code,
    'contract_state', v_contract.state::text,
    'archived_at', v_contract.archived_at,
    'unit_id', (select cu.unit_id from public.contract_units cu
      where cu.contract_id = v_contract.id
        and (select count(*) from public.contract_units c2
               where c2.contract_id = v_contract.id) = 1),
    'unit_ids', (select coalesce(jsonb_agg(cu.unit_id order by cu.line_order), '[]'::jsonb)
                   from public.contract_units cu where cu.contract_id = v_contract.id),
    'unit_status', v_unit_status::text
  );
end;
$$;

revoke all on function public.get_contract_closeout_preview(uuid, jsonb, jsonb, numeric)
  from public, anon;
grant execute on function public.get_contract_closeout_preview(uuid, jsonb, jsonb, numeric)
  to authenticated, service_role;
