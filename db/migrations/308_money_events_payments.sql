-- 308 (T071): the money event outbox — the enqueue path and the
-- payment and deposit events.
--
-- Every money event of contracts/jobs.md section 5 is a row in job_requests
-- written by the SQL function that owns the state change, inside the same
-- transaction, so a rolled-back change leaves no event and a committed change
-- never loses one (FR-018). The web application never calls queue.add() for
-- these; the relay picks the rows up (contracts/jobs.md section 2).
--
-- 1. enqueue_job_request / enqueue_job / enqueue_job_for_company — the one
--    insert path, with a company-scoped door for the money functions.
-- 2. apply_payment_allocation — payment.succeeded
-- 3. reverse_payment — payment.reversed
-- 4. tg_deposits_sync_invoice — deposit.confirmed
--
-- Only the functions that own a money state change are redefined here, and
-- each body is the latest definition copied verbatim with exactly one added
-- enqueue call at the point the change succeeds. The signatures, return types,
-- security mode, set search_path and grants are unchanged: a money function
-- runs as its owner.
--
-- Payload shapes are the catalogue's strict schemas (src/jobs/catalog.ts):
-- one id per event, nothing else.
--
-- Guarded by src/db/outbox/moneyEvents.sqltest.ts.

------------------------------------------------------------
-- 1. the enqueue path
------------------------------------------------------------

/**
 * يكتب صف `job_requests` واحداً وييدع معرّفه، أو معرّف الطلب الموجود إن تكرر
 * مفتاح منع التكرار للشركة والنوع نفسه.
 *
 * The one insert path: `enqueue_job` (a caller that has a company context) and
 * `enqueue_job_for_company` (the money functions, which know the company of
 * the row they changed) both land here, so the row shape and the dedupe rule
 * live in one place instead of two copies that can drift apart.
 *
 * Security invoker: the insert runs with the caller's rights, so a
 * `company_service` caller still passes the `job_requests` RLS policy, and a
 * money function runs as its owner. `set search_path = ''` leaves nothing to
 * resolve implicitly.
 *
 * Five parameters: they are the five columns of the row this function writes.
 * The requester has to be an argument because the company client names the
 * staff member in the call, not in its token. The public doors
 * (`enqueue_job`, `enqueue_job_for_company`) keep the four-argument shape; a
 * composite type would shorten the signature at the price of a type in the
 * public schema, for a function with two callers.
 */
create or replace function public.enqueue_job_request(
  _company_id uuid,
  _kind text,
  _payload jsonb,
  _dedupe_key text,
  _requested_by uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job_id uuid;
begin
  insert into public.job_requests (company_id, kind, payload, dedupe_key, requested_by)
  values (_company_id, _kind, coalesce(_payload, '{}'::jsonb), _dedupe_key, _requested_by)
  on conflict (company_id, kind, dedupe_key) where dedupe_key is not null
  do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select j.id into v_job_id
      from public.job_requests j
     where j.company_id = _company_id
       and j.kind = _kind
       and j.dedupe_key = _dedupe_key;
  end if;

  return v_job_id;
end;
$$;

-- The internal insert path: the company client and the money functions only.
-- A signed-in user has no privilege on it, so a renter cannot queue work.
revoke all on function public.enqueue_job_request(uuid, text, jsonb, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_job_request(uuid, text, jsonb, text, uuid)
  to company_service;

/**
 * يسجّل طلب مهمة خلفية للشركة الحالية داخل المعاملة الجارية ويعيد معرّفه، أو معرّف الطلب
 * الموجود إن تكرر مفتاح منع التكرار للنوع نفسه.
 *
 * Security invoker: company_service writes through its own policy, and SQL
 * functions that emit money events run as their owner. A rolled-back caller
 * leaves no row, so no event escapes a failed change (FR-018).
 *
 * The requester: company_service carries no `sub`, so server code names the
 * staff member in `_requested_by`; every other caller gets the JWT `sub` and the
 * argument is ignored. The composite FK to profiles rejects a requester from
 * another company. System jobs leave it null.
 */
create or replace function public.enqueue_job(
  _kind text,
  _payload jsonb default '{}'::jsonb,
  _dedupe_key text default null,
  _requested_by uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_requested_by uuid;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  -- current_user, not request_api_role(): that helper calls auth.role(), and
  -- company_service has no usage on schema auth. Owner-run functions see their owner here.
  if current_user = 'company_service' then
    v_requested_by := _requested_by;
  else
    -- Read `sub` directly for the same reason auth.uid() is avoided.
    v_requested_by := nullif(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', ''
    )::uuid;
  end if;

  return public.enqueue_job_request(v_company_id, _kind, _payload, _dedupe_key, v_requested_by);
end;
$$;

-- service_role has no company context, so it would always hit COMPANY_REQUIRED;
-- the relay and fan-out write job_requests directly instead.
revoke all on function public.enqueue_job(text, jsonb, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_job(text, jsonb, text, uuid) to company_service;

/**
 * يسجّل طلب مهمة خلفية لشركة معيّنة داخل المعاملة الجارية ويعيد معرّفه.
 *
 * The money functions own the company of the row they changed, so when the
 * caller has no company context — a platform `service_role` settlement — the
 * event is filed against that company instead of being dropped (FR-018).
 * `enqueue_job` is the door for a caller that HAS a company context.
 *
 * Security definer with `set search_path = ''`: only `service_role` and the
 * money functions that own the insert may call it. A signed-in user and a
 * company client cannot file work for a company they do not belong to.
 */
create or replace function public.enqueue_job_for_company(
  _company_id uuid,
  _kind text,
  _payload jsonb default '{}'::jsonb,
  _dedupe_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if _company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.companies c where c.id = _company_id) then
    raise exception 'Company not found: %', _company_id;
  end if;

  -- A platform sweep has no signed-in staff member to name, so the event
  -- belongs to nobody: requested_by stays null.
  return public.enqueue_job_request(_company_id, _kind, _payload, _dedupe_key, null);
end;
$$;

-- Only the platform worker and the money functions that own the insert may
-- file work for a named company.
revoke all on function public.enqueue_job_for_company(uuid, text, jsonb, text)
  from public, anon, authenticated, company_service;
grant execute on function public.enqueue_job_for_company(uuid, text, jsonb, text)
  to service_role;

-- 2. payment.succeeded — the allocation of a confirmed payment

/**
 * يوزّع مبلغ دفعة مؤكّدة على الفواتير ضمن نطاق الشركة، ويخرج حدث
 * `payment.succeeded` مع المعاملة نفسها.
 *
 * The allocation is where a confirmed payment lands on invoices, so the event
 * leaves here rather than where the payment row is inserted (FR-018).
 */

CREATE OR REPLACE FUNCTION public.apply_payment_allocation(p_payment_id uuid, p_allocations jsonb)
 RETURNS TABLE(invoice_id uuid, applied numeric, new_state text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
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
    from public.payments p
   where p.id = p_payment_id
     and (v_caller_company is null or p.company_id = v_caller_company)
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
    from public.payment_allocations pa
   where pa.payment_id = p_payment_id and pa.company_id = v_payment.company_id;
  select coalesce(sum(x.amount), 0) into v_requested
    from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric);
  if v_allocated + v_requested > v_payment.amount then
    raise exception 'Allocations exceed the remaining payment amount';
  end if;

  -- Direct authenticated sessions must settle oldest open invoice first;
  -- service_role and company_service webhook/worker paths remain exempt.
  if auth.role() = 'authenticated' then
    with requested as (
      select x.invoice_id, x.amount
      from jsonb_to_recordset(p_allocations) as x(invoice_id uuid, amount numeric)
    )
    select target.code into v_blocked_code
      from public.invoices target
      join requested r on r.invoice_id = target.id
     where target.company_id = v_payment.company_id
       and exists (
         select 1
           from public.invoices earlier
           left join requested paid_now on paid_now.invoice_id = earlier.id
          where earlier.contract_id = target.contract_id
            and earlier.company_id = v_payment.company_id
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
      from public.invoices i
     where i.id = v_allocation.invoice_id
       and i.company_id = v_payment.company_id
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

    insert into public.payment_allocations (company_id, payment_id, invoice_id, amount)
    values (v_payment.company_id, p_payment_id, v_invoice.id, v_allocation.amount);
    update public.invoices i
       set paid = v_new_paid, state = v_new_state
     where i.id = v_invoice.id and i.company_id = v_payment.company_id;

    invoice_id := v_invoice.id;
    applied := v_allocation.amount;
    new_state := v_new_state::text;
    return next;
  end loop;

  update public.receipts r
     set html_snapshot = public.receipt_html_for_payment(p_payment_id)
   where r.payment_id = p_payment_id and r.company_id = v_payment.company_id;

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
  -- Money outbox (T071): the allocation is where a confirmed payment lands on
  -- invoices, so the event leaves with the allocation, never before (FR-018).
  if v_caller_company is not null then
    perform public.enqueue_job(
      'payment.succeeded', jsonb_build_object('paymentId', p_payment_id),
      'payment.succeeded:' || p_payment_id::text);
  else
    -- A platform settlement has no company context: the event goes to that company.
    perform public.enqueue_job_for_company(v_payment.company_id, 'payment.succeeded',
      jsonb_build_object('paymentId', p_payment_id), 'payment.succeeded:' || p_payment_id::text);
  end if;
end;
$function$;

-- 3. payment.reversed — the reversal of a confirmed payment

/**
 * يعكس دفعة مؤكّدة ويعيد أرصدة الفواتير، ويخرج حدث `payment.reversed` مع
 * المعاملة نفسها.
 *
 * The event names the payment whose state changed (the original), not the
 * mirror row the reversal creates (FR-018).
 */

CREATE OR REPLACE FUNCTION public.reverse_payment(p_payment_id uuid, p_reason text)
 RETURNS TABLE(reversal_payment_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller_company uuid := public.current_company_id_strict();
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
    from public.payments p
   where p.id = p_payment_id
     and (v_caller_company is null or p.company_id = v_caller_company)
   for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_original.status <> 'confirmed' or v_original.reversed_by_payment_id is not null then
    raise exception 'Only an unreversed confirmed payment can be reversed';
  end if;
  if exists (
    select 1 from public.payments p
     where p.reversed_by_payment_id = v_original.id
       and p.company_id = v_original.company_id
       and p.status = 'reversed'
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
     where pa.payment_id = v_original.id and pa.company_id = v_original.company_id
     order by pa.invoice_id
  loop
    select i.* into v_invoice
      from public.invoices i
     where i.id = v_allocation.invoice_id and i.company_id = v_original.company_id
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
     where i.id = v_invoice.id and i.company_id = v_original.company_id;
    insert into public.payment_allocations (company_id, payment_id, invoice_id, amount)
    values (v_original.company_id, v_reversal_id, v_invoice.id, v_allocation.amount);
  end loop;

  update public.payments p
     set status = 'reversed'
   where p.id = v_original.id and p.company_id = v_original.company_id;

  perform public.write_audit(
    'payment.reverse', 'payment', p_payment_id, null,
    jsonb_build_object('reason', trim(p_reason), 'reversal_payment_id', v_reversal_id)
  );
  -- Money outbox (T071): the original payment now reads 'reversed', so the
  -- event names the payment that changed, not the mirror row (FR-018).
  if v_caller_company is not null then
    perform public.enqueue_job(
      'payment.reversed', jsonb_build_object('paymentId', p_payment_id),
      'payment.reversed:' || p_payment_id::text);
  else
    -- A platform reversal has no company context: the event goes to that company.
    perform public.enqueue_job_for_company(v_original.company_id, 'payment.reversed',
      jsonb_build_object('paymentId', p_payment_id), 'payment.reversed:' || p_payment_id::text);
  end if;

  reversal_payment_id := v_reversal_id;
  return next;
end;
$function$;

-- 4. deposit.confirmed — the confirmation of a bank deposit

/**
 * يعيد تسوية الإيداع عند تعديله أو تأكيده، ويخرج حدث `deposit.confirmed`
 * مع المعاملة نفسها.
 *
 * The confirmation itself is a TypeScript write; this trigger is the SQL
 * function that observes it, so it is where the event leaves (FR-018).
 */

CREATE OR REPLACE FUNCTION public.tg_deposits_sync_invoice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_id uuid := coalesce(public.current_company_id(), new.company_id);
  v_old_invoice uuid;
  v_new_invoice uuid;
  v_contract uuid;
begin
  if new.company_id <> v_company_id then
    raise exception 'deposit_company_mismatch' using errcode = '42501';
  end if;

  for v_contract in
    select distinct c
      from unnest(array[case when tg_op = 'UPDATE' then old.contract_id else null end, new.contract_id]) as c
     where c is not null order by c
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_contract::text, 0));
  end loop;

  v_old_invoice := public.revert_deposit_settlement(new.id);
  if new.status = 'confirmed' and new.invoice_id is not null then
    v_new_invoice := public.apply_deposit_settlement(new.id);
  end if;

  if v_old_invoice is not null and v_old_invoice is distinct from v_new_invoice then
    perform public.recompute_invoice_from_confirmed(v_old_invoice);
  end if;

  if v_old_invoice is not null or v_new_invoice is not null then
    perform public.write_audit(
      case when v_new_invoice is not null then 'deposit.invoice.settle' else 'deposit.invoice.revert' end,
      'deposit', new.id,
      jsonb_build_object('invoice_id', v_old_invoice, 'status', case when tg_op = 'UPDATE' then old.status else null end),
      jsonb_build_object('invoice_id', v_new_invoice, 'status', new.status, 'amount', new.amount),
      'success', null
    );
  end if;
  -- Money outbox (T071): the deposit is confirmed, so the event leaves with the
  -- same transaction as the confirmation (FR-018). Only the transition to
  -- 'confirmed' counts; an edit of an already confirmed deposit is not a new
  -- confirmation. The key is the deposit id alone because the sender is
  -- idempotent per deposit.
  if new.status = 'confirmed'
     and (case when tg_op = 'UPDATE' then old.status end) is distinct from 'confirmed' then
    if public.current_company_id() is not null then
      perform public.enqueue_job(
        'deposit.confirmed', jsonb_build_object('depositId', new.id),
        'deposit.confirmed:' || new.id::text);
    else
      -- A platform confirmation has no company context: the event goes to that company.
      perform public.enqueue_job_for_company(new.company_id, 'deposit.confirmed',
        jsonb_build_object('depositId', new.id), 'deposit.confirmed:' || new.id::text);
    end if;
  end if;
  return null;
end;
$function$;

-- The grants of every redefined function are unchanged; they are restated here
-- so the file states the permissions it depends on.
REVOKE ALL ON FUNCTION public.apply_payment_allocation(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_payment_allocation(uuid, jsonb) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.reverse_payment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_payment(uuid, text) TO authenticated, company_service, service_role;
REVOKE ALL ON FUNCTION public.tg_deposits_sync_invoice() FROM PUBLIC, anon;
