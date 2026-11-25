-- 166_save_contract_extra_charges.sql
--
-- Task 4, the write side: the contract save RPC writes the contract's recurring
-- extra charges (migration 163) in the same transaction as the contract and its
-- units.
--
-- Atomicity is the whole point. Writing the charges from the client as a second
-- round trip would let a failure between them leave a contract priced at the new
-- rent with the old service charges -- and the very next invoice run would bill
-- that hybrid without anything looking wrong.
--
-- SUPERSEDE-BY-NUMBER, and this one bit: the live body is 119_review_fixes.sql,
-- NOT 117_save_contract_with_units.sql, whose filename makes it look canonical.
-- 119 re-issued the function with three corrections -- the create-vs-update
-- permission split, the "every unit entry must carry a unit_id" message, and a
-- NULL-safe `not exists` prune. Copying 117 reverts all three, and nothing about
-- the result looks wrong; the SQL suite is what caught it. 150 mentions the
-- function but only adds a contract_units constraint and does not redefine it.
--
-- The body below is copied verbatim from 119 and edited only where marked. The
-- signature is UNCHANGED -- see the comment inside the body for why the extras
-- ride inside `p_contract` instead of becoming a fourth argument -- so
-- `create or replace` stays legal, PostgREST sees one candidate, and the bundle
-- running during the deploy simply omits the key.

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
  v_charge jsonb;
  v_charge_order integer := 1;
begin
  -- I3: create and update are separate permissions. Do not collapse these.
  if not public.has_permission(
       auth.uid(),
       case when p_contract_id is null then 'contracts.create' else 'contracts.update' end
     ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if jsonb_array_length(p_units) = 0 then
    raise exception 'A contract must have at least one unit';
  end if;
  -- M6: reject a malformed payload here, where the message can name the real
  -- problem, rather than letting a NULL poison the prune below.
  if exists (
    select 1 from jsonb_array_elements(p_units) u
     where nullif(u->>'unit_id', '') is null
  ) then
    raise exception 'Every unit entry must carry a unit_id';
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
    -- M6: `not exists`, not `not in` — a NULL anywhere in the subquery would
    -- make `not in` NULL for every row and prune nothing at all.
    delete from public.contract_units cu
     where cu.contract_id = v_contract.id
       and not exists (
         select 1 from jsonb_array_elements(p_units) u
          where (u->>'unit_id')::uuid = cu.unit_id
       );
  end if;

  for v_unit in select * from jsonb_array_elements(p_units) loop
    insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
    values (v_contract.id, (v_unit->>'unit_id')::uuid, (v_unit->>'monthly_amount')::numeric, v_line)
    on conflict (contract_id, unit_id)
      do update set monthly_amount = excluded.monthly_amount, line_order = excluded.line_order;
    v_line := v_line + 1;
  end loop;

  -- Extra charges ride inside p_contract rather than as a fourth argument.
  -- A new parameter would create an overload, and PostgREST resolves an RPC by
  -- its named argument set -- two candidates is an ambiguity error, not a
  -- fallback. Dropping and recreating with four arguments instead would break
  -- the bundle still being served for the minutes a Dokploy build takes. The
  -- jsonb payload was already the extension point; nothing else had to move.
  --
  -- ABSENT key and EMPTY array mean different things, and conflating them is
  -- the bug waiting to happen here:
  --   absent  -> the caller is not managing extras. That is the bundle still
  --              being served during a deploy, and any future caller that only
  --              touches the contract's own fields. Leave them alone.
  --   []      -> the caller IS managing extras and says there are none.
  --              Delete them all.
  if p_contract ? 'extra_charges' then
    -- `not exists`, not `not in`: a NULL category_id anywhere in the payload
    -- would make `not in` NULL for every row and prune nothing at all. Same
    -- correction migration 119 made to the unit prune above.
    delete from public.contract_extra_charges ec
     where ec.contract_id = v_contract.id
       and not exists (
         select 1 from jsonb_array_elements(p_contract->'extra_charges') c
          where (c->>'category_id')::uuid = ec.category_id
       );
    for v_charge in select * from jsonb_array_elements(p_contract->'extra_charges') loop
      insert into public.contract_extra_charges
        (contract_id, category_id, amount, line_order)
      values (
        v_contract.id,
        (v_charge->>'category_id')::uuid,
        (v_charge->>'amount')::numeric,
        v_charge_order
      )
      on conflict (contract_id, category_id)
        do update set amount = excluded.amount, line_order = excluded.line_order;
      v_charge_order := v_charge_order + 1;
    end loop;
  end if;

  select * into v_contract from public.contracts where id = v_contract.id;
  return v_contract;
end;
$$;

-- REVOKE FIRST — see 117's correction 2.

-- REVOKE FIRST: Supabase grants EXECUTE on new functions to public by default.
revoke execute on function public.save_contract_with_units(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.save_contract_with_units(jsonb, jsonb, uuid) to authenticated;
