-- 103_unit_property_types_free_text.sql
--
-- Convert units.type and properties.type from Postgres ENUMs to free text so
-- Settings → Lists can drive the Add Unit / Add Property dropdowns without a
-- migration for every new value. Same pattern as units.floor (101) and
-- contracts.commercial_activity (99).
--
-- Why free text, not a foreign key: deleting a catalogue row must not fail or
-- rewrite business records — it leaves a stale label on existing rows.
--
-- The unit_types and property_types ENUM TYPES are deliberately NOT dropped.
-- They may still be referenced by function signatures, casts, or other objects
-- outside this migration. Dropping a type that anything references fails.
-- Leaving an unused type is inert.
--
-- Verified before writing (live):
--   * public.units has zero rows — column convert is risk-free.
--   * public.properties has existing rows — values preserved via type::text.
--   * No RLS policy and no index references either column.
--   * Exactly two functions cast into these enums: get_units_summary (79) and
--     bulk_import_phase6 (78). Both are re-issued below with only the type
--     handling updated.
--
-- Defaults / NOT NULL (from migration 04_phase2_properties_tenants_contracts):
--   units.type      NOT NULL default 'apartment'::public.unit_types
--   properties.type NOT NULL default 'compound'::public.property_types
-- Altering an enum column to text drops the typed default; we restore plain
-- text defaults after the alter. NOT NULL is preserved by the alter itself but
-- re-stated for clarity.

------------------------------------------------------------
-- 1. Column type conversion
------------------------------------------------------------

alter table public.units
  alter column type type text using type::text;

alter table public.units
  alter column type set default 'apartment',
  alter column type set not null;

alter table public.properties
  alter column type type text using type::text;

alter table public.properties
  alter column type set default 'compound',
  alter column type set not null;

------------------------------------------------------------
-- 2. Normalise orphaned catalogue values to snake_case
--    Labels unchanged; only the stored option_list_items.value.
--    Guarded so we never rewrite a value that rows already use.
------------------------------------------------------------

update public.option_list_items i
   set value = 'commercial_unit'
  from public.option_lists l
 where l.id = i.list_id
   and l.code = 'unit_types'
   and i.value = 'Commercial Unit'
   and not exists (
     select 1 from public.units u where u.type = 'Commercial Unit'
   );

update public.option_list_items i
   set value = 'mall'
  from public.option_lists l
 where l.id = i.list_id
   and l.code = 'property_types'
   and i.value = 'Mall'
   and not exists (
     select 1 from public.properties p where p.type = 'Mall'
   );

------------------------------------------------------------
-- 3. Re-issue get_units_summary (highest prior: 79_module_summary_rpcs)
--    Body unchanged except type filter: u.type is text now, so no ::text cast.
------------------------------------------------------------

create or replace function public.get_units_summary(
  p_search text default null,
  p_property_id uuid default null,
  p_building_id uuid default null,
  p_status text default null,
  p_type text default null,
  p_meter text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_total bigint; v_occupied bigint; v_vacant bigint; v_maintenance bigint;
  v_rent numeric(14,3);
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'units.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select
    count(*),
    -- `occupied` is trigger-derived from an active contract (migration 76) and
    -- cannot be written by the app, so reading the column is authoritative.
    count(*) filter (where u.status = 'occupied'),
    count(*) filter (where u.status = 'vacant'),
    count(*) filter (where u.status = 'under_maintenance'),
    coalesce(sum(coalesce(u.default_rent, 0)), 0)
  into v_total, v_occupied, v_vacant, v_maintenance, v_rent
  from public.units u
  where (p_property_id is null or u.property_id = p_property_id)
    and (p_building_id is null or u.building_id = p_building_id)
    and (p_status is null or u.status::text = p_status)
    and (p_type is null or u.type = p_type)
    and (p_meter is null or u.electricity_meter_ownership::text = p_meter)
    and (p_search is null or u.code ilike '%' || p_search || '%'
      or u.name ilike '%' || p_search || '%');

  return jsonb_build_object(
    'total', v_total,
    'occupied', v_occupied,
    'vacant', v_vacant,
    'under_maintenance', v_maintenance,
    'rent_potential', v_rent
  );
end;
$$;

revoke all on function public.get_units_summary(text, uuid, uuid, text, text, text)
  from public, anon;
grant execute on function public.get_units_summary(text, uuid, uuid, text, text, text)
  to authenticated, service_role;

------------------------------------------------------------
-- 4. Re-issue bulk_import_phase6 (highest prior: 78_bulk_import_contracts)
--    Only change: drop ::public.unit_types / ::public.property_types casts on
--    the free-text columns. All other entity branches unchanged.
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
    with new_contracts as (
      insert into public.contracts (code, tenant_id, unit_id, type, state, entry_date, start_date,
        end_date, duration_months, monthly_amount, due_day, grace_days, deposit, notes)
      select coalesce(nullif(row_data.code, ''), public.next_contract_code()), row_data.tenant_id,
        row_data.unit_id, coalesce(nullif(row_data.type, ''), 'investment')::public.contract_types,
        coalesce(nullif(row_data.state, ''), 'draft')::public.contract_states, row_data.entry_date,
        row_data.start_date, row_data.end_date, row_data.duration_months, row_data.monthly_amount,
        coalesce(row_data.due_day, 1), coalesce(row_data.grace_days, 0),
        coalesce(row_data.deposit, 0), nullif(row_data.notes, '')
      from jsonb_to_recordset(p_rows) as row_data(code text, tenant_id uuid, unit_id uuid,
        type text, state text, entry_date date, start_date date, end_date date,
        duration_months integer, monthly_amount numeric, due_day integer, grace_days integer,
        deposit numeric, notes text)
      returning id
    )
    select array_agg(id) into v_contract_ids from new_contracts;

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
    insert into public.insurance_payments (contract_id, tenant_id, unit_id, building_id, amount,
      collected_date)
    select c.id, c.tenant_id, c.unit_id, u.building_id, c.deposit, c.start_date
    from public.contracts c
    join public.units u on u.id = c.unit_id
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

-- `anon` is named explicitly (same as migration 78). revoke from public alone
-- misses an explicit anon grant; from anon alone misses a PUBLIC grant.
revoke all on function public.bulk_import_phase6(text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.bulk_import_phase6(text, jsonb, uuid) to service_role;
