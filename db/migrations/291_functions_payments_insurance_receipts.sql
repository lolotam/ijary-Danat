-- 291_functions_payments_insurance_receipts.sql
-- T035: function audit — insurance, partial-payment edit, breakdown, portal, receipt HTML.
-- Split from 281_functions_payments.sql (T052l) to keep each migration under 600 lines;
-- T052o: callable functions read the company from `public.current_company_id_strict()`,
-- which raises COMPANY_REQUIRED for an API role with no company. Trigger and internal
-- functions fall back to the row's own company_id; no API role can execute them. Idempotent.

-- يحذف سجل التأمين المرتبط بالعقد ضمن شركة المستدعي ويسجّل الحدث.
CREATE OR REPLACE FUNCTION public.delete_contract_insurance(p_contract_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_row public.insurance_payments;
begin
  if public.request_api_role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'insurance.delete') then
    raise exception 'insurance_delete_forbidden' using errcode = '42501';
  end if;

  delete from public.insurance_payments
   where contract_id = p_contract_id
     and (v_caller_company is null or company_id = v_caller_company)
  returning * into v_row;

  if v_row.id is null then
    return false;
  end if;

  perform public.write_audit(
    'insurance_payments.delete', 'insurance_payments', v_row.id, to_jsonb(v_row), null
  );
  return true;
end;
$function$;

-- يعدّل الدفعة الجزئية بأقفال العقود المرتبطة ضمن شركة المستدعي.
CREATE OR REPLACE FUNCTION public.edit_partial_payment(
  p_id uuid, p_amount numeric, p_paid_date date, p_invoice_id uuid, p_note text,
  p_tenant_id uuid, p_contract_id uuid, p_unit_id uuid, p_building_id uuid, p_status text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_partial public.partial_payments%rowtype;
  v_old_contract uuid;
  v_new_contract uuid;
  v_lock_key uuid;
  v_updated public.partial_payments%rowtype;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'partial_payments.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select pp.* into v_partial
    from public.partial_payments pp
   where pp.id = p_id
     and (v_caller_company is null or pp.company_id = v_caller_company);
  if not found then
    raise exception 'partial_payment_not_found' using errcode = 'P0002';
  end if;

  if p_invoice_id is not null and not exists (
    select 1 from public.invoices i
     where i.id = p_invoice_id and i.company_id = v_partial.company_id
  ) then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;
  if p_contract_id is not null and not exists (
    select 1 from public.contracts c
     where c.id = p_contract_id and c.company_id = v_partial.company_id
  ) then
    raise exception 'Contract not found' using errcode = 'P0002';
  end if;

  select i.contract_id into v_old_contract
    from public.invoices i where i.id = v_partial.invoice_id and i.company_id = v_partial.company_id;
  select i.contract_id into v_new_contract
    from public.invoices i where i.id = p_invoice_id and i.company_id = v_partial.company_id;

  for v_lock_key in
    select distinct c
      from unnest(array[v_old_contract, v_new_contract, p_contract_id]) as c
     where c is not null order by c
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key::text, 0));
  end loop;

  update public.partial_payments
     set amount = p_amount,
         paid_date = p_paid_date,
         invoice_id = p_invoice_id,
         note = p_note,
         tenant_id = coalesce(p_tenant_id, tenant_id),
         contract_id = p_contract_id,
         unit_id = p_unit_id,
         building_id = p_building_id,
         status = case when p_invoice_id is null then coalesce(p_status, status) else status end
   where id = p_id and company_id = v_partial.company_id;

  select pp.* into v_updated from public.partial_payments pp where pp.id = p_id;
  return to_jsonb(v_updated);
end;
$function$;

-- يرجع تفصيل مدفوعات الفاتورة المجمّع حسب المصدر والوسيلة ضمن نطاق الشركة.
CREATE OR REPLACE FUNCTION public.get_invoice_payment_breakdown(p_invoice_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_invoice public.invoices%rowtype;
  v_paid_from numeric(14,3);
  v_groups jsonb;
begin

  if auth.role() not in ('service_role', 'company_service') then
    if not exists (
      select 1 from public.invoices
       where id = p_invoice_id
         and (v_caller_company is null or company_id = v_caller_company)
         and (
           public.is_staff(auth.uid()) or (
             is_visible_to_tenant and exists (
               select 1 from public.profiles p
                where p.id = auth.uid() and p.tenant_id = invoices.tenant_id
             )
           )
         )
    ) then
      return null;
    end if;
  end if;

  select i.* into v_invoice
    from public.invoices i
   where i.id = p_invoice_id
     and (v_caller_company is null or i.company_id = v_caller_company);
  if not found then return null; end if;

  select coalesce(sum(pa.amount), 0)::numeric(14,3) into v_paid_from
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id
   where pa.invoice_id = v_invoice.id
     and pa.company_id = v_invoice.company_id
     and p.company_id = v_invoice.company_id
     and p.status = 'confirmed';

  select coalesce(jsonb_agg(g.row order by g.first_paid_on, g.source, g.method), '[]'::jsonb)
    into v_groups
    from (
      select jsonb_build_object(
               'source', case
                 when p.source_partial_payment_id is not null then 'partial'
                 when p.payment_request_id is not null then 'gateway'
                 else 'manual'
               end,
               'method', p.method,
               'amount', sum(pa.amount)::numeric(14,3),
               'first_paid_on', min(p.payment_date),
               'last_paid_on', max(p.payment_date),
               'payments', count(distinct p.id)
             ) as row,
             min(p.payment_date) as first_paid_on,
             case
               when p.source_partial_payment_id is not null then 'partial'
               when p.payment_request_id is not null then 'gateway'
               else 'manual'
             end as source,
             p.method
        from public.payment_allocations pa
        join public.payments p on p.id = pa.payment_id
       where pa.invoice_id = v_invoice.id
         and pa.company_id = v_invoice.company_id
         and p.company_id = v_invoice.company_id
         and p.status = 'confirmed'
       group by
         case
           when p.source_partial_payment_id is not null then 'partial'
           when p.payment_request_id is not null then 'gateway'
           else 'manual'
         end,
         p.method
    ) g;

  return jsonb_build_object(
    'invoice', jsonb_build_object(
      'code', v_invoice.code,
      'subtotal', v_invoice.subtotal,
      'discount', v_invoice.discount,
      'total', v_invoice.total,
      'paid', v_invoice.paid,
      'balance', v_invoice.balance,
      'state', v_invoice.state
    ),
    'paid_from_allocations', v_paid_from,
    'reconciled', v_paid_from = v_invoice.paid,
    'groups', v_groups
  );
end;
$function$;

-- يرجع معرفات الدفعات المخفية عن بوابة المستأجر ضمن نطاق الشركة.
CREATE OR REPLACE FUNCTION public.portal_hidden_payment_ids(p_tenant_id uuid)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
begin
  if p_tenant_id is null then
    raise exception 'Tenant is required';
  end if;

  if auth.role() = 'authenticated' and not (
    public.is_staff(auth.uid()) or (
      public.has_role(auth.uid(), 'tenant') and exists (
        select 1 from public.profiles p
         where p.id = auth.uid() and p.tenant_id = p_tenant_id
      )
    )
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  select p.id
    from public.payments p
   where p.tenant_id = p_tenant_id
     and (v_caller_company is null or p.company_id = v_caller_company)
     and exists (
       select 1 from public.payment_allocations pa
        where pa.payment_id = p.id and pa.company_id = p.company_id
     )
     and p.amount <= (
       select coalesce(sum(pa.amount), 0)
         from public.payment_allocations pa
        where pa.payment_id = p.id and pa.company_id = p.company_id
     )
     and not exists (
       select 1
         from public.payment_allocations pa
         join public.invoices i on i.id = pa.invoice_id and i.company_id = p.company_id
         join public.contracts c on c.id = i.contract_id and c.company_id = p.company_id
        where pa.payment_id = p.id
          and pa.company_id = p.company_id
          and not coalesce(c.hide_from_portal, false)
     );
end;
$function$;

-- يحسب صافي التأمين المحتجز للمستأجر (المحصّل ناقص المصرّف) ضمن نطاق الشركة.
CREATE OR REPLACE FUNCTION public.portal_insurance_total(
  p_tenant_id uuid,
  p_contract_id uuid DEFAULT NULL::uuid
)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
  v_total numeric(14, 3);
begin
  if p_tenant_id is null then
    raise exception 'Tenant is required';
  end if;

  if auth.role() = 'authenticated' and not (
    public.is_staff(auth.uid()) or (
      public.has_role(auth.uid(), 'tenant') and exists (
        select 1 from public.profiles p
         where p.id = auth.uid() and p.tenant_id = p_tenant_id
      )
    )
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select coalesce(sum(greatest(collected.amount - coalesce(disposed.amount, 0), 0)), 0)
    into v_total
    from (
      select ins.contract_id, c.company_id, sum(ins.amount) as amount
        from public.insurance_payments ins
        join public.contracts c on c.id = ins.contract_id
       where c.tenant_id = p_tenant_id
         and (v_caller_company is null or c.company_id = v_caller_company)
         and ins.company_id = c.company_id
         and (p_contract_id is null or c.id = p_contract_id)
         and c.state <> 'draft'
         and not coalesce(c.hide_from_portal, false)
       group by ins.contract_id, c.company_id
    ) collected
    left join (
      select co.contract_id, co.company_id,
             sum(
               co.deductions_total
               + case when settlement.status = 'reversed' then 0 else co.settled_total end
               + case when r.status in ('voided', 'reversed') then 0 else co.refund_total end
             ) as amount
        from public.contract_closeouts co
        left join public.refunds r on r.id = co.refund_id and r.company_id = co.company_id
        left join public.payments settlement
          on settlement.id::text = co.result ->> 'settlement_payment_id'
         and settlement.company_id = co.company_id
       where co.status = 'completed'
       group by co.contract_id, co.company_id
    ) disposed
      on disposed.contract_id = collected.contract_id
     and disposed.company_id = collected.company_id;

  return v_total;
end;
$function$;

-- يولّد لقطة HTML لإيصال الدفعة مع فرض عزل الشركة على المستدعي.
CREATE OR REPLACE FUNCTION public.receipt_html_for_payment(p_payment_id uuid)
 RETURNS text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select '<article dir="rtl"><header>'
    || case when c.logo_url is null then ''
            else '<img src="' || public.html_escape(c.logo_url) || '" alt="" />' end
    || '<h1>قيمة استثمار</h1><h2>'
    || public.html_escape(coalesce(c.name_ar, c.name_en, '')) || '</h2></header><p>'
    || public.html_escape(coalesce(t.name, '')) || ' — '
    || public.html_escape(p.code) || '</p><ul>'
    || coalesce((
      select string_agg(
        '<li>قيمة استثمار ' || i.period_month::text || '/' || i.period_year::text
        || ': ' || pa.amount::text || ' ' || public.html_escape(p.currency) || '</li>',
        '' order by i.period_year, i.period_month
      )
      from public.payment_allocations pa
      join public.invoices i on i.id = pa.invoice_id and i.company_id = p.company_id
      where pa.payment_id = p.id and pa.company_id = p.company_id
    ), '')
    || '</ul><strong>' || p.amount::text || ' ' || public.html_escape(p.currency)
    || '</strong><p>قيمة استثمار للوحدة</p><footer>'
    || public.html_escape(coalesce(c.address_ar, c.address_en, '')) || ' · '
    || public.html_escape(coalesce(c.phone, '')) || ' · '
    || public.html_escape(coalesce(c.map_url, ''))
    || ' · ' || public.html_escape(coalesce(c.name_ar, c.name_en, '')) || '</footer></article>'
  from public.payments p
  join public.tenants t on t.id = p.tenant_id and t.company_id = p.company_id
  left join public.companies c on c.id = p.company_id
  where p.id = p_payment_id
    -- Null only for platform callers (the worker, the migration runner); an API
    -- role without a company raises COMPANY_REQUIRED instead of seeing every receipt.
    and p.company_id = coalesce(public.current_company_id_strict(), p.company_id)
$function$;


REVOKE ALL ON FUNCTION public.delete_contract_insurance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_contract_insurance(uuid) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.edit_partial_payment(uuid, numeric, date, uuid, text, uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_partial_payment(uuid, numeric, date, uuid, text, uuid, uuid, uuid, uuid, text) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.get_invoice_payment_breakdown(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoice_payment_breakdown(uuid) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.portal_hidden_payment_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.portal_hidden_payment_ids(uuid) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.portal_insurance_total(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.portal_insurance_total(uuid, uuid) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.receipt_html_for_payment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receipt_html_for_payment(uuid) TO authenticated, company_service, service_role;
