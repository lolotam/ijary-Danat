-- 139_contract_schedule_sync.sql
--
-- Editing a contract's free months did not resynchronise the invoices that had
-- already been generated for it.
--
-- Reported case: a 3-year contract (2026-08-01 → 2029-07-31) with all 36
-- invoices generated. Adding "3 free months" removed only ONE invoice.
--
-- Root cause. `ConcessionsDialog` calls `reapply_contract_invoices` after a
-- free-months concession is added or deleted, and that function deletes only
-- invoices whose period satisfies
--
--   make_date(i.period_year, i.period_month, 1) <= date_trunc('month', current_date)
--
-- (127_concession_invoices.sql:445). On 2026-08-15 that window contains exactly
-- one month of the contract — August. September and October were never
-- considered. The clamp is not itself a bug: migrations 94/97 pinned the rule
-- that a *reconciliation* path never creates a future invoice, and
-- src/db/invoiceRegeneration.sqltest.ts:627 and :722 hold both sides of it.
-- Loosening reapply would break that rule for every other caller.
--
-- So this migration does not touch reapply or regenerate. It adds a third,
-- explicitly-scoped entry point — `sync_contract_invoice_schedule` — whose
-- contract is: make the invoice set match the contract's current configuration
-- *within a horizon the contract has already been generated to*, and never past
-- it. Prune what should no longer exist, restore what should.
--
-- Three further defects fixed here, all found while tracing the first:
--
--   1. period_in_free_months derived the free window from the concession's
--      date RANGE, and `ConcessionsDialog` builds that range as
--      `start + N months - 1 day`. For a contract starting mid-month
--      (2026-08-15, 3 free months → 2026-11-14) `date_trunc('month', …)`
--      then makes Aug, Sep, Oct AND Nov free — four calendar months for three
--      requested. The count the user typed is now authoritative.
--
--   2. There is no *edit* path for a concession — the dialog only adds and
--      deletes — so "3 free months → 1" is delete-then-add. The delete trigger
--      returns early for free_months (127:623) and restores nothing, so the
--      months freed at 3 stayed gone. The fill step below is what brings them
--      back.
--
--   3. The generation horizon was only ever inferable from the invoice rows
--      themselves, which is circular: a sync that deletes the last invoices of
--      a schedule destroys the very evidence of how far that schedule reached,
--      and a later un-freeing could not restore them. It is now a durable,
--      ratcheting column.
--
-- On the duplication below. sync_contract_invoice_schedule's prune half is
-- copied from regenerate_contract_invoices (127) rather than factored into a
-- shared primitive, and that is deliberate. `create or replace` cannot share a
-- body across versions, so copy-forward is this directory's established
-- pattern — 127 says "copied from 119", 119 from 112, and so on. Extracting a
-- common primitive would mean rewriting regenerate_contract_invoices too, on
-- the critical money path, with a dozen pinned tests behind it, for a change
-- whose purpose is elsewhere. The skip rules for paid, cancelled, waived and
-- discount-linked invoices ARE duplicated knowledge; if they change, both
-- functions must change together, and that is the cost being accepted here.

-- ---------------------------------------------------------------------------
-- The generation horizon, recorded rather than inferred.
-- ---------------------------------------------------------------------------
alter table public.contracts
  add column if not exists invoices_generated_through date;

comment on column public.contracts.invoices_generated_through is
  'First day of the furthest month this contract has ever had invoices generated for. Ratchets forward only — see 139_contract_schedule_sync.sql. Read via contract_invoice_horizon(); never write it directly.';

-- Seed from what exists today, so the column is meaningful on the first run
-- rather than only for contracts generated after this migration.
update public.contracts c
   set invoices_generated_through = sub.max_period
  from (
    select i.contract_id,
           max(make_date(i.period_year, i.period_month, 1)) as max_period
      from public.invoices i
     group by i.contract_id
  ) sub
 where sub.contract_id = c.id
   and c.invoices_generated_through is distinct from sub.max_period
   and (c.invoices_generated_through is null
        or c.invoices_generated_through < sub.max_period);

-- ---------------------------------------------------------------------------
-- يرفع أفق التوليد المسجَّل للعقد إلى أبعد شهر له فاتورة.
--
-- Ratchets forward only. That one-directional rule is the whole point: it is
-- what lets a month be freed (its invoice deleted) and later un-freed (the
-- invoice restored), because the horizon does not fall with the rows.
-- Writes only when the value actually moves, so a no-op sync does not churn
-- contracts.updated_at.
-- ---------------------------------------------------------------------------
-- Dropped, not replaced: adding a defaulted second parameter creates a new
-- signature, and a one-argument call would then be ambiguous between the two.
drop function if exists public.bump_contract_invoice_horizon(uuid);

create or replace function public.bump_contract_invoice_horizon(
  p_contract_id uuid,
  p_through date default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max date;
begin
  select max(make_date(i.period_year, i.period_month, 1))
    into v_max
    from public.invoices i
   where i.contract_id = p_contract_id;

  -- `p_through` is the range a generator was ASKED to cover, which is not the
  -- same as the range it inserted rows for. Generate a year whose every month
  -- is free and nothing is inserted at all: without this the horizon would
  -- never move, and reducing the free months later could not restore the
  -- periods the operator had already generated through.
  v_max := greatest(v_max, date_trunc('month', p_through)::date);

  if v_max is null then
    return;
  end if;

  update public.contracts c
     set invoices_generated_through = v_max
   where c.id = p_contract_id
     and (c.invoices_generated_through is null
          or c.invoices_generated_through < v_max);
end;
$$;

-- Not granted to `authenticated`. It writes to contracts and takes no
-- permission check of its own, because its only callers are the SECURITY
-- DEFINER generators below — which run as the owner and so do not need the
-- grant. Granting it would let any logged-in role, tenant portal users
-- included, move a contract's generation horizon directly.
revoke execute on function public.bump_contract_invoice_horizon(uuid, date)
  from public, anon, authenticated;
grant execute on function public.bump_contract_invoice_horizon(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- يعيد أبعد شهر يُسمح لمزامنة الجدول بأن تولّد حتى نهايته.
--
-- Never before the current month (a contract still bills this month even if it
-- has never been generated), never past the contract's own end month. Between
-- those two, whatever the contract has already been generated to.
-- ---------------------------------------------------------------------------
create or replace function public.contract_invoice_horizon(p_contract_id uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select least(
    greatest(
      coalesce(c.invoices_generated_through, date_trunc('month', current_date)::date),
      date_trunc('month', current_date)::date
    ),
    date_trunc('month', c.end_date)::date
  )
  from public.contracts c
  where c.id = p_contract_id;
$$;

revoke execute on function public.contract_invoice_horizon(uuid) from public, anon;
grant execute on function public.contract_invoice_horizon(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- هل يقع هذا الشهر ضمن الأشهر المجانية للعقد؟
--
-- Supersedes 37. The month COUNT the user typed (`concessions.free_months`) is
-- now authoritative; the stored date range is only consulted for legacy rows
-- that predate the count (`free_months = 0`, the column default). The range was
-- never a safe source of truth for a contract starting mid-month: the dialog
-- writes `start + N months - 1 day`, and comparing that on `date_trunc('month')`
-- turns 3 requested free months into 4 free calendar months.
--
-- Half-open interval `[first free month, first billed month)` so N months means
-- exactly N months regardless of month lengths.
-- ---------------------------------------------------------------------------
create or replace function public.period_in_free_months(
  p_contract_id uuid,
  p_period_start date
) returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.concessions cn
    where cn.contract_id = p_contract_id
      and cn.status = 'active'
      and cn.type = 'free_months'
      and date_trunc('month', cn.start_date)::date <= p_period_start
      and p_period_start < case
            when coalesce(cn.free_months, 0) > 0
              then (date_trunc('month', cn.start_date)
                      + make_interval(months => cn.free_months))::date
            else (date_trunc('month', cn.end_date) + interval '1 month')::date
          end
  );
$$;

revoke execute on function public.period_in_free_months(uuid, date) from public, anon;
grant execute on function public.period_in_free_months(uuid, date)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- يزامن فواتير العقد مع إعداداته الحالية داخل أفق التوليد المسجَّل.
--
-- Copied from regenerate_contract_invoices (127) for the prune half — the
-- skip rules for paid, cancelled, waived and discount-linked invoices are the
-- money-safety rules of migrations 94/95/127 and must stay identical — then
-- given a fill half that regenerate deliberately does not have.
--
-- Prune: every existing invoice is repriced if it should still exist, deleted
-- if it is provably inert (unpaid, unallocated, no live payment request, no
-- discount link), and cancelled in place otherwise. A cancelled or waived row
-- is never resurrected; that is a human decision.
--
-- Fill: every month from the contract's start through the horizon that is in
-- term, not free, and has no invoice row at all gets one. This is the half that
-- restores months when free months are reduced. It cannot run away, because the
-- horizon is capped by what the contract has already been generated to.
--
-- A restored month arrives as a NEW invoice with a NEW code from
-- next_invoice_code(). The original row is only ever deleted when nothing
-- references it; anything carrying money, an allocation, a live payment link or
-- a discount is cancelled in place and keeps its id, code and audit trail.
-- ---------------------------------------------------------------------------
create or replace function public.sync_contract_invoice_schedule(p_contract_id uuid)
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
  v_should_exist boolean;
  v_amounts record;
  v_line integer;
  v_unit record;
  v_horizon date;
  v_cursor date;
  v_invoice_id uuid;
  v_invoice_code text;
  v_subtotal numeric(14,3);
  v_this_month date;
  v_blocker public.invoices%rowtype;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- `for update` holds the contract row for the whole reconciliation. Without
  -- it a payment allocation or a KNET request can land between the
  -- "provably inert" test and the delete that trusts it, and the money would
  -- reference a row that no longer exists.
  select c.* into v_contract
    from public.contracts c
   where c.id = p_contract_id
     for update;
  if not found then raise exception 'Contract not found'; end if;

  if v_contract.archived_at is not null then
    raise exception 'Contract % is archived and cannot be billed. Restore it first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from public.contract_units cu where cu.contract_id = p_contract_id
  ) then
    raise exception 'Contract % has no units and cannot be billed. Add at least one unit first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  -- Read before anything is deleted. The column ratchets, so this is stable
  -- even across a free-month cycle that removes the furthest invoices.
  v_horizon := public.contract_invoice_horizon(p_contract_id);
  v_this_month := date_trunc('month', current_date)::date;

  -- ---------------- prune / reprice ----------------
  for v_invoice in
    select i.* from public.invoices i
    where i.contract_id = p_contract_id
    order by i.period_year, i.period_month
  loop
    v_period_start := make_date(v_invoice.period_year, v_invoice.period_month, 1);

    v_should_exist :=
      v_period_start >= date_trunc('month', v_contract.start_date)::date
      and v_period_start <= date_trunc('month', v_contract.end_date)::date
      and not public.period_in_free_months(p_contract_id, v_period_start);

    if coalesce(v_invoice.paid, 0) > 0
      or v_invoice.state in ('paid', 'partially_paid') then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    -- A cancelled or waived invoice is never touched. It is only REPORTED here
    -- when its month is genuinely finished with — out of term, or now free. If
    -- the month is still billable, the fill pass below reports the same row as
    -- `blocked` instead, because the real problem is that a billable month has
    -- no live invoice. Emitting from both loops would return one invoice twice
    -- and let a caller reading the first row conclude all was well.
    if v_invoice.state in ('cancelled', 'waived') then
      if not v_should_exist then
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
        return next;
      end if;
      continue;
    end if;

    -- An applied discount is as sacred as a payment: never repriced, never
    -- deleted. But if the month it sits on is no longer billable at all, the
    -- two settings contradict each other and only a human can say which wins —
    -- silently leaving a discounted invoice standing inside a free month would
    -- charge a tenant for a month they were told was free.
    if exists (
      select 1 from public.concession_invoices ci where ci.invoice_id = v_invoice.id
    ) then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text;
      action := case when v_should_exist then 'skipped' else 'blocked' end;
      return next;
      continue;
    end if;

    if v_should_exist then
      select * into v_amounts
        from public.contract_period_amounts(p_contract_id, v_period_start);

      update public.invoices i
         set subtotal = v_amounts.subtotal,
             discount = v_amounts.discount,
             total = v_amounts.total,
             unit_id = (select cu.unit_id from public.contract_units cu
                         where cu.contract_id = v_contract.id
                           and (select count(*) from public.contract_units c2
                                  where c2.contract_id = v_contract.id) = 1),
             due_date = make_date(
               v_invoice.period_year, v_invoice.period_month, v_contract.due_day
             )
       where i.id = v_invoice.id;

      delete from public.invoice_items where invoice_id = v_invoice.id;
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
          v_invoice.id, v_line, v_unit.unit_id,
          'قيمة استثمار شهرية — ' || v_unit.code,
          'Monthly investment value — ' || v_unit.code,
          1, v_unit.monthly_amount, 0, v_unit.monthly_amount, false
        );
        v_line := v_line + 1;
      end loop;

      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_amounts.total; state := v_invoice.state::text; action := 'updated';
      return next;

    else
      -- `contract_closeout_invoice_actions.invoice_id` is ON DELETE RESTRICT
      -- (84:198). Without this check the delete raises 23503 and takes the
      -- whole reconciliation down with it, on a contract whose only sin is
      -- having been closed out once.
      if v_invoice.state in ('due', 'overdue')
        and not exists (
          select 1 from public.payment_allocations pa where pa.invoice_id = v_invoice.id
        )
        and not public.invoice_has_pending_request(v_invoice.id)
        and not exists (
          select 1 from public.contract_closeout_invoice_actions ca
           where ca.invoice_id = v_invoice.id
        )
      then
        delete from public.invoice_items where invoice_id = v_invoice.id;
        delete from public.invoices as i where i.id = v_invoice.id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'deleted'; action := 'deleted';
        return next;
      else
        update public.invoices as i set state = 'cancelled' where i.id = v_invoice.id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'cancelled'; action := 'cancelled';
        return next;
      end if;
    end if;
  end loop;

  -- ---------------- fill ----------------
  -- A month is only filled when it has no invoice row at all. Any row, in any
  -- state, means the month is spoken for — which is what keeps this idempotent
  -- and what stops a cancelled or waived invoice being resurrected behind a
  -- human's back (55:313). A month whose only row is cancelled therefore stays
  -- unbilled: it is reported as `blocked` rather than quietly left out, because
  -- "the schedule matches the contract" is false for that month and the caller
  -- has to know.
  v_cursor := date_trunc('month', v_contract.start_date)::date;
  while v_cursor <= v_horizon loop
    if not public.period_in_free_months(p_contract_id, v_cursor) then
      select i.* into v_blocker
        from public.invoices i
       where i.contract_id = p_contract_id
         and i.period_year = extract(year from v_cursor)::integer
         and i.period_month = extract(month from v_cursor)::integer;

      if found then
        if v_blocker.state in ('cancelled', 'waived') then
          id := v_blocker.id; code := v_blocker.code;
          period_year := v_blocker.period_year; period_month := v_blocker.period_month;
          total := v_blocker.total; state := v_blocker.state::text; action := 'blocked';
          return next;
        end if;
        v_cursor := (v_cursor + interval '1 month')::date;
        continue;
      end if;

      -- Creating a *future* invoice for a contract that is not active would be
      -- a billing expansion nobody asked for; generate_invoices_for_year admits
      -- future periods only for active contracts (127:97) and this must not be
      -- the back door around that. Past and current months are still repaired
      -- for any state, matching backfill_contract_invoices.
      if v_cursor > v_this_month and v_contract.state <> 'active' then
        v_cursor := (v_cursor + interval '1 month')::date;
        continue;
      end if;

      select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
        from public.contract_units cu where cu.contract_id = p_contract_id;

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
        extract(year from v_cursor)::integer,
        extract(month from v_cursor)::integer,
        current_date,
        make_date(
          extract(year from v_cursor)::integer,
          extract(month from v_cursor)::integer,
          v_contract.due_day
        ),
        v_subtotal, 0, v_subtotal, 0, 'due', true,
        v_contract.id::text || ':' || extract(year from v_cursor)::integer::text
          || ':' || extract(month from v_cursor)::integer::text
      from public.tenants t where t.id = v_contract.tenant_id
      on conflict on constraint invoices_contract_id_period_year_period_month_key do nothing
      returning invoices.id, invoices.code into v_invoice_id, v_invoice_code;

      if v_invoice_id is not null then
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

        id := v_invoice_id; code := v_invoice_code;
        period_year := extract(year from v_cursor)::integer;
        period_month := extract(month from v_cursor)::integer;
        total := v_subtotal; state := 'due'; action := 'inserted';
        return next;
      end if;
    end if;

    v_cursor := (v_cursor + interval '1 month')::date;
  end loop;

  -- Overdue is recomputed in BOTH directions. The existing paths only ever
  -- promote due → overdue, so moving a contract's due_day or grace_days
  -- forward left invoices sitting in `overdue` for a deadline that no longer
  -- exists — a tenant chased for a month that is not late.
  update public.invoices i
     set state = 'overdue'
    from public.contracts c
   where i.contract_id = c.id
     and i.contract_id = p_contract_id
     and i.state in ('due', 'partially_paid')
     and i.balance > 0
     and (i.due_date + c.grace_days) < current_date;

  update public.invoices i
     set state = 'due'
    from public.contracts c
   where i.contract_id = c.id
     and i.contract_id = p_contract_id
     and i.state = 'overdue'
     and coalesce(i.paid, 0) = 0
     and (i.due_date + c.grace_days) >= current_date;

  perform public.bump_contract_invoice_horizon(p_contract_id);
end;
$$;

revoke execute on function public.sync_contract_invoice_schedule(uuid) from public, anon;
grant execute on function public.sync_contract_invoice_schedule(uuid)
  to authenticated, service_role;
