-- 78_bulk_import_contracts.sql
--
-- Teach bulk_import_phase6 about contracts, so the contracts page can offer the
-- same Import / Export / Download-template trio as every other list page.
--
-- Supersedes the definition in 16_admin_table_operations.sql (which itself
-- superseded 08). Same signature and same `returns integer`, so `create or
-- replace` is safe here -- this is not the OUT-parameter row-type hazard
-- db/README.md warns about.
--
-- Two invariants the import relies on rather than re-checking:
--   * one_active_contract_per_unit (04:179) is a PARTIAL unique index over
--     draft/active/frozen/suspended, so the database refuses a second live
--     contract on an occupied unit. The client-side assertUnitAvailable is
--     bypassed here, which is fine because the index is the real authority.
--     Note the insert is one statement: one violation aborts the whole batch.
--   * trg_contract_sync_unit_status (76) keeps units.status in step, so an
--     imported active contract still flips its unit to occupied.
--
-- What an import deliberately does NOT do: notifyContractLifecycle. A bulk
-- backfill of historical leases must not email or WhatsApp every tenant.

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
      nullif(row_data.name_en, ''), coalesce(nullif(row_data.type, ''), 'compound')::public.property_types,
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
      row_data.name, coalesce(nullif(row_data.type, ''), 'apartment')::public.unit_types, row_data.area,
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

-- `anon` is named explicitly, which migrations 08 and 16 both missed.
--
-- Supabase's default privileges grant EXECUTE on every new public function to
-- anon and authenticated, and `revoke ... from public` does NOT reach them --
-- they are real roles holding their own grants, not members of PUBLIC. So
-- revoking "from public, authenticated" left anon holding EXECUTE on a
-- SECURITY DEFINER function that inserts rows as its owner, bypassing RLS.
--
-- Verified reachable on production before this line existed: an unauthenticated
-- POST to /rest/v1/rpc/bulk_import_phase6 carrying only the publishable anon key
-- returned `Unsupported import entity`, i.e. it had executed the body. With a
-- real entity it would have written tenants, units, properties or contracts.
-- Now returns 401 `permission denied for function`.
revoke all on function public.bulk_import_phase6(text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.bulk_import_phase6(text, jsonb, uuid) to service_role;
