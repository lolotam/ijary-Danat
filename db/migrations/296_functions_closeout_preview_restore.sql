-- 296_functions_closeout_preview_restore.sql
-- T036: function audit — close-out preview and contract restore.
-- Split from 282_functions_closeout_electricity_hr.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

-- يرجع معاينة تصفية العقد دون كتابة مع التحقق من نطاق الشركة.
CREATE OR REPLACE FUNCTION public.get_contract_closeout_preview(
  p_contract_id uuid, p_deductions jsonb, p_invoice_actions jsonb, p_refund_amount numeric
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_contract public.contracts%rowtype;
  v_settlement jsonb;
  v_unit_status public.unit_status;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'contracts.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
     and (v_caller_company is null or c.company_id = v_caller_company);
  if not found then
    raise exception 'Contract not found';
  end if;

  v_settlement := public.closeout_compute_settlement(
    p_contract_id, coalesce(p_deductions, '[]'::jsonb), coalesce(p_invoice_actions, '[]'::jsonb), p_refund_amount
  );

  select u.status into v_unit_status
    from public.units u
    join public.contract_units cu on cu.unit_id = u.id
   where cu.contract_id = v_contract.id
   order by cu.line_order, cu.unit_id limit 1;

  return v_settlement || jsonb_build_object(
    'contract_id', p_contract_id, 'contract_code', v_contract.code,
    'contract_state', v_contract.state::text, 'archived_at', v_contract.archived_at,
    'unit_id', (select cu.unit_id from public.contract_units cu
      where cu.contract_id = v_contract.id
        and (select count(*) from public.contract_units c2 where c2.contract_id = v_contract.id) = 1),
    'unit_ids', (select coalesce(jsonb_agg(cu.unit_id order by cu.line_order), '[]'::jsonb)
                   from public.contract_units cu where cu.contract_id = v_contract.id),
    'unit_status', v_unit_status::text
  );
end;
$function$;

-- يستعيد العقد المؤرشف ضمن نطاق شركة المستدعي بعد التحقق من خلو وحداته.
CREATE OR REPLACE FUNCTION public.restore_contract(
  p_contract_id uuid, p_target_state text, p_restore_tenant boolean, p_reason text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
declare
  v_caller_company uuid := public.current_company_id();
  v_contract public.contracts%rowtype;
  v_actor uuid := auth.uid();
  v_unit_status public.unit_status;
  v_result jsonb;
  v_holder uuid;
  v_holder_unit uuid;
begin
  if current_user in ('authenticated', 'company_service', 'anon') and v_caller_company is null then
    raise exception 'Company context required' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated'
     and not public.has_permission(v_actor, 'contracts.restore') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A restore reason is required';
  end if;
  if p_target_state is null or p_target_state not in (
    'draft', 'active', 'frozen', 'suspended', 'expired', 'terminated', 'renewed'
  ) then
    raise exception 'Invalid p_target_state: %', p_target_state;
  end if;

  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
     and (v_caller_company is null or c.company_id = v_caller_company)
   for update;
  if not found then
    raise exception 'Contract not found';
  end if;

  perform 1 from public.tenants t where t.id = v_contract.tenant_id and t.company_id = v_contract.company_id for update;
  if v_contract.archived_at is null then
    raise exception 'Contract is not archived';
  end if;

  select c2.id, cu2.unit_id into v_holder, v_holder_unit
    from public.contract_units cu
    join public.contract_units cu2 on cu2.unit_id = cu.unit_id
    join public.contracts c2 on c2.id = cu2.contract_id
   where cu.contract_id = p_contract_id
     and c2.company_id = v_contract.company_id
     and c2.id <> p_contract_id
     and c2.archived_at is null
     and c2.state in ('draft', 'active', 'frozen', 'suspended')
   order by cu2.unit_id limit 1;
  if v_holder is not null then
    raise exception 'Cannot restore: another live contract (%) holds unit %', v_holder, v_holder_unit;
  end if;

  update public.contracts
     set state = p_target_state::public.contract_states, archived_at = null
   where id = p_contract_id and company_id = v_contract.company_id;

  select c.* into v_contract from public.contracts c where c.id = p_contract_id;

  if coalesce(p_restore_tenant, false) then
    update public.tenants
       set archived_at = null, tenant_portal_enabled = true
     where id = v_contract.tenant_id and company_id = v_contract.company_id;
  end if;

  select u.status into v_unit_status
    from public.units u
    join public.contract_units cu on cu.unit_id = u.id
   where cu.contract_id = v_contract.id
   order by cu.line_order, cu.unit_id limit 1;

  v_result := jsonb_build_object(
    'contract_id', p_contract_id, 'contract_code', v_contract.code,
    'contract_state', v_contract.state::text, 'archived_at', v_contract.archived_at,
    'unit_id', (select cu.unit_id from public.contract_units cu
      where cu.contract_id = v_contract.id
        and (select count(*) from public.contract_units c2 where c2.contract_id = v_contract.id) = 1),
    'unit_ids', (select coalesce(jsonb_agg(cu.unit_id order by cu.line_order), '[]'::jsonb)
                   from public.contract_units cu where cu.contract_id = v_contract.id),
    'unit_status', v_unit_status::text, 'tenant_id', v_contract.tenant_id, 'reason', trim(p_reason)
  );

  perform public.write_audit(
    'contract.restore', 'contract', p_contract_id, null, v_result, 'success', null
  );

  insert into public.contract_operational_events (
    company_id, contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    v_contract.company_id, p_contract_id, v_contract.tenant_id,
    'restored', v_actor, v_result, trim(p_reason)
  );

  return v_result;
end;
$function$;


REVOKE ALL ON FUNCTION public.get_contract_closeout_preview(uuid, jsonb, jsonb, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_contract_closeout_preview(uuid, jsonb, jsonb, numeric) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.restore_contract(uuid, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_contract(uuid, text, boolean, text) TO authenticated, company_service, service_role;
