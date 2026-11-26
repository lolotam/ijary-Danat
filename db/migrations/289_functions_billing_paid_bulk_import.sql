-- 289_functions_billing_paid_bulk_import.sql
-- T034: function audit — manual paid and bulk import.
-- Split from 280_functions_billing.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

/**
 * يسجّل أو يلغي سداد الفاتورة يدوياً بترتيب الأقدمية ضمن الشركة الحالية فقط.
 */
create or replace function public.set_invoice_paid(
  p_invoice_id uuid,
  p_paid boolean,
  p_manual_payment_reason text default null,
  p_method text default null
)
returns table (payment_id uuid, invoice_state text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_invoice public.invoices%rowtype;
  v_tenant public.tenants%rowtype;
  v_reference text;
  v_payment_id uuid;
  v_payment record;
  v_new_paid numeric(14,3);
  v_new_state public.invoice_states;
  v_grace integer;
  v_method public.payment_methods;
begin
  if v_eff_role = 'authenticated'
     and not public.has_permission(auth.uid(), 'invoices.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select i.* into v_invoice
    from public.invoices i
   where i.id = p_invoice_id
     and (v_company_id is null or i.company_id = v_company_id)
   for update;
  if not found then raise exception 'Invoice not found'; end if;

  if v_invoice.state in ('cancelled', 'waived') then
    raise exception 'Invoice % cannot be marked paid or unpaid in its current state',
      v_invoice.code using errcode = '22023';
  end if;

  select t.* into v_tenant
    from public.tenants t
   where t.id = v_invoice.tenant_id
     and t.company_id = v_invoice.company_id;
  v_reference := 'AUTO-INV:' || v_invoice.code;

  if p_paid then
    if v_invoice.balance <= 0 then
      return query select null::uuid, v_invoice.state::text;
      return;
    end if;

    if exists (
      select 1
        from public.invoices earlier
       where earlier.contract_id = v_invoice.contract_id
         and earlier.company_id = v_invoice.company_id
         and earlier.id <> v_invoice.id
         and earlier.balance > 0
         and earlier.state in ('due', 'overdue', 'partially_paid')
         and (earlier.period_year, earlier.period_month)
             < (v_invoice.period_year, v_invoice.period_month)
    ) then
      raise exception 'Invoices must be paid in chronological order.';
    end if;

    if p_method is not null
       and p_method in ('payment_link', 'knet', 'card', 'applepay', 'googlepay') then
      raise exception 'Gateway payment methods cannot be recorded manually: %', p_method
        using errcode = '22023';
    end if;

    if p_method is not null then
      v_method := p_method::public.payment_methods;
    else
      select (oli.metadata ->> 'payment_method')::public.payment_methods
        into v_method
        from public.option_list_items oli
        join public.option_lists ol
          on ol.id = oli.list_id
         and ol.company_id = oli.company_id
       where ol.company_id = v_invoice.company_id
         and ol.code = 'manual_payment_reasons'
         and oli.value = p_manual_payment_reason
         and oli.is_active;
    end if;
    v_method := coalesce(v_method, 'cash'::public.payment_methods);

    insert into public.payments (
      code, company_id, tenant_id, unit_id, account_type, method, amount, currency,
      payment_date, reference, note, status
    ) values (
      public.next_payment_code(), v_invoice.company_id, v_invoice.tenant_id, v_invoice.unit_id,
      'commercial_account', v_method, v_invoice.balance, 'KWD',
      current_date,
      v_reference, 'Marked paid from invoice ' || v_invoice.code, 'confirmed'
    )
    returning payments.id into v_payment_id;

    insert into public.payment_allocations (company_id, payment_id, invoice_id, amount)
    values (v_invoice.company_id, v_payment_id, v_invoice.id, v_invoice.balance);
  else
    for v_payment in
      select p.id
        from public.payments p
       where p.company_id = v_invoice.company_id
         and p.tenant_id = v_invoice.tenant_id
         and p.reference = v_reference
    loop
      delete from public.receipts r
       where r.payment_id = v_payment.id and r.company_id = v_invoice.company_id;
      delete from public.payment_allocations pa
       where pa.payment_id = v_payment.id and pa.company_id = v_invoice.company_id;
      delete from public.payments p
       where p.id = v_payment.id and p.company_id = v_invoice.company_id;
    end loop;
    v_payment_id := null;
  end if;

  select coalesce(sum(pa.amount), 0) into v_new_paid
    from public.payment_allocations pa
    join public.payments p
      on p.id = pa.payment_id
     and p.company_id = pa.company_id
   where pa.invoice_id = v_invoice.id
     and pa.company_id = v_invoice.company_id
     and p.status = 'confirmed';

  select c.grace_days into v_grace
    from public.contracts c
   where c.id = v_invoice.contract_id
     and c.company_id = v_invoice.company_id;

  v_new_state := case
    when v_new_paid >= v_invoice.total then 'paid'
    when v_new_paid > 0 then 'partially_paid'
    when (v_invoice.due_date + coalesce(v_grace, 0)) < current_date then 'overdue'
    else 'due'
  end;

  update public.invoices i
     set paid = v_new_paid,
         state = v_new_state,
         manual_payment_reason = case
           when p_paid then coalesce(p_manual_payment_reason, p_method)
           else null
         end
   where i.id = v_invoice.id
     and i.company_id = v_invoice.company_id;

  return query select v_payment_id, v_new_state::text;
end;
$$;

revoke all on function public.set_invoice_paid(uuid, boolean, text, text) from public, anon;
grant execute on function public.set_invoice_paid(uuid, boolean, text, text)
  to authenticated, company_service, service_role;

/**
 * يستورد صفوف كيان واحد بالجملة ضمن الشركة الحالية أو المحددة لمزود الخدمة الموثوق.
 */
create or replace function public.bulk_import_phase6(
  p_entity text,
  p_rows jsonb,
  p_created_by uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_count integer;
  v_contract_ids uuid[];
  v_resolved jsonb;
begin
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a JSON array';
  end if;

  if p_entity = 'expenses' then
    insert into public.expenses (code, company_id, class, category_id, payee, amount, currency, property_id,
      building_id, unit_id, cost_center, start_date, end_date, recurrence, expense_date, status, note, created_by)
    select coalesce(nullif(row_data.code, ''), public.next_expense_code()),
      coalesce(v_company_id, row_data.company_id),
      coalesce(row_data.class, 'regular_recurring')::public.expense_classes, row_data.category_id, nullif(row_data.payee, ''),
      row_data.amount, coalesce(nullif(row_data.currency, ''), 'KWD'), row_data.property_id, row_data.building_id, row_data.unit_id,
      nullif(row_data.cost_center, ''), row_data.start_date, row_data.end_date, nullif(row_data.recurrence, ''), row_data.expense_date,
      coalesce(nullif(row_data.status, ''), 'approved'), nullif(row_data.note, ''), p_created_by
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, class text, category_id uuid,
      payee text, amount numeric, currency text, property_id uuid, building_id uuid, unit_id uuid,
      cost_center text, start_date date, end_date date, recurrence text, expense_date date, status text, note text);
  elsif p_entity = 'deposits' then
    insert into public.deposits (code, company_id, deposit_date, bank_name, amount, currency, note, status, created_by)
    select coalesce(nullif(row_data.code, ''), public.next_deposit_code()),
      coalesce(v_company_id, row_data.company_id), row_data.deposit_date,
      row_data.bank_name, row_data.amount, coalesce(nullif(row_data.currency, ''), 'KWD'), nullif(row_data.note, ''),
      coalesce(nullif(row_data.status, ''), 'confirmed'), p_created_by
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, deposit_date date, bank_name text,
      amount numeric, currency text, note text, status text);
  elsif p_entity = 'tenants' then
    insert into public.tenants (code, company_id, name, category, lifecycle, nationality, preferred_language,
      mobile, whatsapp, email, commercial_name, authorized_manager, owner_name,
      authorized_manager_civil_id, owner_civil_id, commercial_address, notes,
      tenant_portal_enabled, reminders_enabled, receipt_visible_to_tenant)
    select coalesce(nullif(row_data.code, ''), public.next_tenant_code()),
      coalesce(v_company_id, row_data.company_id), row_data.name,
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
    select coalesce(nullif(row_data.code, ''), public.next_property_code()),
      coalesce(v_company_id, row_data.company_id), row_data.name_ar,
      nullif(row_data.name_en, ''), coalesce(nullif(row_data.type, ''), 'compound'),
      nullif(row_data.address_ar, ''), nullif(row_data.address_en, ''), nullif(row_data.location_url, ''), row_data.area,
      nullif(row_data.description_ar, ''), nullif(row_data.description_en, ''), nullif(row_data.image_url, ''),
      coalesce(nullif(row_data.status, ''), 'active')
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, name_ar text, name_en text, type text,
      address_ar text, address_en text, location_url text, area numeric, description_ar text, description_en text,
      image_url text, status text);
  elsif p_entity = 'buildings' then
    insert into public.buildings (code, company_id, property_id, category_id, name_ar, name_en, address_ar, address_en, area,
      floors, image_url, description_ar, description_en, status)
    select coalesce(nullif(row_data.code, ''), public.next_building_code()),
      coalesce(v_company_id, (select p.company_id from public.properties p where p.id = row_data.property_id)),
      row_data.property_id, row_data.category_id,
      row_data.name_ar, nullif(row_data.name_en, ''), nullif(row_data.address_ar, ''), nullif(row_data.address_en, ''),
      row_data.area, row_data.floors, nullif(row_data.image_url, ''), nullif(row_data.description_ar, ''),
      nullif(row_data.description_en, ''), coalesce(nullif(row_data.status, ''), 'active')
    from jsonb_to_recordset(p_rows) as row_data(code text, property_id uuid, category_id uuid, name_ar text,
      name_en text, address_ar text, address_en text, area numeric, floors integer, image_url text,
      description_ar text, description_en text, status text);
  elsif p_entity = 'units' then
    insert into public.units (code, company_id, property_id, building_id, name, type, area, status,
      electricity_meter_ownership, default_rent, description_ar, description_en)
    select coalesce(nullif(row_data.code, ''), public.next_unit_code()),
      coalesce(
        v_company_id,
        (select b.company_id from public.buildings b where b.id = row_data.building_id),
        (select p.company_id from public.properties p where p.id = row_data.property_id)
      ),
      row_data.property_id, row_data.building_id,
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
    select coalesce(nullif(row_data.code, ''), public.next_maintenance_request_code()),
      coalesce(v_company_id, row_data.company_id),
      row_data.property_id, row_data.building_id, row_data.unit_id, row_data.title, nullif(row_data.description, ''),
      coalesce(nullif(row_data.priority, ''), 'medium')::public.maintenance_priority,
      coalesce(nullif(row_data.status, ''), 'open')::public.maintenance_status, p_created_by
    from jsonb_to_recordset(p_rows) as row_data(code text, company_id uuid, property_id uuid, building_id uuid,
      unit_id uuid, title text, description text, priority text, status text);
  elsif p_entity = 'contracts' then
    select jsonb_agg(to_jsonb(rd)) into v_resolved
      from (
        select coalesce(nullif(t.code, ''), public.next_contract_code()) as code,
               coalesce(v_company_id, (select tn.company_id from public.tenants tn where tn.id = t.tenant_id)) as company_id,
               t.tenant_id, t.unit_id, t.type, t.state, t.entry_date, t.start_date,
               t.end_date, t.duration_months, t.monthly_amount, t.due_day,
               t.grace_days, t.deposit, t.notes
          from jsonb_to_recordset(p_rows) as t(code text, tenant_id uuid, unit_id uuid,
            type text, state text, entry_date date, start_date date, end_date date,
            duration_months integer, monthly_amount numeric, due_day integer, grace_days integer,
            deposit numeric, notes text)
      ) rd;

    insert into public.contracts (company_id, code, tenant_id, type, state, entry_date, start_date,
      end_date, duration_months, due_day, grace_days, deposit, notes)
    select r.company_id, r.code, r.tenant_id,
      coalesce(nullif(r.type, ''), 'investment')::public.contract_types,
      coalesce(nullif(r.state, ''), 'draft')::public.contract_states, r.entry_date,
      r.start_date, r.end_date, r.duration_months,
      coalesce(r.due_day, 1), coalesce(r.grace_days, 1),
      coalesce(r.deposit, 0), nullif(r.notes, '')
      from jsonb_to_recordset(coalesce(v_resolved, '[]'::jsonb)) as r(
        company_id uuid, code text, tenant_id uuid, unit_id uuid, type text, state text,
        entry_date date, start_date date, end_date date, duration_months integer,
        monthly_amount numeric, due_day integer, grace_days integer,
        deposit numeric, notes text
      );

    select array_agg(c.id) into v_contract_ids
      from public.contracts c
      join jsonb_to_recordset(coalesce(v_resolved, '[]'::jsonb)) as r(company_id uuid, code text)
        on r.code = c.code
       and r.company_id = c.company_id;

    insert into public.contract_units (company_id, contract_id, unit_id, monthly_amount, line_order)
    select c.company_id, c.id, r.unit_id, r.monthly_amount, 1
      from public.contracts c
      join jsonb_to_recordset(coalesce(v_resolved, '[]'::jsonb)) as r(
        company_id uuid, code text, unit_id uuid, monthly_amount numeric
      ) on r.code = c.code and r.company_id = c.company_id
     where c.id = any(v_contract_ids);

    insert into public.insurance_payments (company_id, contract_id, tenant_id, unit_id, building_id, amount,
      collected_date)
    select c.company_id, c.id, c.tenant_id, cu.unit_id, u.building_id, c.deposit, c.start_date
      from public.contracts c
      join public.contract_units cu
        on cu.contract_id = c.id
       and cu.company_id = c.company_id
      join public.units u
        on u.id = cu.unit_id
       and u.company_id = c.company_id
     where c.id = any(v_contract_ids) and c.deposit > 0
    on conflict (contract_id) do nothing;

    return coalesce(array_length(v_contract_ids, 1), 0);
  else
    raise exception 'Unsupported import entity: %', p_entity;
  end if;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.bulk_import_phase6(text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.bulk_import_phase6(text, jsonb, uuid) to company_service, service_role;
