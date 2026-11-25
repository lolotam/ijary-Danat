-- 121_portal_payable_by_contract.sql
--
-- evaluate_portal_payable_invoices gains an optional p_contract_id so the
-- tenant portal can show, and gate payment on, one contract at a time.
--
-- *** SIGNATURE CHANGE — THE OLD FORM MUST DROP FIRST. ***
-- A function's identity is (name, argument types). `create or replace` with a
-- new argument list creates an OVERLOAD and leaves migration 97's 1-arg body
-- live, still serving every existing call. Same case as migration 97 itself.
--
-- Why the filter is in SQL and not in the client: sequence_order and
-- is_selectable implement pay-oldest-first, and portal.invoices.tsx enforces a
-- prefix rule over the returned rows. Filtering the array client-side would
-- keep tenant-wide ordering while applying the prefix rule to a subset, which
-- lets a tenant pay contract B's May while contract A's January is unpaid.
-- That is a silent change to a money path.
--
-- Body copied from db/migrations/97_portal_payable_and_reapply_align.sql
-- section 1 (the highest-numbered, therefore live, definition).
--
-- Wrapped in an explicit transaction: the drop and the create are one atomic
-- replacement of a money-path function. Applied with `psql -v ON_ERROR_STOP=1`,
-- an unwrapped failure in the create or in either grant would commit the drop
-- and leave production with NO evaluate_portal_payable_invoices at all — the
-- portal's invoice list and every gateway payment would 404 until someone
-- noticed. DDL is transactional in Postgres; there is no reason not to.
--
-- Archived contracts are deliberately NOT filtered here. Excluding them would
-- change which invoices are payable, and this migration must not alter the
-- payable set — only how it is grouped. The switcher already omits archived
-- contracts and the selection hook clears an archived id from the URL, so a
-- tenant cannot reach one; an admin's tenant-wide (p_contract_id is null) view
-- keeps returning exactly what it returns today.

begin;

drop function if exists public.evaluate_portal_payable_invoices(uuid);

create or replace function public.evaluate_portal_payable_invoices(
  p_tenant_id uuid,
  p_contract_id uuid default null
)
returns table (
  invoice_id uuid,
  period_year integer,
  period_month integer,
  total numeric,
  paid numeric,
  balance numeric,
  state text,
  is_overdue boolean,
  sequence_order integer,
  is_selectable boolean,
  lock_reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_tenant_id is null then
    raise exception 'Tenant is required';
  end if;

  -- Auth guard: re-stated verbatim from migration 97. Adding a parameter must
  -- not widen who may call this.
  if auth.role() = 'authenticated' and not (
    public.is_staff(auth.uid()) or (
      public.has_role(auth.uid(), 'tenant') and exists (
        select 1
        from public.profiles p
        where p.id = auth.uid() and p.tenant_id = p_tenant_id
      )
    )
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'Tenant not found';
  end if;

  -- A contract id from another tenant raises rather than quietly returning
  -- nothing: silence would read to the caller as "this contract has no
  -- invoices", which is a different and misleading answer.
  if p_contract_id is not null and not exists (
    select 1 from public.contracts c
    where c.id = p_contract_id and c.tenant_id = p_tenant_id
  ) then
    raise exception 'Contract does not belong to this tenant'
      using errcode = '42501';
  end if;

  return query
  with payable as (
    select
      i.id,
      i.period_year,
      i.period_month,
      i.total,
      i.paid,
      i.balance,
      i.state::text,
      (i.state = 'overdue' or (i.due_date + coalesce(c.grace_days, 0)) < current_date) as overdue,
      row_number() over (
        order by i.period_year, i.period_month, i.due_date, i.id
      )::integer as seq
    from public.invoices i
    left join public.contracts c on c.id = i.contract_id
    where i.tenant_id = p_tenant_id
      and i.state in ('due', 'overdue', 'partially_paid')
      and i.balance > 0
      and i.is_visible_to_tenant
      and (p_contract_id is null or i.contract_id = p_contract_id)
  ), ordered as (
    select
      p.*,
      first_value(p.period_month) over (order by p.seq) as blocking_month,
      first_value(p.period_year) over (order by p.seq) as blocking_year
    from payable p
  )
  select
    o.id,
    o.period_year,
    o.period_month,
    o.total,
    o.paid,
    o.balance,
    o.state,
    o.overdue,
    o.seq,
    o.seq = 1,
    case
      when o.seq = 1 then null
      else 'ادفع فاتورة شهر '
        || lpad(o.blocking_month::text, 2, '0') || '/' || o.blocking_year::text
        || ' أولًا / Pay month '
        || lpad(o.blocking_month::text, 2, '0') || '/' || o.blocking_year::text
        || ' first'
    end
  from ordered o
  order by o.seq;
end;
$$;

-- Migration 96's lesson: `from public` alone misses an explicit anon grant and
-- `from anon` alone misses a PUBLIC grant. Name both.
revoke all on function public.evaluate_portal_payable_invoices(uuid, uuid) from public, anon;
grant execute on function public.evaluate_portal_payable_invoices(uuid, uuid)
  to authenticated, service_role;

commit;
