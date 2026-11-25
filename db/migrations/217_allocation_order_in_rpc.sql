-- 217_allocation_order_in_rpc.sql
--
-- يفرض "سداد الأقدم أولاً" داخل دالة تخصيص الدفعات نفسها لمن يستدعيها مباشرة.
--
-- Codex review on PR #220 (audit H8). The oldest-first rule was moved from the
-- browser into the user-scoped server fn `applyAllocation`, but
-- `apply_payment_allocation` is granted to `authenticated`, so anyone holding
-- `payments.create` could call it straight through PostgREST and settle a
-- newer month while an older one on the same contract stayed open — skipping
-- the check entirely.
--
-- The rule was kept out of SQL on purpose, because the MyFatoorah webhook and
-- the reconcile cron call this RPC too, and raising there would strand gateway
-- money mid-webhook. Both run as `service_role`, so the check applies to
-- `auth.role() = 'authenticated'` only — the same idiom this function already
-- uses for its permission check. The TypeScript check stays: it runs first and
-- gives the caller the nicer error; this one is the guarantee.
--
-- Body is migration 213's, copied verbatim, with one new block marked in
-- place. No signature change, so no drop; grants and comment are re-issued.

begin;

create or replace function public.apply_payment_allocation(
  p_payment_id uuid,
  p_allocations jsonb
)
returns table (invoice_id uuid, applied numeric, new_state text)
language plpgsql security definer set search_path = public
as $apply_payment_allocation$
declare
  v_payment public.payments%rowtype;
  v_allocation record;
  v_invoice public.invoices%rowtype;
  v_allocated numeric(14,3);
  v_requested numeric(14,3);
  v_new_paid numeric(14,3);
  v_new_state public.invoice_states;
  v_grace_days integer;
  v_blocked_code text;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'payments.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Allocations must be a non-empty JSON array';
  end if;

  select p.* into v_payment
  from public.payments p where p.id = p_payment_id
  for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_payment.status <> 'confirmed' then
    raise exception 'Only confirmed payments can be allocated';
  end if;

  if exists (
    select 1 from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
    where x.invoice_id is null or x.amount is null or x.amount <= 0
  ) then
    raise exception 'Every allocation requires an invoice and a positive amount';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
    group by x.invoice_id having count(*) > 1
  ) then
    raise exception 'Duplicate invoice allocation';
  end if;

  select coalesce(sum(pa.amount), 0) into v_allocated
  from public.payment_allocations pa where pa.payment_id = p_payment_id;
  select coalesce(sum(x.amount), 0) into v_requested
  from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric);
  if v_allocated + v_requested > v_payment.amount then
    raise exception 'Allocations exceed the remaining payment amount';
  end if;

  -- Migration 217: settle the oldest first, for DIRECT callers only.
  --
  -- `auth.role() = 'authenticated'` is a person with a session — the admin
  -- screen through `applyAllocation`, or anyone calling this RPC straight
  -- through PostgREST. `service_role` (the MyFatoorah webhook, the reconcile
  -- cron) is deliberately exempt: the gateway has already taken the tenant's
  -- money, and raising here would strand it mid-webhook with nothing booked.
  --
  -- Same rule as `findOutOfOrderAllocation` in lib/invoiceSettlement.ts and
  -- migration 129: per contract, "older" is the (year, month) tuple so a
  -- same-month sibling is a peer, and an older invoice counts as cleared when
  -- THIS call pays its remaining balance, compared in whole fils so float dust
  -- cannot block the next month.
  if auth.role() = 'authenticated' then
    with requested as (
      select x.invoice_id, x.amount
      from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
    )
    select target.code into v_blocked_code
    from public.invoices target
    join requested r on r.invoice_id = target.id
    where exists (
      select 1
      from public.invoices earlier
      left join requested paid_now on paid_now.invoice_id = earlier.id
      where earlier.contract_id = target.contract_id
        and earlier.id <> target.id
        and earlier.state not in ('cancelled', 'waived')
        and round((earlier.balance - coalesce(paid_now.amount, 0)) * 1000) > 0
        and (earlier.period_year, earlier.period_month)
            < (target.period_year, target.period_month)
    )
    order by target.period_year, target.period_month, target.code
    limit 1;
    if v_blocked_code is not null then
      raise exception
        'Settle the oldest open invoice first: an earlier month is still unpaid (invoice %).',
        v_blocked_code;
    end if;
  end if;

  for v_allocation in
    select x.invoice_id, x.amount
    from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
    order by x.invoice_id
  loop
    select i.* into v_invoice
    from public.invoices i where i.id = v_allocation.invoice_id
    for update;
    if not found then raise exception 'Invoice not found'; end if;
    if v_invoice.tenant_id <> v_payment.tenant_id then
      raise exception 'Invoice and payment tenants do not match';
    end if;
    if v_invoice.state in ('cancelled', 'waived') then
      raise exception 'Cancelled or waived invoices cannot receive allocations';
    end if;
    if v_allocation.amount > v_invoice.balance then
      raise exception 'Allocation exceeds invoice balance';
    end if;

    select c.grace_days into v_grace_days
    from public.contracts c where c.id = v_invoice.contract_id;
    v_new_paid := least(v_invoice.total, v_invoice.paid + v_allocation.amount);
    v_new_state := case
      when v_new_paid >= v_invoice.total then 'paid'::public.invoice_states
      when (v_invoice.due_date + coalesce(v_grace_days, 0)) < current_date then 'overdue'::public.invoice_states
      when v_new_paid > 0 then 'partially_paid'::public.invoice_states
      else 'due'::public.invoice_states
    end;

    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (p_payment_id, v_invoice.id, v_allocation.amount);
    update public.invoices i
    set paid = v_new_paid, state = v_new_state
    where i.id = v_invoice.id;

    invoice_id := v_invoice.id;
    applied := v_allocation.amount;
    new_state := v_new_state::text;
    return next;
  end loop;
  update public.receipts r
  set html_snapshot = public.receipt_html_for_payment(p_payment_id)
  where r.payment_id = p_payment_id;

  -- Migration 213's audit row, unchanged.
  perform public.write_audit(
    'allocation.apply',
    'payment',
    p_payment_id,
    null,
    jsonb_build_object('allocations', (
      select coalesce(
        jsonb_agg(jsonb_build_object('invoice_id', x.invoice_id, 'amount', x.amount)),
        '[]'::jsonb
      )
      from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
    ))
  );
end;
$apply_payment_allocation$;

-- Migration 96's lesson, as in 213: name both `public` and `anon`.
revoke all on function public.apply_payment_allocation(uuid, jsonb) from public, anon;
grant execute on function public.apply_payment_allocation(uuid, jsonb)
  to authenticated, service_role;

comment on function public.apply_payment_allocation(uuid, jsonb) is
  'يخصّص دفعة على فواتير المستأجر، ويفرض سداد الأقدم أولاً على المستدعي المباشر، ويكتب صف التدقيق في نفس العملية. Allocates a payment across invoices, enforces oldest-first for authenticated callers (service_role — webhook and reconcile — is exempt so gateway money is never stranded), and writes its own audit row.';

commit;
