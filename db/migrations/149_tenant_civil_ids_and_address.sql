-- 149_tenant_civil_ids_and_address.sql
--
-- Adds the two civil-ID fields and the commercial address the tenant form now
-- collects, and re-issues `bulk_import_phase6` so an import can actually carry
-- them.
--
-- WHY NEW COLUMNS AND NOT A RELABEL
-- The form used to show `owner_name` ("اسم المالك") and now shows the
-- authorized manager's civil ID in that position. Relabelling the column would
-- leave a person's name sitting in a civil-ID field on the one production row
-- that has one, forever. Likewise `alternate_contacts` is a `jsonb` validated as
-- "must parse to an array" — calling it "Commercial Address" while it still
-- demanded `["…"]` would be a trap for the operator on their first save.
--
-- Both legacy columns are kept and marked retired. Dropping them is
-- irreversible and buys nothing; the application simply stops reading them.
--
-- WHY THE RPC IS RE-ISSUED
-- `bulk_import_phase6`'s tenant branch (highest prior definition: migration 113)
-- names its columns explicitly. Adding the three columns to the client-side CSV
-- template alone would produce an import that reports success while silently
-- discarding every value the operator typed into them — the failure would look
-- exactly like a working import. The body below is migration 113's verbatim,
-- with only the tenant branch changed.

------------------------------------------------------------
-- 1. Columns
------------------------------------------------------------

alter table public.tenants add column if not exists authorized_manager_civil_id text;
alter table public.tenants add column if not exists owner_civil_id text;
alter table public.tenants add column if not exists commercial_address text;

comment on column public.tenants.authorized_manager_civil_id is
  'الرقم المدني للمفوض — civil ID of the authorized manager named in authorized_manager.';
comment on column public.tenants.owner_civil_id is
  'الرقم المدني للمالك — civil ID of the owner.';
comment on column public.tenants.commercial_address is
  'العنوان التجاري — plain-text commercial address. Replaces the alternate_contacts JSON field in the tenant form.';

comment on column public.tenants.owner_name is
  'Retired (migration 149). No longer read or written by the application; the '
  'tenant form now collects owner_civil_id instead. Kept because the value on '
  'existing rows is a real name that nothing else records.';
comment on column public.tenants.alternate_contacts is
  'Retired (migration 149). No longer read or written by the application; the '
  'tenant form now collects commercial_address instead. Unset on every existing row.';

------------------------------------------------------------
-- 2. Re-issue bulk_import_phase6 (verbatim from 113; tenant branch only)
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
