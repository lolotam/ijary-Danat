-- 82_billing_safety_archived_contracts.sql
--
-- Billing safety: archived contracts must not be billable.
--
-- Why a new file, not an edit of 05/23/37/55/58:
--   Supersede-by-number. SQL functions are `create or replace`; the LIVE
--   definition of any function is the one in the HIGHEST-numbered migration
--   file. Structure tests (and humans) read migration text by filename, so
--   patching an old migration would leave the suite asserting against text
--   that never re-applies on an already-migrated database.
--
-- No `drop function if exists` anywhere in this file.
--   This migration changes NO signature and NO OUT-parameter row type, so
--   plain `create or replace` is legal for all six. Migration 58 needed a
--   drop only because it changed an OUT row type. A spurious drop here would
--   reset the grants that follow each function.
--
-- What this migration deliberately does NOT do:
--   It does not write `waived`, does not cancel or modify any invoice, and
--   does not settle any balance. Those are business decisions handled by a
--   later contract-close-out feature. This migration only stops new billing
--   (and stops overdue / expiry noise for already-archived rows).
--
-- Background:
--   archiveRefundTarget() stamps archived_at on tenant and contract but never
--   changes contracts.state, so archived contracts sit at state='active'.
--   READ paths filter archived_at; money paths did not — so an archived
--   contract stayed fully billable, could flip to overdue, and stayed a
--   contract-expiry-reminder candidate. A generator-only guard is not enough:
--   reapply deletes invoices before calling backfill, and regenerate Pass 1
--   mutates totals/state without entering the generator at all.

-- ---------------------------------------------------------------------------
-- 1. generate_invoices_for_year — bulk skip + direct-id reject
-- ---------------------------------------------------------------------------
-- Copied from migration 37 with two archive guards only:
--   (a) loop predicate: and c.archived_at is null (bulk path SKIPS)
--   (b) early raise when p_contract_id is not null and that row is archived
--       (direct-id path REJECTS — silent zero is how this class of bug hides)

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

        v_subtotal := v_contract.monthly_amount;
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
          v_contract.unit_id, v_year, v_month, current_date,
          make_date(v_year, v_month, v_contract.due_day), v_subtotal, v_discount,
          v_total, 0, 'due', true,
          v_contract.id::text || ':' || v_year::text || ':' || v_month::text
        from public.tenants t where t.id = v_contract.tenant_id
        on conflict on constraint invoices_contract_id_period_year_period_month_key do nothing
        returning invoices.id, invoices.code into v_invoice_id, v_invoice_code;
        if v_invoice_id is null then continue; end if;
        insert into public.invoice_items (
          invoice_id, line, description_ar, description_en, quantity,
          unit_price, discount_percent, amount, is_concession
        ) values (
          v_invoice_id, 1, 'قيمة استثمار شهرية', 'Monthly investment value',
          1, v_subtotal, 0, v_subtotal, false
        );
        v_line := 2;
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
-- 2. backfill_contract_invoices — guard before any generate_invoices_for_year
-- ---------------------------------------------------------------------------
-- Copied from migration 23; archive guard after if not found.

create or replace function public.backfill_contract_invoices(p_contract_id uuid)
returns table (
  id uuid, code text, contract_id uuid, period_year integer,
  period_month integer, total numeric, state text
)
language plpgsql security definer set search_path = public
as $$
declare
  v_contract public.contracts%rowtype;
  v_year integer;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  select c.* into v_contract from public.contracts c where c.id = p_contract_id;
  if not found then raise exception 'Contract not found'; end if;

  if v_contract.archived_at is not null then
    raise exception 'Contract % is archived and cannot be billed. Restore it first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  for v_year in
    extract(year from v_contract.start_date)::integer ..
    least(
      extract(year from current_date)::integer,
      extract(year from v_contract.end_date)::integer
    )
  loop
    return query
      select * from public.generate_invoices_for_year(p_contract_id, v_year, true);
  end loop;

  -- Anything already past its due date + grace becomes overdue immediately,
  -- so a back-dated contract lands in the state the admin expects.
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
revoke all on function public.backfill_contract_invoices(uuid) from public;
grant execute on function public.backfill_contract_invoices(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. reapply_contract_invoices — guard BEFORE the delete
-- ---------------------------------------------------------------------------
-- Copied from migration 37. Ordering is the entire point: the previous hole
-- was delete-then-delegate, so a generator-only guard still destroyed rows.

create or replace function public.reapply_contract_invoices(p_contract_id uuid)
returns table (
  id uuid, code text, contract_id uuid, period_year integer,
  period_month integer, total numeric, state text
)
language plpgsql security definer set search_path = public
as $$
declare
  v_contract public.contracts%rowtype;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select c.* into v_contract from public.contracts c where c.id = p_contract_id;
  if not found then raise exception 'Contract not found'; end if;

  if v_contract.archived_at is not null then
    raise exception 'Contract % is archived and cannot be billed. Restore it first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  -- Never touch paid / partially paid / allocated invoices.
  delete from public.invoices i
  where i.contract_id = p_contract_id
    and coalesce(i.paid, 0) = 0
    and i.state in ('due', 'overdue')
    and not exists (
      select 1 from public.payment_allocations pa where pa.invoice_id = i.id
    );

  return query
    select * from public.backfill_contract_invoices(p_contract_id);
end;
$$;
revoke all on function public.reapply_contract_invoices(uuid) from public;
grant execute on function public.reapply_contract_invoices(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. regenerate_contract_invoices — guard BEFORE Pass 1
-- ---------------------------------------------------------------------------
-- Copied from migration 55. Pass 1 updates totals/due_date and writes
-- state='cancelled' without entering the generator at all.

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

  if v_contract.archived_at is not null then
    raise exception 'Contract % is archived and cannot be billed. Restore it first.',
      v_contract.code using errcode = 'check_violation';
  end if;

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
revoke all on function public.regenerate_contract_invoices(uuid) from public;
grant execute on function public.regenerate_contract_invoices(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. evaluate_overdue — skip invoices on archived contracts
-- ---------------------------------------------------------------------------
-- Copied from migration 05; add c.archived_at is null to the eligible CTE.

create or replace function public.evaluate_overdue(p_as_of date default null)
returns table (invoice_id uuid, old_state text, new_state text)
language plpgsql security definer set search_path = public
as $$
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  return query
  with eligible as (
    select i.id, i.state::text as previous_state
    from public.invoices i join public.contracts c on c.id = i.contract_id
    where i.state in ('due', 'partially_paid') and i.balance > 0
      and (i.due_date + c.grace_days) < coalesce(p_as_of, current_date)
      and c.archived_at is null
    for update of i
  ),
  changed as (
    update public.invoices i set state = 'overdue'
    from eligible e where i.id = e.id returning i.id, e.previous_state
  )
  select changed.id, changed.previous_state, 'overdue'::text from changed;
end;
$$;
revoke all on function public.evaluate_overdue(date) from public;
grant execute on function public.evaluate_overdue(date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. identify_contract_expiry_reminders — skip archived contracts
-- ---------------------------------------------------------------------------
-- Copied from migration 58 (current highest definition). Signature and OUT
-- row type are unchanged, so create or replace is legal — no routine DROP.

create or replace function public.identify_contract_expiry_reminders(p_as_of date default null)
returns table(
  contract_id uuid,
  tenant_id uuid,
  days_until int,
  milestone text,
  template_type text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_as_of date := coalesce(p_as_of, current_date);
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'notifications.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  select b.contract_id, b.tenant_id, b.days_until, b.milestone, 'contract_expiry'::text
  from (
    select
      c.id as contract_id,
      c.tenant_id,
      (c.end_date - v_as_of)::int as days_until,
      case
        when (c.end_date - v_as_of) < 0   then null
        when (c.end_date - v_as_of) <= 1  then '1d'
        when (c.end_date - v_as_of) <= 7  then '7d'
        when (c.end_date - v_as_of) <= 30 then '30d'
        when (c.end_date - v_as_of) <= 60 then '60d'
        when (c.end_date - v_as_of) <= 90 then '90d'
        when (c.end_date - v_as_of) <= 120 then '120d'
        when (c.end_date - v_as_of) <= 150 then '150d'
        when (c.end_date - v_as_of) <= 180 then '180d'
        else null
      end as milestone
    from public.contracts c
    join public.tenants t on t.id = c.tenant_id
    where c.state = 'active'
      and c.archived_at is null
  ) b
  where b.milestone is not null
  order by b.days_until, b.contract_id;
end;
$$;
revoke all on function public.identify_contract_expiry_reminders(date) from public;
grant execute on function public.identify_contract_expiry_reminders(date)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Repair: terminate rows that are already archived but still "open"
-- ---------------------------------------------------------------------------
-- Idempotent by construction — a re-run matches zero rows, because
-- `terminated` is not in the IN list.
--
-- `terminated`, not `expired` — these contracts were cut short by an archive,
-- not run to term. get_contracts_summary and shouldNotifyContractEnded treat
-- both identically, so downstream reads are unchanged.
--
-- Cannot collide with `one_active_contract_per_unit` (db/migrations/04:179-180)
-- — that PARTIAL unique index covers exactly draft/active/frozen/suspended, so
-- moving rows to `terminated` REMOVES them from it. It can only relieve
-- pressure, never create a conflict.
--
-- Unit release happens via migration 76's trigger, never a direct write.
-- trg_contract_sync_unit_status fires on `update of ... state ...` (and
-- archived_at). A direct write against the units table would be REJECTED by
-- trg_unit_enforce_derived_status anyway. Do NOT touch the units table here.
--
-- No mail is sent — notifyContractLifecycle is client-side only and raw SQL
-- cannot reach it. Two triggers do fire and both are wanted:
--   trg_contract_deactivate_portal (finishes the portal lockout the original
--     archive only half-did) and
--   trg_contract_sync_tenant_lifecycle (recomputes lifecycle).

update public.contracts c
   set state = 'terminated'
 where c.archived_at is not null
   and c.state in ('draft', 'active', 'frozen', 'suspended');
