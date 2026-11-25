-- 85_refunds_reversal.sql
--
-- Refund lifecycle: human-readable codes, status machine, reverse (mirror row),
-- void (no mirror), and a narrow delete policy so a POSTED refund cannot be
-- hard-deleted. That last piece is the fix for the production incident where a
-- posted refund was deleted and orphaned an archived contract — hiding the UI
-- button is not sufficient; RLS is the boundary.
--
-- Reversal model mirrors reverse_payment (migration 05): the original row is
-- never mutated in value and never deleted; a POSITIVE mirror is inserted with
-- status='reversed' and a FK back to the original. Negatives are impossible
-- because of the amount > 0 CHECK. Reversal is modelled by status + link, not
-- by sign.
--
-- CRITICAL: get_budget_summary and get_payments_summary both sum refunds with
-- no status filter today. A reversed refund plus its positive mirror would
-- report as two outflows. Both aggregates are re-issued here with the posted-
-- and-not-a-mirror predicate so net stays correct.

------------------------------------------------------------
-- 1. Code generator (04:32-52 pattern; revoke names anon explicitly — 78)
------------------------------------------------------------

create sequence if not exists public.refund_code_seq;

create or replace function public.next_refund_code()
returns text
language sql
security definer
set search_path = public
as $$ select 'REF-' || lpad(nextval('public.refund_code_seq')::text, 7, '0') $$;

-- Named explicitly: `revoke ... from public` does NOT reach anon (migration 78).
revoke all on function public.next_refund_code() from public, anon;
grant execute on function public.next_refund_code() to authenticated, service_role;

------------------------------------------------------------
-- 2. Columns on public.refunds
------------------------------------------------------------

alter table public.refunds
  add column if not exists code text;

alter table public.refunds
  add column if not exists status text;

-- Default 'posted' for the backfill is deliberate: every existing row has
-- already been counted into get_budget_summary's `refunds` figure for a closed
-- period. Defaulting them to 'draft' would silently rewrite past months.
update public.refunds set status = 'posted' where status is null;

alter table public.refunds
  alter column status set default 'posted';

alter table public.refunds
  alter column status set not null;

do $$ begin
  alter table public.refunds
    add constraint refunds_status_check
    check (status in ('draft', 'posted', 'voided', 'reversed'));
exception when duplicate_object then null;
end $$;

alter table public.refunds
  add column if not exists reversal_of_id uuid references public.refunds(id) on delete set null;

alter table public.refunds
  add column if not exists voided_at timestamptz;

alter table public.refunds
  add column if not exists voided_by uuid references auth.users(id) on delete set null;

alter table public.refunds
  add column if not exists void_reason text;

do $$ begin
  alter table public.refunds
    add constraint refunds_void_needs_reason
    check (voided_at is null or nullif(trim(void_reason), '') is not null);
exception when duplicate_object then null;
end $$;

-- Backfill codes in CHRONOLOGICAL order, not heap order. Whole block is
-- idempotent: a re-run assigns nothing (where code is null).
update public.refunds r
   set code = s.new_code
  from (
    select id,
           'REF-' || lpad(row_number() over (order by created_at, id)::text, 7, '0') as new_code
      from public.refunds
     where code is null
  ) s
 where r.id = s.id;

-- Advance the sequence past the highest assigned number so the next generated
-- code does not collide with a backfilled one.
do $$
declare
  v_max bigint;
begin
  select coalesce(
    max(substring(code from 5)::bigint),
    0
  )
    into v_max
  from public.refunds
  where code ~ '^REF-[0-9]+$';

  if v_max > 0 then
    perform setval('public.refund_code_seq', v_max, true);
  end if;
end $$;

alter table public.refunds
  alter column code set not null;

alter table public.refunds
  alter column code set default public.next_refund_code();

create unique index if not exists refunds_code_uidx on public.refunds (code);
create index if not exists refunds_status_idx on public.refunds (status);
create index if not exists refunds_reversal_of_id_idx on public.refunds (reversal_of_id);

comment on column public.refunds.status is
  'draft | posted | voided | reversed. Existing rows default to posted so historical budget figures are not rewritten. Reversal uses a positive mirror row (see reverse_refund); void does not create a mirror.';

comment on column public.refunds.reversal_of_id is
  'Set only on the POSITIVE mirror row created by reverse_refund. The original keeps this null and flips status to reversed.';

------------------------------------------------------------
-- 3. reverse_refund — mirror pattern from reverse_payment (05:597-673)
------------------------------------------------------------

create or replace function public.reverse_refund(p_refund_id uuid, p_reason text)
returns table (reversal_refund_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original public.refunds%rowtype;
  v_reversal_id uuid;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'refunds.reverse') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A reversal reason is required';
  end if;

  select r.* into v_original
  from public.refunds r where r.id = p_refund_id
  for update;
  if not found then raise exception 'Refund not found'; end if;
  if v_original.status <> 'posted' or v_original.reversal_of_id is not null then
    raise exception 'Only an unreversed posted refund can be reversed';
  end if;
  if exists (
    select 1 from public.refunds r
    where r.reversal_of_id = v_original.id and r.status = 'reversed'
  ) then
    raise exception 'Refund has already been reversed';
  end if;

  -- POSITIVE mirror: same amount. Negatives are impossible (amount > 0 CHECK).
  -- Reversal is status + link, not sign — same model as reverse_payment.
  insert into public.refunds (
    code, company_id, contract_id, tenant_id, unit_id, building_id,
    amount, currency, refund_date, reason, post_action, note, created_by,
    status, reversal_of_id
  ) values (
    public.next_refund_code(), v_original.company_id, v_original.contract_id,
    v_original.tenant_id, v_original.unit_id, v_original.building_id,
    v_original.amount, v_original.currency, current_date, trim(p_reason),
    v_original.post_action, v_original.note, auth.uid(),
    'reversed', v_original.id
  ) returning id into v_reversal_id;

  update public.refunds r set status = 'reversed' where r.id = v_original.id;

  perform public.write_audit(
    'refund.reverse',
    'refund',
    v_original.id,
    to_jsonb(v_original),
    jsonb_build_object('reversal_id', v_reversal_id),
    'success',
    null
  );

  if v_original.contract_id is not null then
    insert into public.contract_operational_events (
      contract_id, tenant_id, event_type, actor_id, payload, note
    ) values (
      v_original.contract_id,
      v_original.tenant_id,
      'refund_reversed',
      auth.uid(),
      jsonb_build_object(
        'refund_id', v_original.id,
        'reversal_id', v_reversal_id,
        'amount', v_original.amount
      ),
      trim(p_reason)
    );
  end if;

  reversal_refund_id := v_reversal_id;
  return next;
end;
$$;

revoke all on function public.reverse_refund(uuid, text) from public, anon;
grant execute on function public.reverse_refund(uuid, text) to authenticated, service_role;

------------------------------------------------------------
-- 4. void_refund — no mirror; asserts the refund should never have existed
------------------------------------------------------------

-- Void does NOT restore or un-archive anything. Restoring a contract is a
-- separate explicit operation (contracts.restore). A void only flips the refund
-- row to status='voided' so it drops out of aggregates and stays in history.

create or replace function public.void_refund(p_refund_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original public.refunds%rowtype;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'refunds.void') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A void reason is required';
  end if;

  select r.* into v_original
  from public.refunds r where r.id = p_refund_id
  for update;
  if not found then raise exception 'Refund not found'; end if;
  if v_original.status <> 'posted' then
    raise exception 'Only a posted refund can be voided';
  end if;

  update public.refunds r
     set status = 'voided',
         voided_at = now(),
         voided_by = auth.uid(),
         void_reason = trim(p_reason)
   where r.id = v_original.id;

  perform public.write_audit(
    'refund.void',
    'refund',
    v_original.id,
    to_jsonb(v_original),
    jsonb_build_object(
      'status', 'voided',
      'void_reason', trim(p_reason)
    ),
    'success',
    null
  );

  if v_original.contract_id is not null then
    insert into public.contract_operational_events (
      contract_id, tenant_id, event_type, actor_id, payload, note
    ) values (
      v_original.contract_id,
      v_original.tenant_id,
      'refund_voided',
      auth.uid(),
      jsonb_build_object(
        'refund_id', v_original.id,
        'amount', v_original.amount
      ),
      trim(p_reason)
    );
  end if;
end;
$$;

revoke all on function public.void_refund(uuid, text) from public, anon;
grant execute on function public.void_refund(uuid, text) to authenticated, service_role;

------------------------------------------------------------
-- 5. Narrow delete policy — posted refunds are not hard-deletable
------------------------------------------------------------

-- Fix for the production incident: a posted refund was deleted and orphaned an
-- archived contract. Hiding the UI button is not sufficient; RLS is the boundary.
drop policy if exists refunds_delete_permitted on public.refunds;
create policy refunds_delete_permitted on public.refunds
  for delete to authenticated
  using (
    public.has_permission(auth.uid(), 'refunds.delete')
    and status = 'draft'
  );

------------------------------------------------------------
-- 6. Re-issue get_budget_summary (live was 56) with refund status filter
------------------------------------------------------------

-- THIS FILE NOW HOLDS THE LIVE DEFINITION for get_budget_summary. Copied
-- verbatim from migration 56 with ONLY the refund predicate changed:
--   and r.status = 'posted' and r.reversal_of_id is null
-- The original flips to 'reversed' and drops out; the mirror carries
-- reversal_of_id and drops out. Net zero across a reversal pair.

create or replace function public.get_budget_summary(
  p_from date,
  p_to date,
  p_property_id uuid default null,
  p_building_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_collections numeric(14,3);
  v_deposits numeric(14,3);
  v_expenses numeric(14,3);
  v_refunds numeric(14,3);
  v_insurance numeric(14,3);
  v_categories jsonb;
  v_months jsonb;
begin
  if p_to < p_from then raise exception 'Invalid date range'; end if;
  if auth.role() = 'authenticated' and not public.has_permission(auth.uid(), 'reports.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- reverse_payment writes POSITIVE mirror allocations
  -- (05_phase3_invoices_payments.sql:656), so summing allocations would
  -- double-count a reversed payment. Filtering on the payment row is what makes
  -- this correct, and every aggregate below follows the same predicate.
  select coalesce(sum(p.amount), 0) into v_collections
  from public.payments p left join public.units u on u.id = p.unit_id
  where p.status = 'confirmed' and p.reversed_by_payment_id is null
    and p.payment_date between p_from and p_to
    and (p_property_id is null or u.property_id = p_property_id)
    and (p_building_id is null or u.building_id = p_building_id);

  select coalesce(sum(d.amount), 0) into v_deposits from public.deposits d
  where d.status = 'confirmed' and d.deposit_date between p_from and p_to;

  select coalesce(sum(e.amount), 0) into v_expenses
  from public.expenses e left join public.units u on u.id = e.unit_id
  where e.status = 'approved' and e.expense_date between p_from and p_to
    and (p_property_id is null or e.property_id = p_property_id or u.property_id = p_property_id)
    and (p_building_id is null or e.building_id = p_building_id or u.building_id = p_building_id);

  -- reverse_refund writes a POSITIVE mirror; only posted originals count.
  select coalesce(sum(r.amount), 0) into v_refunds
  from public.refunds r left join public.units u on u.id = r.unit_id
  where r.status = 'posted' and r.reversal_of_id is null
    and r.refund_date between p_from and p_to
    and (p_property_id is null or u.property_id = p_property_id)
    and (p_building_id is null or r.building_id = p_building_id or u.building_id = p_building_id);

  select coalesce(sum(ins.amount), 0) into v_insurance
  from public.insurance_payments ins left join public.units u on u.id = ins.unit_id
  where ins.collected_date between p_from and p_to
    and (p_property_id is null or u.property_id = p_property_id)
    and (p_building_id is null or ins.building_id = p_building_id or u.building_id = p_building_id);

  -- public.partial_payments is deliberately absent from every aggregate here.

  select coalesce(jsonb_agg(jsonb_build_object('category_id', x.category_id, 'code', x.code,
    'name_ar', x.name_ar, 'name_en', x.name_en, 'amount', x.amount) order by x.amount desc), '[]'::jsonb)
  into v_categories from (
    select e.category_id, coalesce(c.code, 'uncategorized') code,
      coalesce(c.name_ar, 'غير مصنف') name_ar, coalesce(c.name_en, 'Uncategorized') name_en,
      sum(e.amount)::numeric(14,3) amount
    from public.expenses e left join public.expense_categories c on c.id = e.category_id
    left join public.units u on u.id = e.unit_id
    where e.status = 'approved' and e.expense_date between p_from and p_to
      and (p_property_id is null or e.property_id = p_property_id or u.property_id = p_property_id)
      and (p_building_id is null or e.building_id = p_building_id or u.building_id = p_building_id)
    group by e.category_id, c.code, c.name_ar, c.name_en
  ) x;

  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month_start, 'YYYY-MM'),
    'collections', coalesce(p.total, 0), 'expenses', coalesce(e.total, 0)) order by m.month_start), '[]'::jsonb)
  into v_months
  from generate_series(date_trunc('month', p_from)::date, date_trunc('month', p_to)::date, interval '1 month') m(month_start)
  left join lateral (
    select sum(pm.amount)::numeric(14,3) total from public.payments pm
    left join public.units u on u.id = pm.unit_id
    where pm.status = 'confirmed' and pm.reversed_by_payment_id is null
      and pm.payment_date >= m.month_start and pm.payment_date < m.month_start + interval '1 month'
      and pm.payment_date between p_from and p_to
      and (p_property_id is null or u.property_id = p_property_id)
      and (p_building_id is null or u.building_id = p_building_id)
  ) p on true
  left join lateral (
    select sum(ex.amount)::numeric(14,3) total from public.expenses ex
    left join public.units u on u.id = ex.unit_id
    where ex.status = 'approved'
      and ex.expense_date >= m.month_start and ex.expense_date < m.month_start + interval '1 month'
      and ex.expense_date between p_from and p_to
      and (p_property_id is null or ex.property_id = p_property_id or u.property_id = p_property_id)
      and (p_building_id is null or ex.building_id = p_building_id or u.building_id = p_building_id)
  ) e on true;

  return jsonb_build_object(
    'collections', v_collections,
    'deposits', v_deposits,
    'expenses', v_expenses,
    'refunds', v_refunds,
    'insurance_collected', v_insurance,
    'net', v_collections - v_expenses - v_refunds,
    'categories', v_categories,
    'months', v_months
  );
end;
$$;

-- Preserve the revoke/grant lines from the live definition in migration 56.
revoke all on function public.get_budget_summary(date, date, uuid, uuid) from public;
grant execute on function public.get_budget_summary(date, date, uuid, uuid)
  to authenticated, service_role;

------------------------------------------------------------
-- 7. Re-issue get_payments_summary (live was 79) with refund status filter
------------------------------------------------------------

-- THIS FILE NOW HOLDS THE LIVE DEFINITION for get_payments_summary. Copied
-- verbatim from migration 79 with ONLY the refund predicate changed:
--   and x.status = 'posted' and x.reversal_of_id is null

create or replace function public.get_payments_summary(
  p_search text default null,
  p_method text default null,
  p_status text default null,
  p_tenant_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_full_total numeric(14,3); v_full_count bigint;
  v_partial_total numeric(14,3); v_partial_count bigint;
  v_insurance_total numeric(14,3); v_insurance_count bigint;
  v_refund_total numeric(14,3); v_refund_count bigint;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'payments.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- Same predicate get_budget_summary uses for `collections`, so this card and
  -- the budget report cannot disagree.
  select coalesce(sum(p.amount), 0), count(*)
    into v_full_total, v_full_count
  from public.payments p
  where p.status = 'confirmed'
    and p.reversed_by_payment_id is null
    and (p_method is null or p.method::text = p_method)
    and (p_status is null or p.status::text = p_status)
    and (p_tenant_id is null or p.tenant_id = p_tenant_id)
    and (p_search is null or p.code ilike '%' || p_search || '%'
      or coalesce(p.reference, '') ilike '%' || p_search || '%'
      or exists (
        select 1 from public.tenants t
        where t.id = p.tenant_id
          and (t.code ilike '%' || p_search || '%' or t.name ilike '%' || p_search || '%')
      ));

  -- partial_payments / insurance_payments are plain ledgers: no status column
  -- usable as a payments filter, so only p_tenant_id is expressible against them.
  select coalesce(sum(x.amount), 0), count(*) into v_partial_total, v_partial_count
  from public.partial_payments x
  where (p_tenant_id is null or x.tenant_id = p_tenant_id);

  select coalesce(sum(x.amount), 0), count(*) into v_insurance_total, v_insurance_count
  from public.insurance_payments x
  where (p_tenant_id is null or x.tenant_id = p_tenant_id);

  -- reverse_refund writes a POSITIVE mirror; only posted originals count.
  select coalesce(sum(x.amount), 0), count(*) into v_refund_total, v_refund_count
  from public.refunds x
  where x.status = 'posted' and x.reversal_of_id is null
    and (p_tenant_id is null or x.tenant_id = p_tenant_id);

  return jsonb_build_object(
    'full',      jsonb_build_object('total', v_full_total,      'count', v_full_count),
    'partial',   jsonb_build_object('total', v_partial_total,   'count', v_partial_count),
    'insurance', jsonb_build_object('total', v_insurance_total, 'count', v_insurance_count),
    'refunds',   jsonb_build_object('total', v_refund_total,    'count', v_refund_count),
    -- Insurance is a holding, not income — it does not move net. Same rule as
    -- BudgetSummary (src/hooks/useBudget.ts).
    'net', v_full_total + v_partial_total - v_refund_total
  );
end;
$$;

-- Preserve the revoke/grant lines from the live definition in migration 79.
revoke all on function public.get_payments_summary(text, text, text, uuid) from public, anon;
grant execute on function public.get_payments_summary(text, text, text, uuid)
  to authenticated, service_role;

------------------------------------------------------------
-- 8. Verification — data-independent CHECK invariants (style of 84)
------------------------------------------------------------

do $$
declare
  _bad integer;
begin
  -- Every refund must have a code after backfill.
  select count(*) into _bad
    from public.refunds
   where code is null or nullif(trim(code), '') is null;
  if _bad > 0 then
    raise exception
      'refunds.code missing for % row(s)', _bad;
  end if;

  -- A status='reversed' row must either BE a mirror (reversal_of_id set) or
  -- HAVE a mirror pointing at it. Orphans mean a half-applied reverse.
  select count(*) into _bad
    from public.refunds r
   where r.status = 'reversed'
     and r.reversal_of_id is null
     and not exists (
       select 1 from public.refunds m
       where m.reversal_of_id = r.id and m.status = 'reversed'
     );
  if _bad > 0 then
    raise exception
      'reversed refund without mirror for % row(s)', _bad;
  end if;
end $$;
