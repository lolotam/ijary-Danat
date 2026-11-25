-- 213_money_rpcs_audit_themselves.sql
--
-- كتابة صف التدقيق داخل دالتي عكس الدفعة وتخصيصها، لا في الغلاف فقط.
--
-- Review finding on PR #206. `reversePayment` and `applyAllocation` write their
-- audit row in TypeScript, after the RPC returns. Both RPCs are granted
-- directly to `authenticated` and do their own `has_permission` check, so an
-- authorised user can call either through PostgREST — a browser console, curl,
-- any client holding the anon key and a session — and move the money without
-- the wrapper ever running. The reversal succeeds and the trail stays empty,
-- which is precisely the hole this PR exists to close.
--
-- Same reasoning as `close_out_contract` and `erase_all_data`, which already
-- write their own rows from inside SQL: multi-table money must not commit
-- without its audit row, and the only place that guarantee can live is the
-- transaction that moves the money. The wrapper's `recordMoneyAction` calls are
-- removed in the same commit, so this is a move rather than a second row.
--
-- Both bodies are migration 05's, copied verbatim. Each carries exactly one new
-- statement, marked in place — the payload matches what the wrapper wrote, so
-- rows already in `audit_logs` stay comparable with the ones written from here.
-- There is no signature change and therefore no drop.

begin;

create or replace function public.apply_payment_allocation(
  p_payment_id uuid,
  p_allocations jsonb
)
returns table (invoice_id uuid, applied numeric, new_state text)
language plpgsql security definer set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
  v_allocation record;
  v_invoice public.invoices%rowtype;
  v_allocated numeric(14,3);
  v_requested numeric(14,3);
  v_new_paid numeric(14,3);
  v_new_state public.invoice_states;
  v_grace_days integer;
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

  -- The only line that differs from migration 05's body.
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
$$;

create or replace function public.reverse_payment(p_payment_id uuid, p_reason text)
returns table (reversal_payment_id uuid)
language plpgsql security definer set search_path = public
as $$
declare
  v_original public.payments%rowtype;
  v_reversal_id uuid;
  v_allocation public.payment_allocations%rowtype;
  v_invoice public.invoices%rowtype;
  v_new_paid numeric(14,3);
  v_new_state public.invoice_states;
  v_grace_days integer;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'payments.reverse') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A reversal reason is required';
  end if;

  select p.* into v_original
  from public.payments p where p.id = p_payment_id
  for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_original.status <> 'confirmed' or v_original.reversed_by_payment_id is not null then
    raise exception 'Only an unreversed confirmed payment can be reversed';
  end if;
  if exists (
    select 1 from public.payments p
    where p.reversed_by_payment_id = v_original.id and p.status = 'reversed'
  ) then
    raise exception 'Payment has already been reversed';
  end if;

  insert into public.payments (
    code, company_id, tenant_id, account_type, method, amount, currency,
    payment_date, reference, unit_id, note, created_by, status, reversed_by_payment_id
  ) values (
    public.next_payment_code(), v_original.company_id, v_original.tenant_id,
    v_original.account_type, v_original.method, v_original.amount, v_original.currency,
    current_date, trim(p_reason), v_original.unit_id, trim(p_reason), auth.uid(),
    'reversed', v_original.id
  ) returning id into v_reversal_id;

  for v_allocation in
    select pa.* from public.payment_allocations pa
    where pa.payment_id = v_original.id order by pa.invoice_id
  loop
    select i.* into v_invoice
    from public.invoices i where i.id = v_allocation.invoice_id
    for update;
    select c.grace_days into v_grace_days
    from public.contracts c where c.id = v_invoice.contract_id;

    v_new_paid := greatest(0, v_invoice.paid - v_allocation.amount);
    v_new_state := case
      when v_invoice.total = 0 or v_new_paid >= v_invoice.total then 'paid'::public.invoice_states
      when (v_invoice.due_date + coalesce(v_grace_days, 0)) < current_date then 'overdue'::public.invoice_states
      when v_new_paid > 0 then 'partially_paid'::public.invoice_states
      else 'due'::public.invoice_states
    end;

    update public.invoices i
    set paid = v_new_paid, state = v_new_state
    where i.id = v_invoice.id;
    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (v_reversal_id, v_invoice.id, v_allocation.amount);
  end loop;

  update public.payments p set status = 'reversed' where p.id = v_original.id;

  -- The only line that differs from migration 05's body.
  perform public.write_audit(
    'payment.reverse',
    'payment',
    p_payment_id,
    null,
    jsonb_build_object('reason', trim(p_reason), 'reversal_payment_id', v_reversal_id)
  );

  reversal_payment_id := v_reversal_id;
  return next;
end;
$$;

-- Migration 96's lesson: `from public` alone misses an explicit anon grant and
-- `from anon` alone misses a PUBLIC grant. Migration 05 named only `public`;
-- these functions move money, so both get named here.
revoke all on function public.apply_payment_allocation(uuid, jsonb) from public, anon;
grant execute on function public.apply_payment_allocation(uuid, jsonb)
  to authenticated, service_role;

revoke all on function public.reverse_payment(uuid, text) from public, anon;
grant execute on function public.reverse_payment(uuid, text) to authenticated, service_role;

comment on function public.apply_payment_allocation(uuid, jsonb) is
  'يخصّص دفعة على فواتير المستأجر ويكتب صف التدقيق في نفس العملية. Allocates a payment across invoices and writes its own audit row, so a direct PostgREST call cannot move money without leaving a trail.';

comment on function public.reverse_payment(uuid, text) is
  'يعكس دفعة مؤكّدة ويكتب صف التدقيق في نفس العملية. Reverses a confirmed payment and writes its own audit row, so a direct PostgREST call cannot move money without leaving a trail.';

commit;
