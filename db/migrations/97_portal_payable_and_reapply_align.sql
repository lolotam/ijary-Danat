-- 97_portal_payable_and_reapply_align.sql
--
-- Two related clean-ups that share a theme: stop inventing constraints the
-- product no longer wants.
--
-- A. evaluate_portal_payable_invoices — drop the dead max-visible parameter.
--    Migration 94 kept p_company_max_visible for call-site compatibility but
--    stopped using it to cap the result set. The admin UI still offered the
--    setting; nothing happened. Showing every unpaid tenant-visible invoice is
--    the intended behaviour. companies.max_visible_unpaid_invoices is NOT
--    dropped (irreversible; the stored value may still carry meaning for
--    whoever set it) — only its use is removed.
--
--    *** THIS CHANGES THE FUNCTION SIGNATURE, SO THE OLD FORM MUST DROP FIRST. ***
--    A function's identity is (name, argument types). `create or replace` on the
--    1-arg form does NOT replace the 2-arg form from migrations 06/94 — it would
--    create an overload and leave the old body (with its dead parameter) live
--    serving every existing call. This is the migration-90 case (drop required),
--    not the migration-82 case (body-only re-issue, no drop).
--
-- B. reapply_contract_invoices — align with regenerate on future months.
--    Resulting contract: both reapply and regenerate preserve in-term future
--    unpaid invoices and neither creates them; forward months are created only
--    by an explicit admin Generate.
--
--    reapply previously deleted every unpaid due/overdue row (including future
--    periods), backfilled through today, then looped generate_invoices_for_year
--    through contract end — which materialised every remaining month and
--    inflated outstanding A/R. Now the delete is capped at the current month and
--    the forward-year loop is gone. The archived-contract guard stays BEFORE the
--    delete (migration 82 ordering).
--
-- Grant hygiene (migration 96 lesson): every revoke names both public and anon.
-- `from public` alone misses an explicit anon grant; `from anon` alone misses a
-- PUBLIC grant.

-- ---------------------------------------------------------------------------
-- 1. evaluate_portal_payable_invoices — 1-arg form (signature change)
-- ---------------------------------------------------------------------------
drop function if exists public.evaluate_portal_payable_invoices(uuid, integer);

create or replace function public.evaluate_portal_payable_invoices(
  p_tenant_id uuid
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

revoke execute on function public.evaluate_portal_payable_invoices(uuid)
  from public, anon;
grant execute on function public.evaluate_portal_payable_invoices(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. reapply_contract_invoices — preserve future unpaid; never create them
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

  -- Only current-and-past periods: future unpaid rows are preserved (no restore
  -- loop below — that would re-materialise every month through contract end).
  delete from public.invoices i
  where i.contract_id = p_contract_id
    and coalesce(i.paid, 0) = 0
    and i.state in ('due', 'overdue')
    and not exists (
      select 1 from public.payment_allocations pa where pa.invoice_id = i.id
    )
    and make_date(i.period_year, i.period_month, 1)
          <= date_trunc('month', current_date)::date;

  return query
    select * from public.backfill_contract_invoices(p_contract_id);
end;
$$;

revoke execute on function public.reapply_contract_invoices(uuid)
  from public, anon;
grant execute on function public.reapply_contract_invoices(uuid)
  to authenticated, service_role;
