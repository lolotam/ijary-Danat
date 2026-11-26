-- 286_functions_billing_overdue_concessions.sql
-- T034: function audit — overdue, portal payable invoices, concessions.
-- Split from 280_functions_billing.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

------------------------------------------------------------
-- 3. Overdue, portal payable, concessions, contract save
------------------------------------------------------------

/**
 * يقيّم الفواتير المستحقة المتأخرة ويحوّلها إلى متأخرة داخل الشركة الحالية.
 */
create or replace function public.evaluate_overdue(p_as_of date default null)
returns table(invoice_id uuid, old_state text, new_state text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
begin
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'invoices.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  return query
  with eligible as (
    select i.id, i.company_id, i.state::text as previous_state
      from public.invoices i
      join public.contracts c
        on c.id = i.contract_id and c.company_id = i.company_id
     where (v_company_id is null or i.company_id = v_company_id)
       and i.state in ('due', 'partially_paid')
       and i.balance > 0
       and (i.due_date + c.grace_days) < coalesce(p_as_of, current_date)
       and c.archived_at is null
     for update of i
  ),
  changed as (
    update public.invoices i
       set state = 'overdue'
      from eligible e
     where i.id = e.id and i.company_id = e.company_id
    returning i.id, e.previous_state
  )
  select changed.id, changed.previous_state, 'overdue'::text from changed;
end;
$$;

/**
 * يتحقق من وجود طلب دفع إلكتروني قيد الانتظار لفاتورة معينة ضمن الشركة.
 */
create or replace function public.invoice_has_pending_request(_invoice uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.payment_requests pr
     where pr.status = 'pending'
       and _invoice = any (pr.requested_invoice_ids)
       and (
         coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '') not in ('authenticated', 'company_service')
         or pr.company_id = public.current_company_id()
       )
  );
$$;

/**
 * يقيّم الفواتير القابلة للدفع في بوابة المستأجر مع ترتيب الأقدمية ضمن الشركة الحالية.
 */
create or replace function public.evaluate_portal_payable_invoices(
  p_tenant_id uuid,
  p_contract_id uuid default null,
  p_include_hidden boolean default false
)
returns table(
  invoice_id uuid, period_year integer, period_month integer, total numeric,
  paid numeric, balance numeric, state text, is_overdue boolean,
  sequence_order integer, is_selectable boolean, lock_reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_include_hidden boolean := coalesce(p_include_hidden, false)
    and (v_eff_role <> 'authenticated' or coalesce(public.is_staff(auth.uid()), false));
begin
  if p_tenant_id is null then raise exception 'Tenant is required'; end if;
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  if v_eff_role = 'authenticated' and not (
    public.is_staff(auth.uid()) or (
      public.has_role(auth.uid(), 'tenant'::public.app_role) and exists (
        select 1 from public.profiles p
         where p.id = auth.uid() and p.company_id = v_company_id and p.tenant_id = p_tenant_id
      )
    )
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.tenants t
     where t.id = p_tenant_id and (v_company_id is null or t.company_id = v_company_id)
  ) then
    raise exception 'Tenant not found';
  end if;

  if p_contract_id is not null and not exists (
    select 1 from public.contracts c
     where c.id = p_contract_id
       and (v_company_id is null or c.company_id = v_company_id)
       and c.tenant_id = p_tenant_id
  ) then
    raise exception 'Contract does not belong to this tenant' using errcode = '42501';
  end if;

  return query
  with payable as (
    select i.id, i.period_year, i.period_month, i.total, i.paid, i.balance, i.state::text,
           (i.state = 'overdue' or (i.due_date + coalesce(c.grace_days, 0)) < current_date) as overdue,
           row_number() over (order by i.period_year, i.period_month, i.due_date, i.id)::integer as seq
      from public.invoices i
      left join public.contracts c
        on c.id = i.contract_id and c.company_id = i.company_id
     where i.tenant_id = p_tenant_id
       and (v_company_id is null or i.company_id = v_company_id)
       and i.state in ('due', 'overdue', 'partially_paid')
       and i.balance > 0
       and i.is_visible_to_tenant
       and (p_contract_id is null or i.contract_id = p_contract_id)
       and (v_include_hidden or not coalesce(c.hide_from_portal, false))
  ), ordered as (
    select p.*,
           first_value(p.period_month) over (order by p.seq) as blocking_month,
           first_value(p.period_year) over (order by p.seq) as blocking_year
      from payable p
  )
  select o.id, o.period_year, o.period_month, o.total, o.paid, o.balance, o.state,
         o.overdue, o.seq, o.seq = 1,
         case
           when o.seq = 1 then null
           else 'ادفع فاتورة شهر '
             || lpad(o.blocking_month::text, 2, '0') || '/' || o.blocking_year::text
             || ' أولًا / Pay month '
             || lpad(o.blocking_month::text, 2, '0') || '/' || o.blocking_year::text
             || ' first'
         end
    from ordered o
   order by o.seq;
end;
$$;

/**
 * يطبّق خصم الإعفاء على الفواتير المختارة ضمن نفس الشركة فقط.
 */
create or replace function public.apply_concession_to_invoices(
  p_concession_id uuid,
  p_invoice_ids uuid[],
  p_waive_extra_charge_invoice_ids uuid[] default '{}'::uuid[]
)
returns table(invoice_id uuid, code text, discount numeric, total numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller_company uuid := public.current_company_id();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_concession public.concessions%rowtype;
  v_company_id uuid;
  v_invoice public.invoices%rowtype;
  v_id uuid;
  v_discount numeric(14,3);
  v_rent_base numeric(14,3);
  v_extras numeric(14,3);
  v_total numeric(14,3);
  v_line integer;
begin
  if v_eff_role = 'authenticated' and not public.has_permission(auth.uid(), 'contracts.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_eff_role in ('authenticated', 'company_service') and v_caller_company is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if p_invoice_ids is null or cardinality(p_invoice_ids) = 0 then
    raise exception 'Select at least one invoice' using errcode = 'check_violation';
  end if;

  select cn.* into v_concession
    from public.concessions cn
   where cn.id = p_concession_id
     and (v_caller_company is null or cn.company_id = v_caller_company)
   for update;
  if not found then raise exception 'Concession not found'; end if;
  if v_concession.status is distinct from 'active' then
    raise exception 'Concession is not active' using errcode = 'check_violation';
  end if;
  if v_concession.type = 'free_months' then
    raise exception 'Free months cannot be bound to invoices' using errcode = 'check_violation';
  end if;

  v_company_id := v_concession.company_id;

  for v_id in select distinct x from unnest(p_invoice_ids) as x order by x loop
    select i.* into v_invoice
      from public.invoices i
     where i.id = v_id
       and i.company_id = v_company_id
     for update;
    if not found then raise exception 'Invoice not found'; end if;

    if v_invoice.contract_id is distinct from v_concession.contract_id
       or v_invoice.company_id is distinct from v_company_id then
      raise exception 'Invoice % does not belong to this concession''s contract',
        v_invoice.code using errcode = 'check_violation';
    end if;
    if coalesce(v_invoice.paid, 0) <> 0 then
      raise exception 'Invoice % is not fully unpaid', v_invoice.code using errcode = 'check_violation';
    end if;
    if v_invoice.state not in ('due', 'overdue') then
      raise exception 'Invoice % is not in a live unpaid state', v_invoice.code using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from public.concession_invoices ci
       where ci.invoice_id = v_invoice.id and ci.company_id = v_company_id
    ) or coalesce(v_invoice.discount, 0) <> 0 then
      raise exception 'Invoice % already has a discount', v_invoice.code using errcode = 'check_violation';
    end if;

    v_extras := coalesce((
      select sum(ii.amount) from public.invoice_items ii
       where ii.invoice_id = v_invoice.id and ii.company_id = v_company_id and ii.is_extra_charge
    ), 0);
    v_rent_base := greatest(v_invoice.subtotal - v_extras, 0);

    if v_concession.type = 'percentage_discount' then
      v_discount := least(v_rent_base, round(v_rent_base * coalesce(v_concession.discount_percent, 0) / 100, 3));
    else
      v_discount := least(v_rent_base, coalesce(v_concession.discount_amount, 0));
    end if;

    if v_invoice.id = any(coalesce(p_waive_extra_charge_invoice_ids, '{}'::uuid[]))
       and v_extras > 0 and v_rent_base - v_discount = 0 then
      v_discount := v_discount + v_extras;
    end if;
    v_total := v_invoice.subtotal - v_discount;

    update public.invoices
       set discount = v_discount, total = v_total
     where id = v_invoice.id and company_id = v_company_id;

    insert into public.concession_invoices (company_id, concession_id, invoice_id)
    values (v_company_id, p_concession_id, v_invoice.id);

    select coalesce(max(ii.line), 0) + 1 into v_line
      from public.invoice_items ii
     where ii.invoice_id = v_invoice.id and ii.company_id = v_company_id;

    insert into public.invoice_items (
      company_id, invoice_id, line, description_ar, description_en, quantity,
      unit_price, discount_percent, amount, is_concession
    ) values (
      v_company_id, v_invoice.id, v_line,
      case v_concession.type when 'percentage_discount' then 'خصم نسبة مئوية' else 'خصم مبلغ ثابت' end,
      case v_concession.type when 'percentage_discount' then 'Percentage discount' else 'Fixed discount' end,
      1, 0, coalesce(v_concession.discount_percent, 0), -v_discount, true
    );

    invoice_id := v_invoice.id; code := v_invoice.code; discount := v_discount; total := v_total;
    return next;
  end loop;
end;
$$;

/**
 * يربط الفواتير المخفّضة تاريخياً بإعفاءاتها المطابقة ضمن الشركة الحالية فقط.
 */
create or replace function public.backfill_concession_invoice_links()
returns table(linked integer, left_for_review integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id_strict();
  v_eff_role text := coalesce(nullif(current_setting('role', true), 'none'), auth.role(), '');
  v_invoice record;
  v_concession_id uuid;
  v_match_count integer;
begin
  if v_eff_role in ('authenticated', 'company_service') and v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  linked := 0;
  left_for_review := 0;

  for v_invoice in
    select i.id, i.company_id, i.code, i.contract_id, i.period_year, i.period_month
      from public.invoices i
     where (v_company_id is null or i.company_id = v_company_id)
       and coalesce(i.discount, 0) > 0
       and not exists (
         select 1 from public.concession_invoices ci
          where ci.invoice_id = i.id and ci.company_id = i.company_id
       )
     order by i.code
  loop
    select count(*), (array_agg(cn.id))[1]
      into v_match_count, v_concession_id
      from public.concessions cn
     where cn.contract_id = v_invoice.contract_id
       and cn.company_id = v_invoice.company_id
       and cn.status = 'active'
       and cn.type <> 'free_months'
       and cn.start_date <= make_date(v_invoice.period_year, v_invoice.period_month, 1)
       and cn.end_date >= make_date(v_invoice.period_year, v_invoice.period_month, 1);

    if v_match_count = 1 then
      insert into public.concession_invoices (company_id, concession_id, invoice_id)
      values (v_invoice.company_id, v_concession_id, v_invoice.id)
      on conflict do nothing;
      linked := linked + 1;
    else
      left_for_review := left_for_review + 1;
    end if;
  end loop;
  return next;
end;
$$;

/**
 * يستعيد قيمة الفواتير المرتبطة عند حذف الإعفاء ضمن نفس الشركة.
 */
create or replace function public.tg_restore_invoices_on_concession_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := coalesce(public.current_company_id(), old.company_id);
  v_link record;
  v_invoice public.invoices%rowtype;
begin
  if old.type = 'free_months' then return old; end if;

  for v_link in
    select ci.invoice_id
      from public.concession_invoices ci
     where ci.concession_id = old.id
       and ci.company_id = v_company_id
  loop
    select i.* into v_invoice
      from public.invoices i
     where i.id = v_link.invoice_id
       and i.company_id = v_company_id
     for update;
    if not found then continue; end if;

    update public.invoices
       set discount = 0, total = subtotal
     where id = v_invoice.id and company_id = v_company_id;

    perform public.recompute_invoice_from_confirmed(v_invoice.id);

    delete from public.invoice_items
     where invoice_id = v_invoice.id
       and company_id = v_company_id
       and is_concession = true;
  end loop;
  return old;
end;
$$;
