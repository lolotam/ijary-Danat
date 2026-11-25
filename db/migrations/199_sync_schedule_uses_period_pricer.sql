-- 199_sync_schedule_uses_period_pricer.sql
--
-- المزامنة تسعّر عبر المسرّع المشترك في التحديث والملء معاً.
--
-- sync_contract_invoice_schedule priced both halves inline: the reprice pass
-- rebuilt lines from base contract_units while its header came from the
-- period-aware contract_period_amounts, and the fill pass priced a missing
-- month from base rent plus extras. All three sites now route through the
-- period pricer (196), so a fill and a reprice can never disagree about the
-- same month.

-- ---------------------------------------------------------------------------
-- sync_contract_invoice_schedule -- re-issued from 170, repriced and filled via the pricer
-- ---------------------------------------------------------------------------
-- Copied verbatim from db/migrations/170_free_month_generates_nothing.sql:454-771
-- except hunks A (reprice line loop), B (fill pricing) and C (fill line loop).
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
        select upa.unit_id, upa.monthly_amount, upa.unit_code as code
          from public.contract_unit_period_amounts(v_contract.id, v_period_start) upa
         order by upa.line_order, upa.unit_id
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
      v_line := public.append_extra_charge_items(v_invoice.id, v_contract.id, v_line);

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

      -- Priced through the shared pricer since 199, so a fill and a reprice
      -- can never disagree about the same month.
      select pa.subtotal into v_subtotal
        from public.contract_period_amounts(p_contract_id, v_cursor) pa;

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
          select upa.unit_id, upa.monthly_amount, upa.unit_code as code
            from public.contract_unit_period_amounts(v_contract.id, v_cursor) upa
           order by upa.line_order, upa.unit_id
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
        v_line := public.append_extra_charge_items(v_invoice_id, p_contract_id, v_line);

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
