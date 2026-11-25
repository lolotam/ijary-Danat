-- 119_review_fixes.sql
--
-- Final-review fixes for the multi-unit-contracts feature (findings I1, I2,
-- I3, M1, M2, M6 of
-- .superpowers/sdd/2026-08-07-multi-unit-contracts/final-review.md).
--
-- Why a new file, not an edit of 110/112/116/117: supersede-by-number. SQL
-- functions are `create or replace` and the LIVE definition of a function is
-- the one in the HIGHEST-numbered migration that defines it. Editing an
-- already-applied migration changes nothing on a migrated database — see
-- db/README.md and migration 48's header for the last time that bit.
--
-- Every function below is copied VERBATIM from its live source file and then
-- edited only where the comment above it says. Copying a whole body to change
-- three lines is the correct move here, not duplication. No signature and no
-- `returns table (...)` row type changes, so plain `create or replace` stays
-- legal throughout — there is no `drop function` in this file.
--
-- Live sources:
--   tg_contract_units_sync_total   → 110_multi_unit_contracts.sql
--   generate_invoices_for_year     → 112_consolidated_invoicing.sql
--   contract_period_amounts        → 116_regeneration_multi_unit.sql
--   regenerate_contract_invoices   → 116_regeneration_multi_unit.sql
--   save_contract_with_units       → 117_save_contract_with_units.sql

-- ---------------------------------------------------------------------------
-- I1 (IMPORTANT). occupies_unit must be unforgeable, not merely underived.
-- ---------------------------------------------------------------------------
-- `occupies_unit` is not a business field. It exists only to carry the
-- double-booking uniqueness predicate into contract_units, because a Postgres
-- partial-index predicate cannot reference `contracts.state` in another table.
--
-- Migration 110 seeded it with a trigger scoped to
-- `before insert or update OF contract_id`. A plain
-- `update contract_units set occupies_unit = false` therefore never re-derived
-- it, and the row silently left the partial unique index
-- `one_active_contract_per_unit` — after which a second live contract could be
-- inserted on the same unit. 110 grants table-wide UPDATE to `authenticated`,
-- so that is one PostgREST PATCH away for any staff user holding
-- contracts.update. The reviewer produced two live contracts on one unit this
-- way against a real database.
--
-- The fix is to widen the trigger's event scope to every UPDATE, so the column
-- is re-derived from `contracts.state` no matter which column the writer
-- names. The alternative the review offered — `revoke update (occupies_unit)
-- ... from authenticated` — was deliberately NOT taken: a column-level REVOKE
-- does not subtract from the table-level `grant update` that 110 already
-- issued (Postgres warns and moves on), so making it real would mean revoking
-- table UPDATE and enumerating every other column by name, which breaks
-- silently the next time a column is added. The trigger makes the value
-- unforgeable rather than merely ungranted, and it survives a future
-- `grant all`.
--
-- The function body is UNCHANGED — this is trigger DDL only. In particular the
-- predicate below stays `state in ('draft','active','frozen','suspended')`
-- with no `archived_at`: it mirrors the UNIQUENESS predicate (04:179-180),
-- which is deliberately different from the OCCUPANCY predicate in 111
-- (`state = 'active' and archived_at is null`). See 110's comment. Do not make
-- them consistent.
drop trigger if exists trg_contract_units_seed_occupies on public.contract_units;
create trigger trg_contract_units_seed_occupies
  before insert or update on public.contract_units
  for each row execute function public.tg_contract_units_seed_occupies();

-- ---------------------------------------------------------------------------
-- M2. tg_contract_units_sync_total — copied from 110_multi_unit_contracts.sql
-- ---------------------------------------------------------------------------
-- The only edit: an UPDATE that re-parents a row from contract A to contract B
-- used to resolve `coalesce(new.contract_id, old.contract_id)` to B alone, so
-- A's trigger-maintained `monthly_amount` kept the departed unit's rent
-- forever. Both sides are now recomputed. `old` is a NULL record on INSERT and
-- `new` is a NULL record on DELETE, so the corresponding `c.id = <null>`
-- disjunct simply matches nothing — no branch needed.
create or replace function public.tg_contract_units_sync_total()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _new uuid := new.contract_id;
  _old uuid := old.contract_id;
begin
  update public.contracts c
     set monthly_amount = coalesce(
           (select sum(cu.monthly_amount) from public.contract_units cu
             where cu.contract_id = c.id), 0)
   where c.id = _new or c.id = _old;
  return coalesce(new, old);
end;
$$;

revoke execute on function public.tg_contract_units_sync_total() from public, anon;

-- ---------------------------------------------------------------------------
-- M1 (part 1). generate_invoices_for_year — copied from
--              112_consolidated_invoicing.sql
-- ---------------------------------------------------------------------------
-- 110 defaulted `contracts.monthly_amount` to 0 and 118 dropped the NOT NULL
-- `unit_id`, so a bare `insert into public.contracts (...)` now succeeds and
-- leaves a contract with zero `contract_units` rows. This function then sums
-- to a 0 subtotal and writes twelve zero-total invoices a year with no rent
-- lines at all — forever, without erroring. Before this branch the NOT NULL
-- unit_id made that shape impossible.
--
-- The guard follows migration 82's established asymmetry exactly: RAISE on the
-- direct-id path, SKIP on the bulk path. Raising in the bulk loop would abort
-- a whole-portfolio generate (and the nightly cron) because of one malformed
-- contract.
--
-- Two edits, both marked M1 below; every other line — the permission guard,
-- the year-range check, the archived-contract raise, `c.archived_at is null`
-- in the loop predicate, the free-months skip, the single-unit-or-null
-- `invoices.unit_id`, the per-unit rent-line loop, the concession maths and
-- the `on conflict ... do nothing` idempotency — is byte-identical to 112.
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
    -- M1: a unit-less contract prices to 0 and would bill empty invoices
    -- forever. `v_contract.id is not null` keeps the pre-existing behaviour
    -- for an id that matches no contract at all (zero rows, no raise).
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
      -- M1: skip, never raise, on the bulk path — one malformed contract must
      -- not abort a whole-portfolio generate. The direct-id path raised above.
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

revoke execute on function public.generate_invoices_for_year(uuid, integer, boolean)
  from public, anon;
grant execute on function public.generate_invoices_for_year(uuid, integer, boolean)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- M1 (part 2). contract_period_amounts — copied from
--              116_regeneration_multi_unit.sql
-- ---------------------------------------------------------------------------
-- The only edit: the same unit-less-contract guard. This helper has no bulk
-- path — every caller passes one contract id — so it always raises. Its
-- `coalesce(sum(...), 0)` otherwise reports a 0 subtotal for a contract that
-- was never priced at all, which is indistinguishable from a genuinely free
-- period. Concession ordering (percentage before fixed, migration 37) and the
-- OUT-parameter assignment are untouched.
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

  -- M1: never price a unit-less contract as if it were worth zero.
  if not exists (
    select 1 from public.contract_units cu where cu.contract_id = v_contract.id
  ) then
    raise exception 'Contract % has no units and cannot be priced. Add at least one unit first.',
      v_contract.code using errcode = 'check_violation';
  end if;

  select coalesce(sum(cu.monthly_amount), 0) into v_subtotal
    from public.contract_units cu where cu.contract_id = v_contract.id;
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

revoke execute on function public.contract_period_amounts(uuid, date) from public, anon;
grant execute on function public.contract_period_amounts(uuid, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- I2 (IMPORTANT). regenerate_contract_invoices — copied from
--                 116_regeneration_multi_unit.sql
-- ---------------------------------------------------------------------------
-- The only edit: the "unpaid, should exist" UPDATE now refreshes
-- `invoices.unit_id` alongside subtotal/discount/total/due_date, using the
-- single-unit-or-null expression already used verbatim in 112 and 114.
--
-- Why it matters: 112 sets `invoices.unit_id` only on INSERT, and its
-- `on conflict ... do nothing` means an existing invoice is never revisited —
-- so the column froze for the life of the invoice while the rent lines beneath
-- it were rebuilt on every regeneration. The transition this feature makes
-- possible for the first time is 1 → N: an operator adds a second unit to a
-- single-unit contract and regenerates, and the invoice keeps a non-NULL
-- unit_id naming unit A while now carrying rent lines for A and B. That
-- violates Decision 5 of the design, and `set_invoice_paid` (108:165-168) then
-- copies `v_invoice.unit_id` into `payments.unit_id`, stamping a consolidated
-- payment as belonging to one of the two units. The N → 1 case is the mirror:
-- the column stayed NULL when it should now name the single remaining unit.
--
-- Every guard is otherwise unchanged: the permission check, the
-- archived-contract raise, the "settled money is sacred" skip, the
-- terminal-state skip, the should_exist window with no current-month horizon
-- (migration 94), the unpaid-only delete/cancel branch, the per-unit rent-line
-- loop (112's shape), the concession loop seeded from v_amounts.subtotal, and
-- Pass 2's delegation to generate_invoices_for_year.
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
  v_item_total numeric(14,3);
  v_concession public.concessions%rowtype;
  v_concession_amount numeric(14,3);
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

    -----------------------------------------------------------------------
    -- Settled money is sacred: never delete, cancel, or overwrite amounts.
    -- Applies to past and future periods alike (early pay of a future month).
    -----------------------------------------------------------------------
    if coalesce(v_invoice.paid, 0) > 0
      or v_invoice.state in ('paid', 'partially_paid') then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    -- Already terminal without balance: leave alone.
    if v_invoice.state in ('cancelled', 'waived') then
      id := v_invoice.id; code := v_invoice.code;
      period_year := v_invoice.period_year; period_month := v_invoice.period_month;
      total := v_invoice.total; state := v_invoice.state::text; action := 'skipped';
      return next;
      continue;
    end if;

    -- Contract range + free-months. No current-month horizon (migration 94).
    v_should_exist :=
      v_period_start >= date_trunc('month', v_contract.start_date)::date
      and v_period_start <= date_trunc('month', v_contract.end_date)::date
      and not public.period_in_free_months(p_contract_id, v_period_start);

    if v_should_exist then
      -- Unpaid only (paid already skipped above): rewrite amounts/items.
      select * into v_amounts
        from public.contract_period_amounts(p_contract_id, v_period_start);

      update public.invoices i
         set subtotal = v_amounts.subtotal,
             discount = v_amounts.discount,
             total = v_amounts.total,
             -- I2: single-unit-or-null, re-derived on every regeneration.
             -- Same expression as 112's INSERT and 114's close-out rows.
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
      -- Period no longer on the contract (or free-months). Unpaid only.
      if v_invoice.state in ('due', 'overdue')
        and not exists (
          select 1 from public.payment_allocations pa where pa.invoice_id = v_invoice.id
        )
        and not public.invoice_has_pending_request(v_invoice.id)
      then
        delete from public.invoice_items where invoice_id = v_invoice.id;
        delete from public.invoices as i where i.id = v_invoice.id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'deleted'; action := 'deleted';
        return next;
      else
        -- Live payment link (or other unpaid protection): cancel, do not destroy.
        update public.invoices as i set state = 'cancelled' where i.id = v_invoice.id;
        id := v_invoice.id; code := v_invoice.code;
        period_year := v_invoice.period_year; period_month := v_invoice.period_month;
        total := v_invoice.total; state := 'cancelled'; action := 'cancelled';
        return next;
      end if;
    end if;
  end loop;

  -- Pass 2: missing periods through current month only (include_past skips future).
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
-- I3 + M6. save_contract_with_units — copied from
--          117_save_contract_with_units.sql
-- ---------------------------------------------------------------------------
-- Two edits:
--
-- I3 (IMPORTANT): both branches gated on `contracts.update`, so a user holding
-- update but not create could create contracts. The function is SECURITY
-- DEFINER, so the `contracts_insert_permitted` RLS policy (04:269-284) never
-- runs as a backstop, and the client-side split in useContracts.ts is a UI
-- nicety — this RPC is directly callable over PostgREST by any authenticated
-- user. The permission required now follows the branch actually taken.
--
-- M6: the prune's `unit_id not in (select (u->>'unit_id')::uuid ...)` evaluated
-- to NULL for every row if any element of p_units lacked a `unit_id`, so
-- nothing was pruned; the subsequent insert then failed the NOT NULL and the
-- caller saw a misleading error about a column it never named. Now the payload
-- shape is validated up front with a message that says what is wrong, and the
-- prune is a `not exists (...)` that is NULL-safe by construction.
--
-- Everything else — the explicit insert column list (correction 1 in 117), the
-- `end_date_override_reason` direct assignment on update (correction 3), the
-- zero-units raise, the line_order numbering from 1, and the revoke-before-
-- grant (correction 2) — is unchanged.
create or replace function public.save_contract_with_units(
  p_contract jsonb,
  p_units jsonb,
  p_contract_id uuid default null
)
returns public.contracts
language plpgsql security definer set search_path = public
as $$
declare
  v_contract public.contracts;
  v_unit jsonb;
  v_line integer := 1;
begin
  -- I3: create and update are separate permissions. Do not collapse these.
  if not public.has_permission(
       auth.uid(),
       case when p_contract_id is null then 'contracts.create' else 'contracts.update' end
     ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if jsonb_array_length(p_units) = 0 then
    raise exception 'A contract must have at least one unit';
  end if;
  -- M6: reject a malformed payload here, where the message can name the real
  -- problem, rather than letting a NULL poison the prune below.
  if exists (
    select 1 from jsonb_array_elements(p_units) u
     where nullif(u->>'unit_id', '') is null
  ) then
    raise exception 'Every unit entry must carry a unit_id';
  end if;

  if p_contract_id is null then
    -- Explicit column list, NOT `select * from jsonb_populate_record(...)`:
    -- that yields NULL for every omitted key including `id` and `code`,
    -- overriding their defaults.
    insert into public.contracts
      (tenant_id, type, state, commercial_activity, start_date, end_date,
       duration_months, end_date_override_reason, due_day, grace_days,
       deposit, notes)
    values (
      (p_contract->>'tenant_id')::uuid,
      coalesce((p_contract->>'type')::public.contract_types, 'investment'),
      coalesce((p_contract->>'state')::public.contract_states, 'draft'),
      p_contract->>'commercial_activity',
      (p_contract->>'start_date')::date,
      (p_contract->>'end_date')::date,
      (p_contract->>'duration_months')::integer,
      p_contract->>'end_date_override_reason',
      coalesce((p_contract->>'due_day')::integer, 1),
      coalesce((p_contract->>'grace_days')::integer, 0),
      coalesce((p_contract->>'deposit')::numeric, 0),
      p_contract->>'notes'
    )
    returning * into v_contract;
  else
    update public.contracts c set
      tenant_id = coalesce((p_contract->>'tenant_id')::uuid, c.tenant_id),
      type = coalesce((p_contract->>'type')::public.contract_types, c.type),
      state = coalesce((p_contract->>'state')::public.contract_states, c.state),
      commercial_activity = p_contract->>'commercial_activity',
      start_date = coalesce((p_contract->>'start_date')::date, c.start_date),
      end_date = coalesce((p_contract->>'end_date')::date, c.end_date),
      duration_months = (p_contract->>'duration_months')::integer,
      end_date_override_reason = p_contract->>'end_date_override_reason',
      due_day = coalesce((p_contract->>'due_day')::integer, c.due_day),
      grace_days = coalesce((p_contract->>'grace_days')::integer, c.grace_days),
      deposit = coalesce((p_contract->>'deposit')::numeric, c.deposit),
      notes = p_contract->>'notes'
     where c.id = p_contract_id
     returning * into v_contract;
    if not found then raise exception 'Contract not found'; end if;
    -- M6: `not exists`, not `not in` — a NULL anywhere in the subquery would
    -- make `not in` NULL for every row and prune nothing at all.
    delete from public.contract_units cu
     where cu.contract_id = v_contract.id
       and not exists (
         select 1 from jsonb_array_elements(p_units) u
          where (u->>'unit_id')::uuid = cu.unit_id
       );
  end if;

  for v_unit in select * from jsonb_array_elements(p_units) loop
    insert into public.contract_units (contract_id, unit_id, monthly_amount, line_order)
    values (v_contract.id, (v_unit->>'unit_id')::uuid, (v_unit->>'monthly_amount')::numeric, v_line)
    on conflict (contract_id, unit_id)
      do update set monthly_amount = excluded.monthly_amount, line_order = excluded.line_order;
    v_line := v_line + 1;
  end loop;

  select * into v_contract from public.contracts where id = v_contract.id;
  return v_contract;
end;
$$;

-- REVOKE FIRST — see 117's correction 2.
revoke execute on function public.save_contract_with_units(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.save_contract_with_units(jsonb, jsonb, uuid) to authenticated;
