-- 200_save_contract_accepts_increase.sql
--
-- الحفظ يقبل الزيادة ويقفلها بعد تسجيل مال على فاتورة في فترة سريانها.
--
-- save_contract_with_units accepts increase_after_years / increase_type /
-- increase_value on create and update, with the RPC's usual key-presence
-- semantics (absent preserves, explicit JSON null clears). On update it
-- builds the candidate row with the UPDATE's own rules — including
-- start_date, which moves the anniversary — and refuses a change to an
-- EXISTING increase (or to its anniversary) once an invoice on or after the
-- affected range carries money. Recording the first increase is always
-- allowed. The contract row and the qualifying invoices are row-locked
-- first; see the lock comment below for what that does and does not cover.

-- ---------------------------------------------------------------------------
-- save_contract_with_units -- re-issued from 173, accepts and locks the increase
-- ---------------------------------------------------------------------------
-- Copied verbatim from db/migrations/173_suppress_tenant_billing_docs.sql:39-179
-- except hunks A (create columns), B (update lock) and C (update columns).
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
  v_before public.contracts%rowtype;
  v_candidate public.contracts%rowtype;
  v_old_effective date;
  v_new_effective date;
  v_lock_from date;
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
       deposit, notes, suppress_tenant_billing_docs,
       increase_after_years, increase_type, increase_value)
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
      p_contract->>'notes',
      coalesce((p_contract->>'suppress_tenant_billing_docs')::boolean, false),
      (p_contract->>'increase_after_years')::integer,
      p_contract->>'increase_type',
      (p_contract->>'increase_value')::numeric
    )
    returning * into v_contract;
  else
    -- قفل الزيادة: زيادة قائمة لا تتغيّر ولا تُمسح بعد تسجيل مال على فاتورة
    -- في أو بعد فترة سريانها. تسجيل أول زيادة على عقد قائم مسموح دائماً.
    --
    -- The candidate is built with the SAME key-presence rules as the UPDATE
    -- below (absent preserves, explicit null clears), including start_date,
    -- which moves the anniversary. Only an EXISTING increase is locked:
    -- recording the first one on a contract already past its anniversary
    -- (CON-00026 carries "increases by 15% after year 2" as free text) must
    -- stay possible; paid invoices are never repriced regardless, and the
    -- schedule sync reprices only the unpaid ones.
    --
    -- Locking: the contract row is locked here, and the qualifying invoices
    -- are locked below. set_invoice_paid locks the invoice row it settles but
    -- not the contract, so a payment that lands on an invoice this check did
    -- not see (still `due` at snapshot time) can still commit alongside an
    -- increase change. Accepted at this scale (debate finding #4); the full
    -- fix is a `for share` on the contract inside the money-writing RPCs.
    select c.* into v_before from public.contracts c where c.id = p_contract_id for update;
    if not found then raise exception 'Contract not found'; end if;
    v_candidate := v_before;
    v_candidate.start_date := coalesce((p_contract->>'start_date')::date, v_before.start_date);
    if p_contract ? 'increase_after_years' then
      v_candidate.increase_after_years := (p_contract->>'increase_after_years')::integer;
    end if;
    if p_contract ? 'increase_type' then
      v_candidate.increase_type := p_contract->>'increase_type';
    end if;
    if p_contract ? 'increase_value' then
      v_candidate.increase_value := (p_contract->>'increase_value')::numeric;
    end if;
    v_old_effective := public.contract_increase_effective_period(v_before);
    v_new_effective := public.contract_increase_effective_period(v_candidate);
    if v_before.increase_after_years is not null
       and (v_candidate.increase_after_years is distinct from v_before.increase_after_years
            or v_candidate.increase_type is distinct from v_before.increase_type
            or v_candidate.increase_value is distinct from v_before.increase_value
            or v_new_effective is distinct from v_old_effective) then
      -- PostgreSQL's LEAST ignores NULLs, so clearing the increase (new
      -- effective NULL) still locks from the old anniversary.
      v_lock_from := least(v_old_effective, v_new_effective);
      if v_lock_from is not null then
        perform 1 from public.invoices i
         where i.contract_id = p_contract_id
           and make_date(i.period_year, i.period_month, 1) >= v_lock_from
           and (i.state in ('paid', 'partially_paid') or coalesce(i.paid, 0) > 0)
         for update;
        if found then
          raise exception 'Rent increase is locked: an invoice on or after its effective period has been paid'
            using errcode = '22023';
        end if;
      end if;
    end if;

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
      notes = p_contract->>'notes',
      suppress_tenant_billing_docs = coalesce((p_contract->>'suppress_tenant_billing_docs')::boolean, c.suppress_tenant_billing_docs),
      increase_after_years = case when p_contract ? 'increase_after_years' then (p_contract->>'increase_after_years')::integer else c.increase_after_years end,
      increase_type = case when p_contract ? 'increase_type' then p_contract->>'increase_type' else c.increase_type end,
      increase_value = case when p_contract ? 'increase_value' then (p_contract->>'increase_value')::numeric else c.increase_value end
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
revoke execute on function public.save_contract_with_units(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.save_contract_with_units(jsonb, jsonb, uuid)
  to authenticated, service_role;
