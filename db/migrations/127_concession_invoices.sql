-- 127_concession_invoices.sql
-- Percentage and fixed discounts stop being derived from concession date ranges
-- at generation time and become explicit links to specific invoices.
--
-- The date-range loop in generate_invoices_for_year subtracted EVERY active
-- concession covering a period, so two overlapping records both reduced the same
-- invoice (INV-0000250 carried 100 and 200). unique (invoice_id) is the business
-- rule made declarative: one discount per invoice, freed again when the
-- concession is deleted (on delete cascade).

create table if not exists public.concession_invoices (
  concession_id uuid not null references public.concessions(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (concession_id, invoice_id),
  unique (invoice_id)
);

-- Supabase grants ALL to anon and authenticated on new public tables;
-- revoke from public does not reach either role.
revoke all on public.concession_invoices from public;
revoke all on public.concession_invoices from anon;
revoke all on public.concession_invoices from authenticated;
grant select on public.concession_invoices to authenticated;
grant select, insert, update, delete on public.concession_invoices to service_role;

alter table public.concession_invoices enable row level security;

-- Mirrors concessions_select_allowed (04:287): staff see every link; a tenant
-- sees only links on concessions of their own contracts.
drop policy if exists concession_invoices_select_allowed on public.concession_invoices;
create policy concession_invoices_select_allowed on public.concession_invoices
  for select to authenticated using (
    public.is_staff(auth.uid()) or exists (
      select 1 from public.concessions cn
      join public.contracts c on c.id = cn.contract_id
      join public.profiles p on p.tenant_id = c.tenant_id
      where cn.id = concession_invoices.concession_id and p.id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- يولّد فواتير السنة دون تطبيق خصم نسبة/ثابت من نطاق التاريخ.
-- generate_invoices_for_year — copied from 119, percentage/fixed loop removed.
-- free_months still skips invoice creation via period_in_free_months.
-- ---------------------------------------------------------------------------
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
  v_line integer;
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

  if p_contract_id is not null then
    select c.* into v_contract from public.contracts c where c.id = p_contract_id;
    if v_contract.archived_at is not null then
      raise exception 'Contract % is archived and cannot be billed. Restore it first.',
        v_contract.code using errcode = 'check_violation';
    end if;
    if v_contract.id is not null and not exists (
      select 1 from public.contract_units cu where cu.contract_id = p_contract_id
    ) then
      raise exception 'Contract % has no units and cannot be billed. Add at least one unit first.',
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
      and exists (select 1 from public.contract_units cu where cu.contract_id = c.id)
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

        if public.period_in_free_months(v_contract.id, v_period_start) then
          continue;
        end if;

        select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
          from public.contract_units cu where cu.contract_id = v_contract.id;
        -- Discounts are bound to invoices via concession_invoices, never
        -- derived from overlapping date ranges at generation time.
        v_total := v_subtotal;
        v_discount := 0;
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
        id := v_invoice_id; code := v_invoice_code; contract_id := v_contract.id;
        period_year := v_year; period_month := v_month; total := v_total; state := 'due';
        return next;
      end loop;
    end if;
  end loop;
end;
$$;

revoke execute on function public.generate_invoices_for_year(uuid, integer, boolean)
  from public, anon;
grant execute on function public.generate_invoices_for_year(uuid, integer, boolean)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- contract_period_amounts — copied from 119. Percentage/fixed no longer
-- subtract here; regenerate would otherwise re-derive overlapping discounts.
-- ---------------------------------------------------------------------------
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
begin
  select c.* into v_contract from public.contracts c where c.id = p_contract_id;
  if not found then
    raise exception 'Contract not found';
  end if;

  if not exists (
    select 1 from public.contract_units cu where cu.contract_id = v_contract.id
  ) then
    raise exception 'Contract % has no units and cannot be priced. Add at least one unit first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
    from public.contract_units cu where cu.contract_id = v_contract.id;

  subtotal := v_subtotal;
  discount := 0;
  total := v_subtotal;
  return next;
end;
$$;

revoke execute on function public.contract_period_amounts(uuid, date) from public, anon;
grant execute on function public.contract_period_amounts(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- regenerate_contract_invoices — copied from 119. Linked discounts are skipped
-- (same protection paid invoices already have). Date-range concession items
-- are no longer rewritten; apply_concession_to_invoices owns those lines.
-- ---------------------------------------------------------------------------
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
  v_should_exist boolean;
  v_amounts record;
  v_line integer;
  v_year integer;
  v_generated record;
  v_unit record;
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

  for v_invoice in
    select i.* from public.invoices i
    where i.contract_id = p_contract_id
    order by i.period_year, i.period_month
  loop
    v_period_start := make_date(v_invoice.period_year, v_invoice.period_month, 1);

    if coalesce(v_invoice.paid, 0) > 0
      or v_invoice.state in ('paid', 'partially_paid') then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    if v_invoice.state in ('cancelled', 'waived') then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    -- An applied discount is as sacred as a payment: regenerating must not
    -- wipe the link or reprice the invoice against today's rent.
    if exists (
      select 1 from public.concession_invoices ci where ci.invoice_id = v_invoice.id
    ) then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    v_should_exist :=
      v_period_start >= date_trunc('month', v_contract.start_date)::date
      and v_period_start <= date_trunc('month', v_contract.end_date)::date
      and not public.period_in_free_months(p_contract_id, v_period_start);

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
      if v_invoice.state in ('due', 'overdue')
        and not exists (
          select 1 from public.payment_allocations pa where pa.invoice_id = v_invoice.id
        )
        and not public.invoice_has_pending_request(v_invoice.id)
        and not exists (
          select 1 from public.concession_invoices ci where ci.invoice_id = v_invoice.id
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

revoke execute on function public.regenerate_contract_invoices(uuid) from public, anon;
grant execute on function public.regenerate_contract_invoices(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- reapply_contract_invoices — copied from 97. Delete also requires no
-- concession_invoices row, or applying a discount then regenerating erases it.
-- ---------------------------------------------------------------------------
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

  delete from public.invoices i
  where i.contract_id = p_contract_id
    and coalesce(i.paid, 0) = 0
    and i.state in ('due', 'overdue')
    and not exists (
      select 1 from public.payment_allocations pa where pa.invoice_id = i.id
    )
    and make_date(i.period_year, i.period_month, 1)
          <= date_trunc('month', current_date)::date
    and not exists (
      select 1 from public.concession_invoices ci
      where ci.invoice_id = i.id
    );

  return query
    select * from public.backfill_contract_invoices(p_contract_id);
end;
$$;

revoke execute on function public.reapply_contract_invoices(uuid)
  from public, anon;
grant execute on function public.reapply_contract_invoices(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- يربط تنازل نسبة/مبلغ ثابت بفواتير مختارة، ويكتب الخصم والإجمالي معاً.
-- Computes from each invoice's own stored subtotal so a historical invoice is
-- never repriced against today's rent. discount is an ordinary stored column;
-- only balance is generated.
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

    -- Always from the invoice's own stored subtotal, never contract_units.
    if v_concession.type = 'percentage_discount' then
      v_discount := least(
        v_invoice.subtotal,
        round(v_invoice.subtotal * coalesce(v_concession.discount_percent, 0) / 100, 3)
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

-- ---------------------------------------------------------------------------
-- Restore invoice amounts when a concession is deleted.
--
-- A BEFORE DELETE trigger, not an RPC: the admin UI (and any contract cascade)
-- already deletes from concessions directly. An RPC the UI can forget to call
-- would leave discounted totals with no remaining concession. SECURITY DEFINER
-- because the deleting role has contracts.update, not invoices.update.
-- ---------------------------------------------------------------------------
create or replace function public.tg_restore_invoices_on_concession_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link record;
  v_invoice public.invoices%rowtype;
begin
  if old.type = 'free_months' then
    return old;
  end if;

  for v_link in
    select ci.invoice_id
      from public.concession_invoices ci
     where ci.concession_id = old.id
  loop
    select i.* into v_invoice
      from public.invoices i
     where i.id = v_link.invoice_id
     for update;
    if not found then
      continue;
    end if;

    update public.invoices
       set discount = 0,
           total = subtotal
     where id = v_invoice.id;

    delete from public.invoice_items
     where invoice_id = v_invoice.id
       and is_concession = true;
  end loop;

  return old;
end;
$$;

revoke execute on function public.tg_restore_invoices_on_concession_delete()
  from public, anon;

drop trigger if exists trg_restore_invoices_on_concession_delete on public.concessions;
create trigger trg_restore_invoices_on_concession_delete
  before delete on public.concessions
  for each row
  execute function public.tg_restore_invoices_on_concession_delete();
