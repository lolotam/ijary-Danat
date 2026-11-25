-- 249_default_grace_one_day.sql
--
-- يجعل مدة السماح الافتراضية يوماً واحداً، للعقود الجديدة والعقود القائمة معاً.
--
-- Owner decision 2026-10-20: the default grace period is one day, for new
-- contracts AND for existing ones.
--
-- The overdue rule itself is unchanged: `(due_date + grace_days) < as_of`
-- still decides, so an invoice due on day D is still `due` on D+1 and becomes
-- `overdue` on D+2. Only the default of `contracts.grace_days` moves.
--
-- This changes production data: every contract still at 0 moves to 1.
-- Rollback: `alter column grace_days set default 0`; set `grace_days = 0` for
-- the ids in the `contracts.grace_days_default` audit row, and in the
-- runbook's `contracts.grace_days_default_window` row, `and grace_days = 1`
-- (a contract edited to another value since is left alone); re-apply the
-- bodies from migrations 200 and 149 for the two RPC fallbacks; then run
-- `evaluate_overdue()`, which promotes the invoices this sweep demoted.
--
-- Applied before the container swap, as usual. The old bundle keeps serving
-- during the Dokploy build and sends an explicit `grace_days: 0`, which is
-- kept on purpose, so a contract it saves in that window lands at 0. Every
-- write before the swap comes from the old bundle: the new one is not live
-- yet. So after the swap the runbook sweeps `grace_days = 0 and updated_at <
-- <container start>` (`updated_at` is set by the `set_updated_at` trigger,
-- 04:192). There is no lower bound on purpose: this migration moves every 0 to
-- 1, so a 0 left afterwards was written during or after it. A request that
-- began before it and wrote after its lock carries its own transaction-start
-- `updated_at`, which a lower bound would miss. The sweep
-- applies the same invoice demotion as below, with its own audit row of
-- contract and invoice ids. A zero chosen later through the new bundle is
-- outside the window and stays a zero. Known residual: a browser that loaded
-- the old bundle before the swap and saves after it still sends 0; nothing can
-- tell that write apart from a deliberate zero, so it is left as written.

begin;

alter table public.contracts alter column grace_days set default 1;

-- The audit row lists every moved contract id, so the database itself can
-- undo the sweep without the backup.
--
-- An invoice already promoted to `overdue` under zero grace, and still inside
-- its new grace day, goes back to `due` (or `partially_paid` when something is
-- paid): `evaluate_overdue` (82:562-571) only promotes, it never demotes, and
-- reminders and the portal read the stored state. The condition mirrors its
-- rule: `balance > 0` and `(due_date + grace_days) < current_date` is overdue.
-- `overdueGraceBoundary.sqltest.ts` runs this block on seeded rows, because a
-- fresh test database has no zero-grace contract and would skip it.
do $grace$
declare
  v_contracts uuid[];
  v_invoices uuid[];
begin
  with moved as (
    update public.contracts set grace_days = 1 where grace_days = 0 returning id
  )
  select coalesce(array_agg(id order by id), '{}') into v_contracts from moved;

  if cardinality(v_contracts) = 0 then
    return;
  end if;

  with demoted as (
    update public.invoices i
       set state = case when i.paid > 0 then 'partially_paid' else 'due' end::public.invoice_states
     where i.contract_id = any(v_contracts)
       and i.state = 'overdue'
       and i.balance > 0
       and (i.due_date + 1) >= current_date
    returning i.id
  )
  select coalesce(array_agg(id order by id), '{}') into v_invoices from demoted;

  perform public.write_audit(
    'contracts.grace_days_default',
    'contract',
    null,
    jsonb_build_object('grace_days', 0, 'contract_ids', to_jsonb(v_contracts)),
    jsonb_build_object(
      'grace_days', 1,
      'contracts_changed', cardinality(v_contracts),
      'invoices_back_to_due', to_jsonb(v_invoices)
    )
  );
end;
$grace$;

-- The two RPCs below are copied verbatim from their latest definitions
-- (save_contract_with_units: 200, bulk_import_phase6: 149); the only change in
-- each is the fallback for an omitted grace_days, 0 -> 1, so a caller that skips
-- the field gets the same one-day default as the column (Codex on PR #273).
-- create or replace keeps their existing grants.

-- يحفظ العقد ووحداته في عملية واحدة؛ لو المتصل ما بعتش grace_days يبقى يوم واحد.
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
      coalesce((p_contract->>'grace_days')::integer, 1),
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

-- يستورد صفوف كيان واحد بالجملة؛ عقد من غير grace_days يتسجل بمهلة يوم واحد.
create or replace function public.bulk_import_phase6(p_entity text, p_rows jsonb, p_created_by uuid default null)
returns integer
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_count integer;
  v_contract_ids uuid[];
  -- Only used by the 'contracts' branch: rows resolved (code generated once
  -- per row) into a plain variable, not a CTE — see the header comment on
  -- why the contracts insert and the contract_units insert must be separate
  -- top-level statements rather than sibling data-modifying CTEs.
  v_resolved jsonb;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a JSON array';
  end if;

  if p_entity = 'expenses' then
    insert into public.expenses (code, company_id, class, category_id, payee, amount, currency, property_id,
      building_id, unit_id, cost_center, start_date, end_date, recurrence, expense_date, status, note, created_by)
    select coalesce(nullif(row_data.code, ''), public.next_expense_code()), row_data.company_id,
      coalesce(row_data.class, 'regular_recurring')::public.expense_classes, row_data.category_id, nullif(row_data.payee, ''),
      row_data.amount, coalesce(nullif(row_data.currency, ''), 'KWD'), row_data.property_id, row_data.building_id, row_data.unit_id,
      nullif(row_data.cost_center, ''), row_data.start_date, row_data.end_date, nullif(row_data.recurrence, ''), row_data.expense_date,
      coalesce(nullif(row_data.status, ''), 'approved'), nullif(row_data.note, ''), p_created_by
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, class text, category_id uuid,
      payee text, amount numeric, currency text, property_id uuid, building_id uuid, unit_id uuid,
      cost_center text, start_date date, end_date date, recurrence text, expense_date date, status text, note text);
  elsif p_entity = 'deposits' then
    insert into public.deposits (code, company_id, deposit_date, bank_name, amount, currency, note, status, created_by)
    select coalesce(nullif(row_data.code, ''), public.next_deposit_code()), row_data.company_id, row_data.deposit_date,
      row_data.bank_name, row_data.amount, coalesce(nullif(row_data.currency, ''), 'KWD'), nullif(row_data.note, ''),
      coalesce(nullif(row_data.status, ''), 'confirmed'), p_created_by
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, deposit_date date, bank_name text,
      amount numeric, currency text, note text, status text);
  elsif p_entity = 'tenants' then
    insert into public.tenants (code, company_id, name, category, lifecycle, nationality, preferred_language,
      mobile, whatsapp, email, commercial_name, authorized_manager, owner_name,
      authorized_manager_civil_id, owner_civil_id, commercial_address, notes,
      tenant_portal_enabled, reminders_enabled, receipt_visible_to_tenant)
    select coalesce(nullif(row_data.code, ''), public.next_tenant_code()), row_data.company_id, row_data.name,
      coalesce(nullif(row_data.category, ''), 'standard')::public.tenant_categories,
      coalesce(nullif(row_data.lifecycle, ''), 'active')::public.tenant_lifecycle, nullif(row_data.nationality, ''),
      coalesce(nullif(row_data.preferred_language, ''), 'ar')::public.locale_code, nullif(row_data.mobile, ''),
      nullif(row_data.whatsapp, ''), nullif(row_data.email, '')::citext, nullif(row_data.commercial_name, ''),
      nullif(row_data.authorized_manager, ''), nullif(row_data.owner_name, ''),
      nullif(row_data.authorized_manager_civil_id, ''), nullif(row_data.owner_civil_id, ''),
      nullif(row_data.commercial_address, ''), nullif(row_data.notes, ''),
      coalesce(row_data.tenant_portal_enabled, false), coalesce(row_data.reminders_enabled, true),
      coalesce(row_data.receipt_visible_to_tenant, true)
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, name text, category text,
      lifecycle text, nationality text, preferred_language text, mobile text, whatsapp text, email text,
      commercial_name text, authorized_manager text, owner_name text,
      authorized_manager_civil_id text, owner_civil_id text, commercial_address text, notes text,
      tenant_portal_enabled boolean, reminders_enabled boolean, receipt_visible_to_tenant boolean);
  elsif p_entity = 'properties' then
    insert into public.properties (code, company_id, name_ar, name_en, type, address_ar, address_en, location_url,
      area, description_ar, description_en, image_url, status)
    select coalesce(nullif(row_data.code, ''), public.next_property_code()), row_data.company_id, row_data.name_ar,
      nullif(row_data.name_en, ''), coalesce(nullif(row_data.type, ''), 'compound'),
      nullif(row_data.address_ar, ''), nullif(row_data.address_en, ''), nullif(row_data.location_url, ''), row_data.area,
      nullif(row_data.description_ar, ''), nullif(row_data.description_en, ''), nullif(row_data.image_url, ''),
      coalesce(nullif(row_data.status, ''), 'active')
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, name_ar text, name_en text, type text,
      address_ar text, address_en text, location_url text, area numeric, description_ar text, description_en text,
      image_url text, status text);
  elsif p_entity = 'buildings' then
    insert into public.buildings (code, property_id, category_id, name_ar, name_en, address_ar, address_en, area,
      floors, image_url, description_ar, description_en, status)
    select coalesce(nullif(row_data.code, ''), public.next_building_code()), row_data.property_id, row_data.category_id,
      row_data.name_ar, nullif(row_data.name_en, ''), nullif(row_data.address_ar, ''), nullif(row_data.address_en, ''),
      row_data.area, row_data.floors, nullif(row_data.image_url, ''), nullif(row_data.description_ar, ''),
      nullif(row_data.description_en, ''), coalesce(nullif(row_data.status, ''), 'active')
    from jsonb_to_recordset(p_rows) as row_data(code text, property_id uuid, category_id uuid, name_ar text,
      name_en text, address_ar text, address_en text, area numeric, floors integer, image_url text,
      description_ar text, description_en text, status text);
  elsif p_entity = 'units' then
    insert into public.units (code, property_id, building_id, name, type, area, status,
      electricity_meter_ownership, default_rent, description_ar, description_en)
    select coalesce(nullif(row_data.code, ''), public.next_unit_code()), row_data.property_id, row_data.building_id,
      row_data.name, coalesce(nullif(row_data.type, ''), 'apartment'), row_data.area,
      coalesce(nullif(row_data.status, ''), 'available')::public.unit_status,
      coalesce(nullif(row_data.electricity_meter_ownership, ''), 'company_owned')::public.electricity_meter_ownership,
      row_data.default_rent, nullif(row_data.description_ar, ''), nullif(row_data.description_en, '')
    from jsonb_to_recordset(p_rows) as row_data(code text, property_id uuid, building_id uuid, name text,
      type text, area numeric, status text, electricity_meter_ownership text, default_rent numeric,
      description_ar text, description_en text);
  elsif p_entity = 'maintenance' then
    insert into public.maintenance_requests (code, company_id, property_id, building_id, unit_id, title, description,
      priority, status, created_by)
    select coalesce(nullif(row_data.code, ''), public.next_maintenance_request_code()), row_data.company_id,
      row_data.property_id, row_data.building_id, row_data.unit_id, row_data.title, nullif(row_data.description, ''),
      coalesce(nullif(row_data.priority, ''), 'medium')::public.maintenance_priority,
      coalesce(nullif(row_data.status, ''), 'open')::public.maintenance_status, p_created_by
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, property_id uuid, building_id uuid,
      unit_id uuid, title text, description text, priority text, status text);
  elsif p_entity = 'contracts' then
    -- `contracts` has no company_id column, unlike every other entity here.
    -- unit_id/monthly_amount no longer live on public.contracts (migration
    -- 113+): each imported row still carries exactly one unit_id and one
    -- monthly_amount (payload shape unchanged), now written to
    -- contract_units instead of contracts.
    --
    -- STATEMENT 1 of 3: resolve every row once into v_resolved (a plain
    -- variable — see header comment for why this is not a CTE shared with
    -- the inserts below). `next_contract_code()` runs exactly once per row
    -- here; both statements that follow read the SAME resolved code, so
    -- contracts.code (unique not null) correlates a new contract back to its
    -- source row without depending on RETURNING's row order, which Postgres
    -- does not guarantee to match the driving SELECT's order.
    select jsonb_agg(to_jsonb(rd)) into v_resolved
      from (
        select coalesce(nullif(t.code, ''), public.next_contract_code()) as code,
               t.tenant_id, t.unit_id, t.type, t.state, t.entry_date, t.start_date,
               t.end_date, t.duration_months, t.monthly_amount, t.due_day,
               t.grace_days, t.deposit, t.notes
          from jsonb_to_recordset(p_rows) as t(code text, tenant_id uuid, unit_id uuid,
            type text, state text, entry_date date, start_date date, end_date date,
            duration_months integer, monthly_amount numeric, due_day integer, grace_days integer,
            deposit numeric, notes text)
      ) rd;

    -- STATEMENT 2 of 3: insert contracts. A plain top-level statement, not a
    -- CTE shared with the contract_units insert below — see header comment.
    -- `coalesce(v_resolved, '[]'::jsonb)` keeps an empty p_rows array
    -- ('[]'::jsonb → v_resolved is NULL, since jsonb_agg over zero rows is
    -- NULL, not '[]') behaving the same as before: zero contracts inserted,
    -- not an error.
    insert into public.contracts (code, tenant_id, type, state, entry_date, start_date,
      end_date, duration_months, due_day, grace_days, deposit, notes)
    select r.code, r.tenant_id,
      coalesce(nullif(r.type, ''), 'investment')::public.contract_types,
      coalesce(nullif(r.state, ''), 'draft')::public.contract_states, r.entry_date,
      r.start_date, r.end_date, r.duration_months,
      coalesce(r.due_day, 1), coalesce(r.grace_days, 1),
      coalesce(r.deposit, 0), nullif(r.notes, '')
      from jsonb_to_recordset(coalesce(v_resolved, '[]'::jsonb)) as r(
        code text, tenant_id uuid, unit_id uuid, type text, state text,
        entry_date date, start_date date, end_date date, duration_months integer,
        monthly_amount numeric, due_day integer, grace_days integer,
        deposit numeric, notes text
      );

    select array_agg(c.id) into v_contract_ids
      from public.contracts c
      join jsonb_to_recordset(coalesce(v_resolved, '[]'::jsonb)) as r(code text)
        on r.code = c.code;

    -- STATEMENT 3 of 3: insert contract_units. MUST run as a separate
    -- top-level statement after the contracts insert above has committed its
    -- own command ID — see header comment: contract_units' BEFORE INSERT
    -- trigger reads public.contracts by id, and would not see a contract
    -- inserted by a sibling CTE in the same WITH.
    insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
    select c.id, r.unit_id, r.monthly_amount, 1
      from public.contracts c
      join jsonb_to_recordset(coalesce(v_resolved, '[]'::jsonb)) as r(
        code text, unit_id uuid, monthly_amount numeric
      ) on r.code = c.code
     where c.id = any(v_contract_ids);

    -- Mirror the deposit into insurance_payments, which is what the Insurance
    -- tab and the budget's insurance_collected KPI read. useSyncContractInsurance
    -- does this for every contract saved through the form; without it here, an
    -- imported contract's insurance would exist only on the contract row and
    -- silently never reach either. collected_date is the contract's start, not
    -- today, so a back-dated import lands in the right budget period.
    --
    -- `deposit > 0` is load-bearing, not an optimisation: insurance_payments.amount
    -- carries check (amount > 0), so a single zero-deposit contract would
    -- otherwise abort the whole batch.
    --
    -- unit_id here comes from contract_units, not the legacy single-unit
    -- column on contracts (migration 113+: this branch no longer writes it).
    -- A bulk-imported contract always has exactly one contract_units row
    -- (line_order = 1), so this join cannot fan out.
    insert into public.insurance_payments (contract_id, tenant_id, unit_id, building_id, amount,
      collected_date)
    select c.id, c.tenant_id, cu.unit_id, u.building_id, c.deposit, c.start_date
    from public.contracts c
    join public.contract_units cu on cu.contract_id = c.id
    join public.units u on u.id = cu.unit_id
    where c.id = any(v_contract_ids) and c.deposit > 0
    on conflict (contract_id) do nothing;

    -- Counted explicitly. The shared `get diagnostics` below would report the
    -- insurance insert's row count, which is a different number.
    return coalesce(array_length(v_contract_ids, 1), 0);
  else
    raise exception 'Unsupported import entity: %', p_entity;
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

commit;
