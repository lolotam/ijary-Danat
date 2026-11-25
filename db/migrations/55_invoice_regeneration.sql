-- 55_invoice_regeneration.sql
--
-- T15: editing a contract must reconcile that contract's invoices — without
-- destroying invoice identity.
--
-- Creating a contract already backfills its history (admin.contracts.tsx calls
-- backfill_contract_invoices right after the insert). Editing one reconciles
-- nothing: change monthly_amount, the dates or due_day and every invoice
-- already generated keeps the old figures forever.
--
-- The one function that does re-derive invoices, reapply_contract_invoices,
-- DELETEs and recreates. That is unacceptable here, and the reason is not
-- aesthetic:
--
--   public.payment_requests.requested_invoice_ids is `uuid[] not null` with NO
--   foreign key (06_phase4_tenant_portal_gateway.sql:30).
--
-- So: a tenant starts a KNET payment (createPayment.ts writes a pending
-- payment_requests row holding the invoice UUID) -> an admin edits the contract
-- -> the unpaid invoice is deleted and reinserted with a fresh UUID -> the
-- tenant pays -> myfatoorahWebhook.ts:213 resolves `.in("id", ...)` against a
-- dead id and finds nothing. The money arrives and is allocated against
-- nothing, and the invoice still reads unpaid. Nothing raises.
--
-- This migration replaces that with an UPSERT-diff:
--
--   should exist + does      -> UPDATE in place (UUID survives)
--   should exist + doesn't   -> INSERT via the existing generator
--   shouldn't exist + clean  -> DELETE
--   shouldn't exist + money  -> mark 'cancelled', never destroy

-- ---------------------------------------------------------------------------
-- 1. The guard the current delete is missing
-- ---------------------------------------------------------------------------

-- reapply_contract_invoices guards on `paid = 0` and "no allocation", which
-- protects *settled* money. It has a hole exactly the width of a pending
-- payment request: a KNET link minted an hour ago has no allocation yet, and
-- that is the highest-risk row there is.
--
-- Only 'pending' blocks. A 'completed' request already has an allocation (the
-- existing guard covers it), and failed/expired/cancelled links are dead.
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
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. Period arithmetic, extracted
-- ---------------------------------------------------------------------------

-- generate_invoices_for_year (migration 37) computes this inline while
-- inserting. The UPDATE branch below needs the same numbers without inserting,
-- so the arithmetic is named here.
--
-- These two must stay in agreement; src/db/invoiceRegeneration.sqltest.ts
-- asserts that they do, for a contract carrying both a percentage and a fixed
-- concession, so drift fails a test rather than quietly changing what tenants
-- are billed.
create or replace function public.contract_period_amounts(
  p_contract_id uuid,
  p_period_start date
)
returns table (subtotal numeric, discount numeric, total numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_contract public.contracts%rowtype;
  v_subtotal numeric(14,3);
  v_total numeric(14,3);
  v_concession public.concessions%rowtype;
begin
  select c.* into v_contract from public.contracts c where c.id = p_contract_id;
  if not found then
    raise exception 'Contract not found';
  end if;

  v_subtotal := v_contract.monthly_amount;
  v_total := v_subtotal;

  -- Percentage discounts apply before fixed ones, matching migration 37's
  -- ordering. Changing this order changes what tenants are billed.
  for v_concession in
    select cn.* from public.concessions cn
    where cn.contract_id = p_contract_id and cn.status = 'active'
      and cn.type <> 'free_months'
      and cn.start_date <= p_period_start and cn.end_date >= p_period_start
    order by case cn.type when 'percentage_discount' then 1 else 2 end,
      cn.created_at, cn.id
  loop
    if v_concession.type = 'percentage_discount' then
      v_total := greatest(
        0,
        v_total - round(v_total * coalesce(v_concession.discount_percent, 0) / 100, 3)
      );
    else
      v_total := greatest(0, v_total - coalesce(v_concession.discount_amount, 0));
    end if;
  end loop;

  subtotal := v_subtotal;
  discount := v_subtotal - v_total;
  total := v_total;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The engine
-- ---------------------------------------------------------------------------

-- Returns one row per invoice it considered, carrying what it did. The `action`
-- column exists so the UI can report "3 updated, 1 cancelled, 2 skipped"
-- instead of a bare count — the cancellations are precisely the rows a human
-- needs to look at, and a count would hide them.
create or replace function public.regenerate_contract_invoices(p_contract_id uuid)
returns table (
  id uuid, code text, period_year integer, period_month integer,
  total numeric, state text, action text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract public.contracts%rowtype;
  v_invoice public.invoices%rowtype;
  v_period_start date;
  v_horizon date := date_trunc('month', current_date)::date;
  v_should_exist boolean;
  v_amounts record;
  v_line integer;
  v_item_total numeric(14,3);
  v_concession public.concessions%rowtype;
  v_concession_amount numeric(14,3);
  v_year integer;
  -- Deliberately NOT invoices%rowtype: generate_invoices_for_year returns its
  -- own column list, and assigning that into a table rowtype matches by
  -- position, not by name — period_year lands in company_id and the cast blows
  -- up with "invalid input syntax for type uuid".
  v_generated record;
begin
  -- Same guard as generate_invoices_for_year / backfill_contract_invoices.
  --
  -- It stays IN the function and the function is called only from a server
  -- function — never from a trigger on `contracts`. An accountant holds
  -- contracts.update but NOT invoices.create (03_phase1:296-311), so a trigger
  -- would raise 42501 inside their contract save and abort it. That is exactly
  -- how migration 52 broke, and it would be reintroduced here through functions
  -- that already existed.
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select c.* into v_contract from public.contracts c where c.id = p_contract_id;
  if not found then raise exception 'Contract not found'; end if;

  ---------------------------------------------------------------------------
  -- Pass 1 — reconcile the invoices that already exist
  ---------------------------------------------------------------------------
  for v_invoice in
    select i.* from public.invoices i
    where i.contract_id = p_contract_id
    order by i.period_year, i.period_month
  loop
    v_period_start := make_date(v_invoice.period_year, v_invoice.period_month, 1);

    -- The horizon matches generate_invoices_for_year, which skips any period
    -- after the current month. Nothing in this system generates forward yet —
    -- see the spec; that is a separate finding, deliberately not fixed here.
    v_should_exist :=
      v_period_start >= date_trunc('month', v_contract.start_date)::date
      and v_period_start <= date_trunc('month', v_contract.end_date)::date
      and v_period_start <= v_horizon
      and not public.period_in_free_months(p_contract_id, v_period_start);

    if v_should_exist then
      -- Money already moved against this invoice: do not touch it. Changing the
      -- amount owed on an invoice a tenant has paid against is a reconciliation
      -- decision, not an automatic one.
      --
      -- This is also what keeps the `paid <= total` CHECK satisfiable: lowering
      -- `total` under an existing `paid` would raise. And note we never write
      -- `paid` at all — migration 52 did, with no backing allocations, and the
      -- next set_invoice_paid recomputed it from surviving allocations and
      -- silently zeroed it.
      if coalesce(v_invoice.paid, 0) > 0
        or v_invoice.state in ('paid', 'partially_paid', 'cancelled', 'waived') then
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
        return next;
        continue;
      end if;

      select * into v_amounts
        from public.contract_period_amounts(p_contract_id, v_period_start);

      -- In place. `id`, `code` and `idempotency_key` are untouched, which is the
      -- entire point: allocations, receipts, notifications and any pending
      -- payment_requests link all keep resolving. `balance` is a generated
      -- column and must never appear here.
      update public.invoices i
         set subtotal = v_amounts.subtotal,
             discount = v_amounts.discount,
             total = v_amounts.total,
             due_date = make_date(
               v_invoice.period_year, v_invoice.period_month, v_contract.due_day
             )
       where i.id = v_invoice.id;

      -- Items back the printed invoice, so stale items would contradict the
      -- total. Delete first: without it, line numbers collide and concession
      -- lines accumulate on every run.
      delete from public.invoice_items where invoice_id = v_invoice.id;
      insert into public.invoice_items (
        invoice_id, line, description_ar, description_en, quantity,
        unit_price, discount_percent, amount, is_concession
      ) values (
        v_invoice.id, 1, 'قيمة استثمار شهرية', 'Monthly investment value',
        1, v_amounts.subtotal, 0, v_amounts.subtotal, false
      );
      v_line := 2;
      v_item_total := v_amounts.subtotal;
      for v_concession in
        select cn.* from public.concessions cn
        where cn.contract_id = p_contract_id and cn.status = 'active'
          and cn.type <> 'free_months'
          and cn.start_date <= v_period_start and cn.end_date >= v_period_start
        order by case cn.type when 'percentage_discount' then 1 else 2 end,
          cn.created_at, cn.id
      loop
        if v_concession.type = 'percentage_discount' then
          v_concession_amount := round(
            v_item_total * coalesce(v_concession.discount_percent, 0) / 100, 3
          );
        else
          v_concession_amount := least(
            v_item_total, coalesce(v_concession.discount_amount, 0)
          );
        end if;
        v_item_total := greatest(0, v_item_total - v_concession_amount);
        insert into public.invoice_items (
          invoice_id, line, description_ar, description_en, quantity,
          unit_price, discount_percent, amount, is_concession
        ) values (
          v_invoice.id, v_line,
          case v_concession.type
            when 'percentage_discount' then 'خصم نسبة مئوية' else 'خصم مبلغ ثابت' end,
          case v_concession.type
            when 'percentage_discount' then 'Percentage discount' else 'Fixed discount' end,
          1, 0, coalesce(v_concession.discount_percent, 0),
          -v_concession_amount, true
        );
        v_line := v_line + 1;
      end loop;

      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_amounts.total; state := v_invoice.state::text; action := 'updated';
      return next;

    else
      -- The period is no longer covered by the contract (shortened dates, or a
      -- free-months concession now covers it).
      if coalesce(v_invoice.paid, 0) = 0
        and v_invoice.state in ('due', 'overdue')
        and not exists (
          select 1 from public.payment_allocations pa where pa.invoice_id = v_invoice.id
        )
        and not public.invoice_has_pending_request(v_invoice.id)
      then
        delete from public.invoice_items where invoice_id = v_invoice.id;
        -- Aliased: this function's OUT parameters are named `id`, `code`,
        -- `total`, `state` … so an unqualified `where id = …` is ambiguous
        -- between the column and the output variable.
        delete from public.invoices as i where i.id = v_invoice.id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'deleted'; action := 'deleted';
        return next;
      else
        -- Carries money, an allocation, or a live payment link. Cancel it and
        -- surface it; a financial record is never destroyed.
        update public.invoices as i set state = 'cancelled' where i.id = v_invoice.id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'cancelled'; action := 'cancelled';
        return next;
      end if;
    end if;
  end loop;

  ---------------------------------------------------------------------------
  -- Pass 2 — create the periods that are missing
  ---------------------------------------------------------------------------
  -- Delegated to the existing generator so concessions, invoice_items and code
  -- allocation come along for free. It uses ON CONFLICT DO NOTHING, so it only
  -- inserts periods that do not already exist — including, deliberately, not
  -- resurrecting a period whose invoice was cancelled above. Bringing a
  -- cancelled invoice back is a human decision.
  for v_year in
    extract(year from v_contract.start_date)::integer ..
    least(
      extract(year from current_date)::integer,
      extract(year from v_contract.end_date)::integer
    )
  loop
    for v_generated in
      select gi.id, gi.code, gi.period_year, gi.period_month, gi.total
        from public.generate_invoices_for_year(p_contract_id, v_year, true) gi
    loop
      id := v_generated.id; code := v_generated.code;
      period_year := v_generated.period_year; period_month := v_generated.period_month;
      total := v_generated.total; state := 'due'; action := 'inserted';
      return next;
    end loop;
  end loop;

  -- Anything now past its due date + grace becomes overdue, matching what
  -- backfill_contract_invoices does after a create.
  update public.invoices i
     set state = 'overdue'
    from public.contracts c
   where i.contract_id = c.id
     and i.contract_id = p_contract_id
     and i.state in ('due', 'partially_paid')
     and i.balance > 0
     and (i.due_date + c.grace_days) < current_date;
end;
$$;

revoke all on function public.invoice_has_pending_request(uuid) from public;
revoke all on function public.contract_period_amounts(uuid, date) from public;
revoke all on function public.regenerate_contract_invoices(uuid) from public;

grant execute on function public.invoice_has_pending_request(uuid) to authenticated, service_role;
grant execute on function public.contract_period_amounts(uuid, date) to authenticated, service_role;
grant execute on function public.regenerate_contract_invoices(uuid) to authenticated, service_role;
