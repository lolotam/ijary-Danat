-- 117_save_contract_with_units.sql
--
-- Task 8: atomic contract + units save. Before this migration, no application
-- code writes public.contract_units — a contract created through the admin
-- form gets zero unit rows and the invoice generator silently bills nothing
-- for it. This RPC is the fix: the contract row and its contract_units rows
-- are written in one transaction, so a save either produces a fully-formed
-- contract or nothing at all.
--
-- Corrections applied against the original brief (see
-- .superpowers/sdd/2026-08-07-multi-unit-contracts/task-8-brief.md), all
-- verified against 04_phase2_properties_tenants_contracts.sql:144-148:
--
-- 1. Explicit column list on insert, not
--    `select * from jsonb_populate_record(...)`: that yields NULL for every
--    key the payload omits, including `id` and `code`, overriding their
--    defaults and failing the not-null constraint on `code`.
-- 2. `revoke ... from public, anon` before granting `authenticated`: Postgres
--    grants EXECUTE to PUBLIC by default, and anon holds its own grant
--    underneath that — revoking from `public` alone leaves anon able to call
--    this money-adjacent function. anonExecute.sqltest.ts enforces this
--    against the live privilege catalogue (every SECURITY DEFINER in public
--    except has_permission/is_staff/has_role must be anon-inexecutable).
-- 3. `end_date_override_reason` added to both the insert column list and the
--    update SET clause. The brief's body omitted it entirely. contracts.tsx's
--    client-side validation requires this field whenever the operator
--    overrides the calculated end date (`save()` sets a form error otherwise),
--    so the omission would have silently discarded every override reason on
--    create, and on update would have left a STALE reason in place after the
--    operator turns the override off (unlisted UPDATE SET columns keep their
--    previous value, they are not nulled). The update assignment is a direct
--    `p_contract->>'end_date_override_reason'`, not `coalesce(..., c.column)`,
--    for the same reason `commercial_activity` and `notes` are direct-assign
--    below: clearing the override must be able to write NULL, and coalescing
--    against the old value would make clearing impossible.
create or replace function public.save_contract_with_units(
  p_contract jsonb,
  p_units jsonb,
  p_contract_id uuid default null
)
returns public.contracts
language plpgsql security definer set search_path = public
as $$
declare
  v_contract public.contracts;
  v_unit jsonb;
  v_line integer := 1;
begin
  if not public.has_permission(auth.uid(), 'contracts.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if jsonb_array_length(p_units) = 0 then
    raise exception 'A contract must have at least one unit';
  end if;

  if p_contract_id is null then
    -- Explicit column list, NOT `select * from jsonb_populate_record(...)`:
    -- that yields NULL for every omitted key including `id` and `code`,
    -- overriding their defaults.
    insert into public.contracts
      (tenant_id, type, state, commercial_activity, start_date, end_date,
       duration_months, end_date_override_reason, due_day, grace_days,
       deposit, notes)
    values (
      (p_contract->>'tenant_id')::uuid,
      coalesce((p_contract->>'type')::public.contract_types, 'investment'),
      coalesce((p_contract->>'state')::public.contract_states, 'draft'),
      p_contract->>'commercial_activity',
      (p_contract->>'start_date')::date,
      (p_contract->>'end_date')::date,
      (p_contract->>'duration_months')::integer,
      p_contract->>'end_date_override_reason',
      coalesce((p_contract->>'due_day')::integer, 1),
      coalesce((p_contract->>'grace_days')::integer, 0),
      coalesce((p_contract->>'deposit')::numeric, 0),
      p_contract->>'notes'
    )
    returning * into v_contract;
  else
    update public.contracts c set
      tenant_id = coalesce((p_contract->>'tenant_id')::uuid, c.tenant_id),
      type = coalesce((p_contract->>'type')::public.contract_types, c.type),
      state = coalesce((p_contract->>'state')::public.contract_states, c.state),
      commercial_activity = p_contract->>'commercial_activity',
      start_date = coalesce((p_contract->>'start_date')::date, c.start_date),
      end_date = coalesce((p_contract->>'end_date')::date, c.end_date),
      duration_months = (p_contract->>'duration_months')::integer,
      end_date_override_reason = p_contract->>'end_date_override_reason',
      due_day = coalesce((p_contract->>'due_day')::integer, c.due_day),
      grace_days = coalesce((p_contract->>'grace_days')::integer, c.grace_days),
      deposit = coalesce((p_contract->>'deposit')::numeric, c.deposit),
      notes = p_contract->>'notes'
     where c.id = p_contract_id
     returning * into v_contract;
    if not found then raise exception 'Contract not found'; end if;
    delete from public.contract_units
     where contract_id = v_contract.id
       and unit_id not in (select (u->>'unit_id')::uuid from jsonb_array_elements(p_units) u);
  end if;

  for v_unit in select * from jsonb_array_elements(p_units) loop
    insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
    values (v_contract.id, (v_unit->>'unit_id')::uuid, (v_unit->>'monthly_amount')::numeric, v_line)
    on conflict (contract_id, unit_id)
      do update set monthly_amount = excluded.monthly_amount, line_order = excluded.line_order;
    v_line := v_line + 1;
  end loop;

  select * into v_contract from public.contracts where id = v_contract.id;
  return v_contract;
end;
$$;

-- REVOKE FIRST — see correction 2 above.
revoke execute on function public.save_contract_with_units(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.save_contract_with_units(jsonb, jsonb, uuid) to authenticated;
