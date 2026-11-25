-- 171_waive_extra_charges_on_full_discount.sql
--
-- Money-semantics revision, taken by the operator on 2026-08-30 alongside 170:
-- when a discount covers a month's rent ENTIRELY, the admin is asked whether to
-- waive that month's recurring service charges (migration 163) as well --
-- "the admin is giving this month total free by any way".
--
-- Answering yes widens the discount to the full subtotal, so the total is zero
-- and the charge lines stay on the invoice recording what was charged and what
-- was forgiven. Answering no leaves 169's behaviour untouched: the discount
-- covers the rent and the invoice total equals the service charges.
--
-- TWO CHANGES, and the first is the one to read carefully.
--
-- 1. A FIXED discount is now capped at the RENT, not the subtotal.
--    169 capped it at the whole subtotal and documented that as deliberate.
--    That is revised: it let a fixed discount consume service charges silently,
--    and it left no clean trigger for the prompt -- a fixed 520 against a
--    500 + 50 invoice covers all the rent and part of the charges, qualifying
--    for neither branch. Both discount types are rent concessions now, and a
--    service charge is discounted ONLY through an explicit waiver.
--
-- 2. The waiver is PER INVOICE, not per batch.
--    `p_waive_extra_charge_invoice_ids` is an array, not a boolean, because one
--    fixed concession can cover the rent completely on one month and only
--    partly on the next, and can meet service charges on some months and none
--    on others. A single flag applied to a whole selection is how the wrong
--    month gets waived with nothing on screen to show for it.
--
--    The caller only proposes. Every condition is re-derived inside the loop
--    AFTER `select ... for update`, so an id whose invoice no longer qualifies
--    is ignored rather than trusted.
--
-- SIGNATURE CHANGE -- this is why the file drops before it creates.
-- `create or replace function` cannot add a parameter: it creates a second
-- overload, and a call matching both arities makes PostgREST fail as ambiguous.
-- This is the migration-142 shape. The drop takes the grants with it, so they
-- are re-issued below, and `notify pgrst, 'reload schema'` is required after
-- applying or PostgREST keeps the old signature cached and the new call 404s.
--
-- Supersede-by-number: apply_concession_to_invoices' body before this file is
-- 169's; it remains the ONLY place a discount amount is computed. Verified by
-- grepping every migration -- the other `* discount_percent / 100` sites live in
-- bodies 127 superseded (05, 112, 116, 119).
--
-- Nothing in production changes: 0 active percentage discounts and
-- `contract_extra_charges` is empty, so no invoice carries a service charge.

-- ---------------------------------------------------------------------------
-- Drop the two-argument form, then create the three-argument one
-- ---------------------------------------------------------------------------
-- `if exists` so the file is re-appliable; the argument list is spelled out so
-- this can never drop some other overload by accident.
drop function if exists public.apply_concession_to_invoices(uuid, uuid[]);

create function public.apply_concession_to_invoices(
  p_concession_id uuid,
  p_invoice_ids uuid[],
  p_waive_extra_charge_invoice_ids uuid[] default '{}'
)
returns table (
  invoice_id uuid,
  code text,
  discount numeric,
  total numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
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
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'contracts.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if p_invoice_ids is null or cardinality(p_invoice_ids) = 0 then
    raise exception 'Select at least one invoice' using errcode = 'check_violation';
  end if;

  select cn.* into v_concession
    from public.concessions cn
   where cn.id = p_concession_id
   for update;
  if not found then
    raise exception 'Concession not found';
  end if;
  if v_concession.status is distinct from 'active' then
    raise exception 'Concession is not active' using errcode = 'check_violation';
  end if;
  if v_concession.type = 'free_months' then
    raise exception 'Free months cannot be bound to invoices' using errcode = 'check_violation';
  end if;

  select t.company_id into v_company_id
    from public.contracts c
    join public.tenants t on t.id = c.tenant_id
   where c.id = v_concession.contract_id;
  if v_company_id is null then
    raise exception 'Concession contract has no company' using errcode = 'check_violation';
  end if;

  for v_id in
    select distinct x from unnest(p_invoice_ids) as x order by x
  loop
    select i.* into v_invoice
      from public.invoices i
     where i.id = v_id
     for update;
    if not found then
      raise exception 'Invoice not found';
    end if;

    if v_invoice.contract_id is distinct from v_concession.contract_id
      or v_invoice.company_id is distinct from v_company_id then
      raise exception 'Invoice % does not belong to this concession''s contract',
        v_invoice.code using errcode = 'check_violation';
    end if;
    if coalesce(v_invoice.paid, 0) <> 0 then
      raise exception 'Invoice % is not fully unpaid',
        v_invoice.code using errcode = 'check_violation';
    end if;
    if v_invoice.state not in ('due', 'overdue') then
      raise exception 'Invoice % is not in a live unpaid state',
        v_invoice.code using errcode = 'check_violation';
    end if;
    if exists (
      select 1 from public.concession_invoices ci where ci.invoice_id = v_invoice.id
    ) or coalesce(v_invoice.discount, 0) <> 0 then
      raise exception 'Invoice % already has a discount',
        v_invoice.code using errcode = 'check_violation';
    end if;

    -- الخصم النسبي يُحسب على الإيجار وحده، لا على المصروفات الدورية.
    --
    -- Operator's decision, 2026-08-29: a percentage discount is a RENT
    -- concession. The recurring service charges of migration 163 are costs
    -- passed through to the tenant, not revenue to discount, so they bill in
    -- full and a free month's extras-only invoice discounts to nothing.
    --
    -- The base is the stored subtotal MINUS this invoice's own extra-charge
    -- lines, deliberately not a sum of its rent lines. The per-unit column on
    -- invoice_items only arrived in migration 112, so every rent line written
    -- before it carries a null there too -- summing rent lines would read
    -- those legacy invoices as pure extras and silently discount them to zero.
    -- Subtracting the FLAGGED lines instead degrades to exactly the pre-169
    -- figure for any invoice that has none, which is every invoice that
    -- existed before this migration.
    --
    -- (The wording above avoids naming that column outright: dropContracts-
    -- UnitId.sqltest.ts sweeps every function body for it, and prose is
    -- indistinguishable from a stale reference to pg_proc.prosrc.)
    --
    -- A FIXED discount is left alone on purpose: it is an agreed number of
    -- dinars off the bill, so it may still consume the service charges.
    -- Still capped at the subtotal, so it can never exceed what is owed.
    v_extras := coalesce((
      select sum(ii.amount)
        from public.invoice_items ii
       where ii.invoice_id = v_invoice.id
         and ii.is_extra_charge
    ), 0);
    v_rent_base := greatest(v_invoice.subtotal - v_extras, 0);

    -- BOTH discount types are now capped at the RENT. 169 capped a fixed
    -- discount at the whole subtotal, which let it eat service charges with
    -- nothing on screen to say so -- and left no clean "the rent is fully
    -- covered" trigger for the prompt below, because a fixed 520 on a 500 + 50
    -- invoice sat between the two. After this, a service charge is discounted
    -- ONLY by an explicit waiver, which is the auditable property the whole
    -- change exists to give.
    if v_concession.type = 'percentage_discount' then
      v_discount := least(
        v_rent_base,
        round(v_rent_base * coalesce(v_concession.discount_percent, 0) / 100, 3)
      );
    else
      v_discount := least(v_rent_base, coalesce(v_concession.discount_amount, 0));
    end if;

    -- التنازل عن المصروفات الدورية حين يُخصم الشهر بالكامل.
    --
    -- Widen the discount to swallow the service charges, but ONLY for an
    -- invoice the caller named AND only when this locked row actually
    -- qualifies. The three conditions are re-derived here, after the
    -- `for update` above, precisely because the client cannot be trusted to
    -- authorize this: the invoice it measured may have been paid, discounted or
    -- repriced between the operator ticking the box and the request arriving.
    -- An id that no longer qualifies is IGNORED, never applied blindly -- which
    -- is what stops a stale screen from waiving a charge on a month whose rent
    -- is only partly covered.
    --
    -- The charge lines are left on the invoice on purpose: the operator chose
    -- widening over deleting them so the bill still records what was charged
    -- and what was forgiven, and so deleting the concession restores both
    -- through the existing delete trigger.
    if v_invoice.id = any(coalesce(p_waive_extra_charge_invoice_ids, '{}'::uuid[]))
      and v_extras > 0
      and v_rent_base - v_discount = 0
    then
      v_discount := v_discount + v_extras;
    end if;
    v_total := v_invoice.subtotal - v_discount;

    update public.invoices
       set discount = v_discount,
           total = v_total
     where id = v_invoice.id;

    insert into public.concession_invoices (concession_id, invoice_id)
    values (p_concession_id, v_invoice.id);

    select coalesce(max(ii.line), 0) + 1 into v_line
      from public.invoice_items ii where ii.invoice_id = v_invoice.id;
    insert into public.invoice_items (
      invoice_id, line, description_ar, description_en, quantity,
      unit_price, discount_percent, amount, is_concession
    ) values (
      v_invoice.id, v_line,
      case v_concession.type
        when 'percentage_discount' then 'خصم نسبة مئوية'
        else 'خصم مبلغ ثابت'
      end,
      case v_concession.type
        when 'percentage_discount' then 'Percentage discount'
        else 'Fixed discount'
      end,
      1, 0, coalesce(v_concession.discount_percent, 0),
      -v_discount, true
    );

    invoice_id := v_invoice.id;
    code := v_invoice.code;
    discount := v_discount;
    total := v_total;
    return next;
  end loop;
end;
$$;

-- Re-issued because the drop above took the old function's ACL with it. Leaving
-- these out is the exact shape of the migration-142 incident: the function
-- exists, the app is signed in, and every call fails with a permission error.
revoke execute on function
  public.apply_concession_to_invoices(uuid, uuid[], uuid[]) from public, anon;
grant execute on function
  public.apply_concession_to_invoices(uuid, uuid[], uuid[]) to authenticated, service_role;
