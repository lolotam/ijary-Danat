-- ---------------------------------------------------------------------------
-- 113 - electricity tenant resolution + bulk import onto contract_units
-- ---------------------------------------------------------------------------
--
-- Part of the multi-unit-contracts feature: a contract can now hold several
-- units via public.contract_units (contract_id, unit_id, monthly_amount,
-- line_order, occupies_unit), instead of exactly one via contracts.unit_id.
-- contracts.unit_id is dropped at the very end of that feature, so every SQL
-- function that reads it must move onto contract_units first. This migration
-- covers the two such functions outside the close-out family (87, handled in
-- migration 114): the electricity tenant-resolution trigger and the contracts
-- branch of the CSV/JSON bulk importer.
--
-- New file, not an edit: this repo's functions are create-or-replace and the
-- live definition is whichever migration has the highest number (see
-- db/README.md). Editing 09 or 103 in place would not reach a database that
-- already applied them; a new migration re-issues the whole function body so
-- `create or replace function` picks it up as the new live definition.
--
-- unit_id nullability: part 2 below stops bulk_import_phase6 from writing
-- contracts.unit_id, which was still `not null` as of migration 110 (see
-- 04_phase2_properties_tenants_contracts and 110_multi_unit_contracts —
-- 110 relaxed monthly_amount to a trigger-maintained total with a default,
-- but left unit_id's nullability untouched). The column itself is dropped
-- entirely in migration 117, which owns that step and must run last; this
-- migration only relaxes the constraint so writers stop failing in the
-- meantime. Must run before the function bodies below.
------------------------------------------------------------
-- 0. Unblock writers ahead of the column drop in migration 117
------------------------------------------------------------

-- contracts.unit_id is dropped entirely in migration 117 (last step of the
-- multi-unit-contracts feature). This does not drop it — only relaxes the
-- NOT NULL so bulk_import_phase6 (part 2 below), and any other writer that
-- has already moved onto contract_units, can stop populating a column that
-- is on its way out without failing inserts in the meantime.
alter table public.contracts alter column unit_id drop not null;

------------------------------------------------------------
-- 1. Re-issue validate_electricity_charge_insert
--    (highest/only prior definition: 09_phase7_electricity.sql, ~line 375;
--    96_revoke_anon_execute_on_definer_functions.sql only re-states a revoke
--    against it — it does not redefine the body.)
--
--    NOTE ON NAMING: the brief for this migration referred to this function
--    as `tg_electricity_charge_set_tenant`. No function by that name exists
--    anywhere in db/migrations. The trigger function that does the described
--    tenant lookup — and whose body matches the brief's before/after snippet
--    verbatim — is `public.validate_electricity_charge_insert()`, a BEFORE
--    INSERT trigger on public.electricity_charges (trigger itself declared
--    later in 09, unchanged, not re-created here since create-or-replace on
--    the function body is enough). This migration edits that function.
--
--    Only change: the tenant lookup for a tenant_owned meter now joins
--    through contract_units instead of reading contracts.unit_id directly.
--    Everything else, including the `if v_tenant_id is null` branch, is
--    byte-identical to the 09 definition.
------------------------------------------------------------

create or replace function public.validate_electricity_charge_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
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

  select em.* into v_meter from public.electricity_meters em
  where em.id = new.meter_id and em.is_active;
  if not found then raise exception 'Active electricity meter not found'; end if;

  select mr.* into v_reading from public.meter_readings mr
  where mr.id = new.reading_id and mr.meter_id = new.meter_id
    and mr.period_year = new.period_year and mr.period_month = new.period_month;
  if not found then raise exception 'Matching meter reading not found'; end if;

  select et.* into v_tariff from public.electricity_tariffs et
  where et.id = v_meter.tariff_id and et.is_active;
  if not found then raise exception 'Active electricity tariff not found'; end if;

  v_period_start := make_date(new.period_year, new.period_month, 1);
  v_period_end := (v_period_start + interval '1 month - 1 day')::date;
  if v_meter.ownership = 'tenant_owned' then
    select c.tenant_id into v_tenant_id
      from public.contract_units cu
      join public.contracts c on c.id = cu.contract_id
     where cu.unit_id = v_meter.unit_id and c.state = 'active'
       and c.start_date <= v_period_end and c.end_date >= v_period_start
     order by c.start_date desc, c.id
     limit 1;
    if v_tenant_id is null then
      raise exception 'Tenant-owned meter has no active contract for the charge period';
    end if;
  end if;

  new.unit_id := v_meter.unit_id;
  new.tenant_id := v_tenant_id;
  new.consumption_kwh := v_reading.consumption_kwh;
  new.amount := public.compute_electricity_amount(v_meter.tariff_id, v_reading.consumption_kwh);
  new.currency := v_tariff.currency;
  return new;
end;
$$;

-- `anon` named explicitly alongside `public`, matching every other revoke in
-- this pair of migrations (see bulk_import_phase6 below and 114's
-- close-out family): `revoke ... from public` alone would not undo an
-- explicit grant to anon if one ever existed, and anonExecute.sqltest.ts
-- checks the effective privilege catalogue, not just this statement's
-- wording. 96_revoke_anon_execute_on_definer_functions.sql already revoked
-- anon here and CREATE OR REPLACE does not reset a function's ACL, so this
-- line is not fixing a live hole — it is bringing the statement in line with
-- the pattern the rest of this file (and 114) follows, so a reader auditing
-- grants doesn't have to know that history to trust this line.
revoke all on function public.validate_electricity_charge_insert() from public, anon;

------------------------------------------------------------
-- 2. Re-issue bulk_import_phase6
--    (highest prior definition: 103_unit_property_types_free_text.sql,
--    ~line 142, which supersedes 78_bulk_import_contracts.sql and
--    16_admin_table_operations.sql. Confirmed by grep: no migration after
--    103 redefines it.)
--
--    Only the `elsif p_entity = 'contracts' then` branch changes. Every other
--    branch (expenses, deposits, tenants, properties, buildings, units,
--    maintenance) is byte-identical to 103.
--
--    The CSV/JSON payload shape is unchanged — a contracts row still carries
--    exactly one unit_id and one monthly_amount. They are no longer written
--    onto public.contracts; they go to public.contract_units instead
--    (line_order = 1, one row per imported contract).
--
--    Correlating a newly inserted contract back to the source row (to know
--    which unit_id/monthly_amount belongs to it) uses contracts.code, which
--    is `unique not null` — NOT the order RETURNING happens to emit, which
--    Postgres does not guarantee to match the driving SELECT's row order.
--    v_resolved resolves `coalesce(nullif(code,''), next_contract_code())`
--    exactly once per row so the same generated code is used for both the
--    contracts insert and the contract_units correlation.
--
--    v_resolved (a plpgsql jsonb variable, not a CTE) is populated by its own
--    top-level SELECT, so `next_contract_code()` runs exactly once per row
--    regardless of how many times v_resolved is read afterward — no reliance
--    on CTE-inlining heuristics.
--
--    THE CONTRACTS INSERT AND THE CONTRACT_UNITS INSERT ARE TWO SEPARATE
--    TOP-LEVEL STATEMENTS, DELIBERATELY NOT ONE SHARED `with ... insert ...,
--    insert ...`. An earlier draft combined them in one WITH (insert into
--    contracts as one data-modifying CTE, insert into contract_units as a
--    second one referencing its output). That does not work here:
--    contract_units carries a BEFORE INSERT ROW trigger
--    (tg_contract_units_seed_occupies, migration 110) that looks up the
--    contract's state with a plain `select ... from public.contracts where
--    id = new.contract_id`, not by reading the sibling CTE's output. Per
--    the Postgres manual (Data-Modifying Statements in WITH): all
--    sub-statements in one WITH run under "the same snapshot ... so they
--    cannot see one another's effects on the target tables" — RETURNING is
--    "the only way to communicate changes between different WITH
--    sub-statements". A trigger's own SELECT against the target table is
--    exactly the kind of read that guarantee excludes: it would find no row
--    for the contract the sibling CTE just inserted, leave
--    `new.occupies_unit` NULL (SELECT INTO with zero matching rows sets the
--    target to NULL), and abort the whole insert on
--    `occupies_unit boolean not null` (110:22) — which is to say, this
--    would have broken every single bulk-imported contract, not an edge
--    case. Splitting into separate top-level statements gives each one its
--    own command ID (PL/pgSQL increments the command counter between
--    statements automatically), so by the time the contract_units insert
--    runs, the contracts it references are ordinarily visible and the
--    trigger's lookup succeeds.
--
--    Also fixed in the same branch (found while moving off contracts.unit_id,
--    not called out by line number in the brief but inside the same branch
--    and reading the same column): the insurance_payments mirror further
--    down this branch joined `public.units u on u.id = c.unit_id`. Left as
--    v_contract.unit_id, that join would silently match zero rows for every
--    bulk-imported contract from this migration forward (contracts.unit_id
--    is no longer written), turning off insurance mirroring for every
--    imported contract without an error. Repointed at contract_units; a
--    bulk-imported contract always has exactly one contract_units row, so the
--    join cannot fan out.
------------------------------------------------------------

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
      mobile, whatsapp, email, commercial_name, authorized_manager, owner_name, notes,
      tenant_portal_enabled, reminders_enabled, receipt_visible_to_tenant)
    select coalesce(nullif(row_data.code, ''), public.next_tenant_code()), row_data.company_id, row_data.name,
      coalesce(nullif(row_data.category, ''), 'standard')::public.tenant_categories,
      coalesce(nullif(row_data.lifecycle, ''), 'active')::public.tenant_lifecycle, nullif(row_data.nationality, ''),
      coalesce(nullif(row_data.preferred_language, ''), 'ar')::public.locale_code, nullif(row_data.mobile, ''),
      nullif(row_data.whatsapp, ''), nullif(row_data.email, '')::citext, nullif(row_data.commercial_name, ''),
      nullif(row_data.authorized_manager, ''), nullif(row_data.owner_name, ''), nullif(row_data.notes, ''),
      coalesce(row_data.tenant_portal_enabled, false), coalesce(row_data.reminders_enabled, true),
      coalesce(row_data.receipt_visible_to_tenant, true)
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, name text, category text,
      lifecycle text, nationality text, preferred_language text, mobile text, whatsapp text, email text,
      commercial_name text, authorized_manager text, owner_name text, notes text,
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
      coalesce(r.due_day, 1), coalesce(r.grace_days, 0),
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

-- `anon` is named explicitly (same as migrations 78/103). revoke from public
-- alone misses an explicit anon grant; from anon alone misses a PUBLIC grant.
revoke all on function public.bulk_import_phase6(text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.bulk_import_phase6(text, jsonb, uuid) to service_role;
