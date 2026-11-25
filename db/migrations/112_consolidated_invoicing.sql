-- 112_consolidated_invoicing.sql
--
-- Multi-unit contracts: one invoice per month per contract, one
-- invoice_items rent line per unit, instead of a single rent line sized off
-- contracts.monthly_amount.
--
-- Why a new file, not an edit of 82: Supersede-by-number. SQL functions are
-- `create or replace`; the LIVE definition of any function is the one in the
-- HIGHEST-numbered migration file. Patching 82 in place would leave the
-- suite asserting against text that never re-applies on an already-migrated
-- database.
--
-- Copied from migration 82 (db/migrations/82_billing_safety_archived_contracts.sql),
-- function 1, `generate_invoices_for_year` only. That function's signature
-- and `returns table (...)` row type are unchanged here, so plain
-- `create or replace` is legal — no `drop function` anywhere in this file.
--
-- What changed, and why:
--   (a) Subtotal now sums public.contract_units.monthly_amount for the
--       contract instead of reading the single contracts.monthly_amount
--       column, which a multi-unit contract no longer prices from directly.
--   (b) invoices.unit_id is now populated from contract_units when the
--       contract has exactly one unit, and left NULL otherwise — an invoice
--       spanning several units has no single unit of its own anymore.
--   (c) The rent line insert becomes a loop over the contract's units, one
--       invoice_items row per unit, each carrying that unit's own unit_id
--       and a description suffixed with the unit code. The concession loop
--       that follows is unchanged except that it now continues numbering
--       from wherever the rent-line loop left v_line, instead of hardcoding
--       `v_line := 2` (which assumed exactly one rent line).
--   (d) Schema changes ahead of the function: invoices.unit_id becomes
--       nullable (a multi-unit invoice has no single unit); invoice_items
--       gains its own unit_id column so a concession/rent line can be
--       attributed to a specific unit; existing rent lines are backfilled
--       from their parent invoice's unit_id so historical single-unit data
--       keeps a unit_id on its rent line.
--
-- What this migration deliberately does NOT do:
--   It does not touch contracts.unit_id (still read nowhere in this
--   function) or contracts.monthly_amount (a later migration turns that into
--   a trigger-maintained total; this function does not write it and never
--   did). It does not touch backfill_contract_invoices,
--   reapply_contract_invoices, regenerate_contract_invoices,
--   evaluate_overdue, or identify_contract_expiry_reminders — those are
--   separate migrations (see the note at the end of this file).

-- ---------------------------------------------------------------------------
-- 0. Schema changes ahead of the function
-- ---------------------------------------------------------------------------

alter table public.invoices alter column unit_id drop not null;
alter table public.invoice_items
  add column if not exists unit_id uuid references public.units(id) on delete restrict;

update public.invoice_items ii
   set unit_id = i.unit_id
  from public.invoices i
 where i.id = ii.invoice_id and ii.is_concession = false and ii.unit_id is null;

-- ---------------------------------------------------------------------------
-- 1. generate_invoices_for_year — one invoice per month, one rent line per unit
-- ---------------------------------------------------------------------------
-- Copied from migration 82 with three changes: subtotal sourced from
-- contract_units, invoice unit_id sourced from contract_units (single-unit
-- case only), and the rent-line insert turned into a per-unit loop. See the
-- file header above for the full rationale. Everything else — the
-- permission guard, the year-range check, the archived-contract early raise,
-- the loop predicate (including c.archived_at is null), the free-months
-- skip via period_in_free_months, the concession maths, and the
-- on conflict on constraint invoices_contract_id_period_year_period_month_key
-- do nothing — is byte-identical to migration 82.

create or replace function public.generate_invoices_for_year(
  p_contract_id uuid default null,
  p_through_year integer default null,
  p_include_past boolean default false
)
returns table (
  id uuid, code text, contract_id uuid, period_year integer,
  period_month integer, total numeric, state text
)
language plpgsql security definer set search_path = public
as $$
declare
  v_year integer := coalesce(p_through_year, extract(year from current_date)::integer);
  v_start_month integer;
  v_end_month integer;
  v_month integer;
  v_period_start date;
  v_invoice_id uuid;
  v_invoice_code text;
  v_subtotal numeric(14,3);
  v_total numeric(14,3);
  v_discount numeric(14,3);
  v_item_total numeric(14,3);
  v_line integer;
  v_concession public.concessions%rowtype;
  v_concession_amount numeric(14,3);
  v_contract public.contracts%rowtype;
  v_unit record;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_year < 2000 or v_year > 2200 then
    raise exception 'Target year is outside the supported range';
  end if;

  -- Direct-id path: archived must raise, not silently produce zero rows.
  -- p_include_past=true fully bypasses the state='active' loop predicate when
  -- a contract id is supplied, which is how every backfill/regenerate path
  -- calls this function — so this guard is the headline hole.
  if p_contract_id is not null then
    select c.* into v_contract from public.contracts c where c.id = p_contract_id;
    if v_contract.archived_at is not null then
      raise exception 'Contract % is archived and cannot be billed. Restore it first.',
        v_contract.code using errcode = 'check_violation';
    end if;
  end if;

  for v_contract in
    select c.* from public.contracts c
    where (c.state = 'active' or (p_include_past and p_contract_id is not null))
      and (p_contract_id is null or c.id = p_contract_id)
      and c.start_date <= make_date(v_year, 12, 31)
      and c.end_date >= make_date(v_year, 1, 1)
      and c.archived_at is null
    order by c.id
  loop
    v_start_month := case
      when v_year = extract(year from current_date)::integer and not p_include_past
        then greatest(extract(month from current_date)::integer,
          case when extract(year from v_contract.start_date)::integer = v_year
            then extract(month from v_contract.start_date)::integer else 1 end)
      else case when extract(year from v_contract.start_date)::integer = v_year
        then extract(month from v_contract.start_date)::integer else 1 end
    end;
    v_end_month := case when extract(year from v_contract.end_date)::integer = v_year
      then extract(month from v_contract.end_date)::integer else 12 end;
    if v_start_month <= v_end_month then
      for v_month in v_start_month..v_end_month loop
        v_period_start := make_date(v_year, v_month, 1);
        if v_period_start < date_trunc('month', v_contract.start_date)::date
          or v_period_start > date_trunc('month', v_contract.end_date)::date then
          continue;
        end if;
        if p_include_past and v_period_start > date_trunc('month', current_date)::date then
          continue;
        end if;

        -- Product rule: free months at the start of the period → no invoice.
        if public.period_in_free_months(v_contract.id, v_period_start) then
          continue;
        end if;

        select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
          from public.contract_units cu where cu.contract_id = v_contract.id;
        v_total := v_subtotal;
        for v_concession in
          select cn.* from public.concessions cn
          where cn.contract_id = v_contract.id and cn.status = 'active'
            and cn.type <> 'free_months'
            and cn.start_date <= v_period_start and cn.end_date >= v_period_start
          order by case cn.type when 'percentage_discount' then 1 else 2 end,
            cn.created_at, cn.id
        loop
          if v_concession.type = 'percentage_discount' then
            v_total := greatest(0, v_total - round(v_total * coalesce(v_concession.discount_percent, 0) / 100, 3));
          else
            v_total := greatest(0, v_total - coalesce(v_concession.discount_amount, 0));
          end if;
        end loop;
        v_discount := v_subtotal - v_total;
        v_invoice_id := null;
        insert into public.invoices (
          code, company_id, contract_id, tenant_id, unit_id, period_year, period_month,
          issue_date, due_date, subtotal, discount, total, paid, state,
          is_visible_to_tenant, idempotency_key
        )
        select public.next_invoice_code(), t.company_id, v_contract.id, v_contract.tenant_id,
          (select cu.unit_id from public.contract_units cu
            where cu.contract_id = v_contract.id
              and (select count(*) from public.contract_units c2
                     where c2.contract_id = v_contract.id) = 1),
          v_year, v_month, current_date,
          make_date(v_year, v_month, v_contract.due_day), v_subtotal, v_discount,
          v_total, 0, 'due', true,
          v_contract.id::text || ':' || v_year::text || ':' || v_month::text
        from public.tenants t where t.id = v_contract.tenant_id
        on conflict on constraint invoices_contract_id_period_year_period_month_key do nothing
        returning invoices.id, invoices.code into v_invoice_id, v_invoice_code;
        if v_invoice_id is null then continue; end if;
        v_line := 1;
        for v_unit in
          select cu.unit_id, cu.monthly_amount, u.code
            from public.contract_units cu
            join public.units u on u.id = cu.unit_id
           where cu.contract_id = v_contract.id
           order by cu.line_order, cu.unit_id
        loop
          insert into public.invoice_items (
            invoice_id, line, unit_id, description_ar, description_en, quantity,
            unit_price, discount_percent, amount, is_concession
          ) values (
            v_invoice_id, v_line, v_unit.unit_id,
            'قيمة استثمار شهرية — ' || v_unit.code,
            'Monthly investment value — ' || v_unit.code,
            1, v_unit.monthly_amount, 0, v_unit.monthly_amount, false
          );
          v_line := v_line + 1;
        end loop;
        v_item_total := v_subtotal;
        for v_concession in
          select cn.* from public.concessions cn
          where cn.contract_id = v_contract.id and cn.status = 'active'
            and cn.type <> 'free_months'
            and cn.start_date <= v_period_start and cn.end_date >= v_period_start
          order by case cn.type when 'percentage_discount' then 1 else 2 end,
            cn.created_at, cn.id
        loop
          if v_concession.type = 'percentage_discount' then
            v_concession_amount := round(
              v_item_total * coalesce(v_concession.discount_percent, 0) / 100,
              3
            );
            v_item_total := greatest(0, v_item_total - v_concession_amount);
          else
            v_concession_amount := least(
              v_item_total,
              coalesce(v_concession.discount_amount, 0)
            );
            v_item_total := greatest(0, v_item_total - v_concession_amount);
          end if;
          insert into public.invoice_items (
            invoice_id, line, description_ar, description_en, quantity,
            unit_price, discount_percent, amount, is_concession
          ) values (
            v_invoice_id, v_line,
            case v_concession.type
              when 'percentage_discount' then 'خصم نسبة مئوية'
              else 'خصم مبلغ ثابت'
            end,
            case v_concession.type
              when 'percentage_discount' then 'Percentage discount'
              else 'Fixed discount'
            end,
            1, 0, coalesce(v_concession.discount_percent, 0),
            -v_concession_amount, true
          );
          v_line := v_line + 1;
        end loop;
        id := v_invoice_id; code := v_invoice_code; contract_id := v_contract.id;
        period_year := v_year; period_month := v_month; total := v_total; state := 'due';
        return next;
      end loop;
    end if;
  end loop;
end;
$$;
revoke all on function public.generate_invoices_for_year(uuid, integer, boolean) from public;
grant execute on function public.generate_invoices_for_year(uuid, integer, boolean)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Not re-issued here — see 112-notes.md
-- ---------------------------------------------------------------------------
-- backfill_contract_invoices and reapply_contract_invoices call
-- generate_invoices_for_year and do not themselves read v_contract.unit_id or
-- monthly_amount, so they need no change. contract_period_amounts (live in
-- migration 55) still reads v_contract.monthly_amount, and
-- regenerate_contract_invoices (live in migration 95) calls it and then
-- writes its own single, un-attributed rent line directly — both need the
-- same per-unit treatment as this function but are out of scope for
-- migration 112. See 112-notes.md for the full list.
