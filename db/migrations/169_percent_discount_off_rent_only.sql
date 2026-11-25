-- 169_percent_discount_off_rent_only.sql
--
-- Money-semantics decision, taken by the operator on 2026-08-29 alongside 168:
-- a PERCENTAGE discount comes off the RENT and leaves the recurring service
-- charges (migration 163) at full price. 500 rent + 50 cleaning with a 10%
-- discount bills 500, not 495.
--
-- 164's header states the opposite, because at the time nobody had been asked.
-- That file is history and is left alone; this one supersedes it.
--
-- A FIXED-amount discount is unchanged: it is an agreed number of dinars off
-- the bill and may still consume the service charges.
--
-- Supersede-by-number. The body each function had BEFORE this file, found by
-- grepping every migration for `create or replace function public.<name>(` and
-- taking the highest number:
--   apply_concession_to_invoices -> 127
--   append_extra_charge_items    -> 164
--
-- apply_concession_to_invoices is the ONLY place a percentage is turned into
-- an amount. Every other `* discount_percent / 100` in db/migrations sits in a
-- body that 127 superseded (05, 112, 116, 119). The other two functions that
-- touch a discounted invoice do not recompute one: regenerate_contract_invoices
-- SKIPS any invoice carrying a concession_invoices link, and
-- reapply_contract_invoices refuses to delete one. Read, not assumed.
--
-- No signature changes, so `create or replace` stays legal.

-- ---------------------------------------------------------------------------
-- 1. Mark the extra-charge lines
-- ---------------------------------------------------------------------------
-- The discount needs to tell an extra-charge line from a rent line, and there
-- is no reliable way to infer it: `unit_id is null` means "extra charge" on a
-- line written since 163 and "rent" on one written before migration 112 added
-- the column. An explicit flag is the only marker that reads the same on both.
--
-- `default false` is what makes this safe on the existing table: every row
-- already there is rent (or a concession line), and every one of them keeps
-- discounting exactly as it did.
--
-- NO BACKFILL, deliberately. Extra-charge lines written between 164's deploy
-- and this migration would land unflagged, and there is no honest way to
-- recover them: the shape that identifies one after the fact is exactly the
-- shape a pre-112 rent line has. It costs nothing here because
-- contract_extra_charges was empty in production when 168/169 shipped, so no
-- such line exists. Check before assuming that of any other database:
--
--   select count(*) from public.invoice_items ii
--     join public.invoices i on i.id = ii.invoice_id
--    where ii.unit_id is null and not ii.is_concession
--      and exists (select 1 from public.contract_extra_charges ec
--                   where ec.contract_id = i.contract_id);
--
-- A non-zero count there means those invoices will discount their service
-- charges until someone reprices them, which regenerate_contract_invoices
-- does correctly because it re-emits every line through the flagged path.
alter table public.invoice_items
  add column if not exists is_extra_charge boolean not null default false;

comment on column public.invoice_items.is_extra_charge is
  'سطر مصروف دوري من contract_extra_charges، لا إيجار. يُستثنى من أساس الخصم النسبي.';

-- No REVOKE/GRANT dance here: this is a new COLUMN on an existing table, which
-- inherits that table's grants. The Supabase default-privileges trap applies
-- to new TABLES.

-- ---------------------------------------------------------------------------
-- 2. append_extra_charge_items -- from 164, one edit: set the flag
-- ---------------------------------------------------------------------------
create or replace function public.append_extra_charge_items(
  p_invoice_id uuid,
  p_contract_id uuid,
  p_start_line integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line integer := p_start_line;
  v_charge record;
begin
  for v_charge in
    select ec.amount, cat.name_ar, cat.name_en
      from public.contract_extra_charges ec
      join public.expense_categories cat on cat.id = ec.category_id
     where ec.contract_id = p_contract_id
     order by ec.line_order, ec.category_id
  loop
    insert into public.invoice_items (
      invoice_id, line, unit_id, description_ar, description_en, quantity,
      unit_price, discount_percent, amount, is_concession, is_extra_charge
    ) values (
      p_invoice_id, v_line, null,
      v_charge.name_ar, v_charge.name_en,
      1, v_charge.amount, 0, v_charge.amount, false, true
    );
    v_line := v_line + 1;
  end loop;
  return v_line;
end;
$$;

-- Unchanged from 164, and restated because re-issuing the function resets
-- nothing: SECURITY DEFINER with no permission check of its own, so it must
-- not be reachable as an RPC. The four pricing functions still reach it --
-- inside a SECURITY DEFINER body EXECUTE is checked against the owner.
revoke execute on function public.append_extra_charge_items(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.append_extra_charge_items(uuid, uuid, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. apply_concession_to_invoices -- from 127, one edit: the discount base
-- ---------------------------------------------------------------------------
create or replace function public.apply_concession_to_invoices(
  p_concession_id uuid,
  p_invoice_ids uuid[]
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
    v_rent_base := greatest(
      v_invoice.subtotal - coalesce((
        select sum(ii.amount)
          from public.invoice_items ii
         where ii.invoice_id = v_invoice.id
           and ii.is_extra_charge
      ), 0),
      0
    );
    if v_concession.type = 'percentage_discount' then
      v_discount := least(
        v_rent_base,
        round(v_rent_base * coalesce(v_concession.discount_percent, 0) / 100, 3)
      );
    else
      v_discount := least(v_invoice.subtotal, coalesce(v_concession.discount_amount, 0));
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

revoke execute on function public.apply_concession_to_invoices(uuid, uuid[])
  from public, anon;
grant execute on function public.apply_concession_to_invoices(uuid, uuid[])
  to authenticated, service_role;
