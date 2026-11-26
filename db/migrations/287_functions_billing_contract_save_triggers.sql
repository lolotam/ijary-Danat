-- 287_functions_billing_contract_save_triggers.sql
-- T034: function audit — contract save, portal visibility, contract propagation triggers.
-- Split from 280_functions_billing.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

/**
 * يحفظ العقد ووحداته ورسومه الدورية ذرياً داخل الشركة الحالية.
 */
create or replace function public.save_contract_with_units(
  p_contract jsonb,
  p_units jsonb,
  p_contract_id uuid default null
)
returns public.contracts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
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
  if v_eff_role = 'authenticated' and not public.has_permission(
       auth.uid(),
       case when p_contract_id is null then 'contracts.create' else 'contracts.update' end
     ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if jsonb_array_length(p_units) = 0 then
    raise exception 'A contract must have at least one unit';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_units) u where nullif(u ->> 'unit_id', '') is null
  ) then
    raise exception 'Every unit entry must carry a unit_id';
  end if;

  if v_company_id is null and v_eff_role not in ('authenticated', 'company_service') then
    if p_contract_id is not null then
      select c.company_id into v_company_id from public.contracts c where c.id = p_contract_id;
    else
      select t.company_id into v_company_id from public.tenants t where t.id = (p_contract ->> 'tenant_id')::uuid;
    end if;
  end if;
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  if p_contract_id is null then
    insert into public.contracts
      (company_id, tenant_id, type, state, commercial_activity, start_date, end_date,
       duration_months, end_date_override_reason, due_day, grace_days,
       deposit, notes, suppress_tenant_billing_docs,
       increase_after_years, increase_type, increase_value)
    values (
      v_company_id,
      (p_contract ->> 'tenant_id')::uuid,
      coalesce((p_contract ->> 'type')::public.contract_types, 'investment'),
      coalesce((p_contract ->> 'state')::public.contract_states, 'draft'),
      p_contract ->> 'commercial_activity',
      (p_contract ->> 'start_date')::date,
      (p_contract ->> 'end_date')::date,
      (p_contract ->> 'duration_months')::integer,
      p_contract ->> 'end_date_override_reason',
      coalesce((p_contract ->> 'due_day')::integer, 1),
      coalesce((p_contract ->> 'grace_days')::integer, 1),
      coalesce((p_contract ->> 'deposit')::numeric, 0),
      p_contract ->> 'notes',
      coalesce((p_contract ->> 'suppress_tenant_billing_docs')::boolean, false),
      (p_contract ->> 'increase_after_years')::integer,
      p_contract ->> 'increase_type',
      (p_contract ->> 'increase_value')::numeric
    )
    returning * into v_contract;
  else
    select c.* into v_before
      from public.contracts c
     where c.id = p_contract_id and c.company_id = v_company_id
     for update;
    if not found then raise exception 'Contract not found'; end if;

    v_candidate := v_before;
    v_candidate.start_date := coalesce((p_contract ->> 'start_date')::date, v_before.start_date);
    if p_contract ? 'increase_after_years' then v_candidate.increase_after_years := (p_contract ->> 'increase_after_years')::integer; end if;
    if p_contract ? 'increase_type' then v_candidate.increase_type := p_contract ->> 'increase_type'; end if;
    if p_contract ? 'increase_value' then v_candidate.increase_value := (p_contract ->> 'increase_value')::numeric; end if;

    v_old_effective := public.contract_increase_effective_period(v_before);
    v_new_effective := public.contract_increase_effective_period(v_candidate);
    if v_before.increase_after_years is not null
       and (v_candidate.increase_after_years is distinct from v_before.increase_after_years
            or v_candidate.increase_type is distinct from v_before.increase_type
            or v_candidate.increase_value is distinct from v_before.increase_value
            or v_new_effective is distinct from v_old_effective) then
      v_lock_from := least(v_old_effective, v_new_effective);
      if v_lock_from is not null then
        perform 1 from public.invoices i
         where i.contract_id = p_contract_id
           and i.company_id = v_company_id
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
      tenant_id = coalesce((p_contract ->> 'tenant_id')::uuid, c.tenant_id),
      type = coalesce((p_contract ->> 'type')::public.contract_types, c.type),
      state = coalesce((p_contract ->> 'state')::public.contract_states, c.state),
      commercial_activity = p_contract ->> 'commercial_activity',
      start_date = coalesce((p_contract ->> 'start_date')::date, c.start_date),
      end_date = coalesce((p_contract ->> 'end_date')::date, c.end_date),
      duration_months = (p_contract ->> 'duration_months')::integer,
      end_date_override_reason = p_contract ->> 'end_date_override_reason',
      due_day = coalesce((p_contract ->> 'due_day')::integer, c.due_day),
      grace_days = coalesce((p_contract ->> 'grace_days')::integer, c.grace_days),
      deposit = coalesce((p_contract ->> 'deposit')::numeric, c.deposit),
      notes = p_contract ->> 'notes',
      suppress_tenant_billing_docs = coalesce((p_contract ->> 'suppress_tenant_billing_docs')::boolean, c.suppress_tenant_billing_docs),
      increase_after_years = case when p_contract ? 'increase_after_years' then (p_contract ->> 'increase_after_years')::integer else c.increase_after_years end,
      increase_type = case when p_contract ? 'increase_type' then p_contract ->> 'increase_type' else c.increase_type end,
      increase_value = case when p_contract ? 'increase_value' then (p_contract ->> 'increase_value')::numeric else c.increase_value end
     where c.id = p_contract_id and c.company_id = v_company_id
     returning * into v_contract;
    if not found then raise exception 'Contract not found'; end if;

    delete from public.contract_units cu
     where cu.contract_id = v_contract.id
       and cu.company_id = v_company_id
       and not exists (
         select 1 from jsonb_array_elements(p_units) u where (u ->> 'unit_id')::uuid = cu.unit_id
       );
  end if;

  for v_unit in select * from jsonb_array_elements(p_units) loop
    insert into public.contract_units (company_id, contract_id, unit_id, monthly_amount, line_order)
    values (v_company_id, v_contract.id, (v_unit ->> 'unit_id')::uuid, (v_unit ->> 'monthly_amount')::numeric, v_line)
    on conflict (contract_id, unit_id)
      do update set monthly_amount = excluded.monthly_amount, line_order = excluded.line_order;
    v_line := v_line + 1;
  end loop;

  if p_contract ? 'extra_charges' then
    delete from public.contract_extra_charges ec
     where ec.contract_id = v_contract.id
       and ec.company_id = v_company_id
       and not exists (
         select 1 from jsonb_array_elements(p_contract -> 'extra_charges') c
          where (c ->> 'category_id')::uuid = ec.category_id
       );
    for v_charge in select * from jsonb_array_elements(p_contract -> 'extra_charges') loop
      insert into public.contract_extra_charges (company_id, contract_id, category_id, amount, line_order)
      values (v_company_id, v_contract.id, (v_charge ->> 'category_id')::uuid, (v_charge ->> 'amount')::numeric, v_charge_order)
      on conflict (contract_id, category_id)
        do update set amount = excluded.amount, line_order = excluded.line_order;
      v_charge_order := v_charge_order + 1;
    end loop;
  end if;

  select * into v_contract from public.contracts where id = v_contract.id and company_id = v_company_id;
  return v_contract;
end;
$$;

/**
 * يبدّل ظهور العقد في بوابة المستأجر مع تسجيل التدقيق ضمن الشركة الحالية.
 */
create or replace function public.update_contract_portal_visibility(
  p_contract_id uuid,
  p_hide_from_portal boolean
)
returns public.contracts
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_row public.contracts;
begin
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'contracts.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if p_hide_from_portal is null then
    raise exception 'p_hide_from_portal is required';
  end if;

  update public.contracts
     set hide_from_portal = p_hide_from_portal, updated_at = now()
   where id = p_contract_id
     and (v_company_id is null or company_id = v_company_id)
  returning * into v_row;
  if v_row.id is null then raise exception 'Contract not found'; end if;

  perform public.write_audit(
    'contract.portal_visibility',
    'contract',
    p_contract_id,
    null,
    jsonb_build_object('company_id', v_row.company_id, 'hide_from_portal', p_hide_from_portal)
  );
  return v_row;
end;
$$;

------------------------------------------------------------
-- 4. Contract & receipt propagation triggers (company-scoped / invoker)
------------------------------------------------------------

/**
 * ينقل الفواتير والدفعات والإيصالات عند تغيير المستأجر على العقد ضمن نفس الشركة.
 *
 * Trigger-only helper: the company comes from the contract row the trigger
 * fired on (that row already passed RLS), never from a lookup inside this
 * security definer function. Callable by no API role, so a staff session with
 * a null company context cannot reach another company's ledgers through it.
 */
drop function if exists public.reassign_contract_tenant_records(uuid, uuid, uuid);
create or replace function public.reassign_contract_tenant_records(
  _company uuid,
  _contract uuid,
  _old_tenant uuid,
  _new_tenant uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := _company;
  v_context_company uuid := public.current_company_id();
  _settling_payments uuid[];
begin
  -- A request with a company context may only touch its own company; a
  -- context-free platform update (service_role) relies on the row's company.
  if v_company_id is null
     or (v_context_company is not null and v_context_company <> v_company_id) then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  select array_agg(distinct pa.payment_id)
    into _settling_payments
    from public.payment_allocations pa
    join public.invoices i on i.id = pa.invoice_id and i.company_id = pa.company_id
   where i.contract_id = _contract and i.company_id = v_company_id;

  update public.invoices set tenant_id = _new_tenant
   where contract_id = _contract and company_id = v_company_id and tenant_id = _old_tenant;
  update public.payments set tenant_id = _new_tenant
   where company_id = v_company_id and tenant_id = _old_tenant and id = any(_settling_payments);
  update public.receipts set tenant_id = _new_tenant
   where company_id = v_company_id and tenant_id = _old_tenant and payment_id = any(_settling_payments);
end;
$$;

/**
 * ينفّذ نقل سجلات المستأجر عند تعديل `tenant_id` في العقد.
 */
create or replace function public.tg_contract_propagate_tenant_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := new.company_id;
  v_context_company uuid := public.current_company_id();
begin
  if v_company_id is null
     or (v_context_company is not null and v_context_company <> v_company_id) then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  perform public.reassign_contract_tenant_records(v_company_id, new.id, old.tenant_id, new.tenant_id);
  return new;
end;
$$;

/**
 * يضبط حقل إشغال الوحدة عند إدراج أو تعديل صف في `contract_units`.
 */
create or replace function public.tg_contract_units_seed_occupies()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
begin
  select c.state in ('draft', 'active', 'frozen', 'suspended')
    into new.occupies_unit
    from public.contracts c
   where c.id = new.contract_id
     and c.company_id = v_company_id;
  return new;
end;
$$;

/**
 * يحدّث `occupies_unit` في `contract_units` عند تغيّر حالة العقد.
 */
create or replace function public.tg_contract_propagate_occupies()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
begin
  update public.contract_units
     set occupies_unit = new.state in ('draft', 'active', 'frozen', 'suspended')
   where contract_id = new.id
     and company_id = v_company_id
     and occupies_unit <> (new.state in ('draft', 'active', 'frozen', 'suspended'));
  return new;
end;
$$;

/**
 * يعيد احتساب الإيجار الشهري الإجمالي للعقد من جدول `contract_units`.
 */
create or replace function public.tg_contract_units_sync_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _new uuid := new.contract_id;
  _old uuid := old.contract_id;
  _company uuid := coalesce(public.current_company_id(), new.company_id, old.company_id);
begin
  update public.contracts c
     set monthly_amount = coalesce(
           (select sum(cu.monthly_amount) from public.contract_units cu
             where cu.contract_id = c.id and cu.company_id = c.company_id), 0)
   where c.company_id = _company
     and (c.id = _new or c.id = _old);
  return coalesce(new, old);
end;
$$;

/**
 * يزامن حالات الوحدات المرتبطة عند تعديل `contract_units`.
 */
create or replace function public.tg_contract_units_sync_unit_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _company uuid := coalesce(public.current_company_id(), new.company_id, old.company_id);
  _units uuid[] := '{}';
begin
  if _company is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if tg_op <> 'INSERT' then _units := _units || old.unit_id; end if;
  if tg_op <> 'DELETE' then _units := _units || new.unit_id; end if;
  perform public.sync_unit_status_many(_units);
  return coalesce(new, old);
end;
$$;

revoke execute on function public.tg_contract_propagate_tenant_change() from public, anon;
revoke execute on function public.reassign_contract_tenant_records(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, company_service;
revoke execute on function public.tg_contract_units_seed_occupies() from public, anon;
revoke execute on function public.tg_contract_propagate_occupies() from public, anon;
revoke execute on function public.tg_contract_units_sync_total() from public, anon;
revoke execute on function public.tg_contract_units_sync_unit_status() from public, anon;
