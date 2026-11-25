-- 153_deposit_settlement.sql
--
-- Makes a *confirmed* bank deposit actually settle the invoice it names: it
-- inserts a real `payments` row and its allocation, and un-confirming deletes
-- them. Requires 152's columns.
--
-- WHAT MAKES THIS DIFFERENT FROM MIGRATION 147
-- 147 gave `partial_payments` a status derived FROM the invoice and said plainly
-- that "a status column describes a row; it must never move money". This runs
-- the other way: the deposit's status DRIVES the invoice. Every guard here
-- exists because of that inversion.
--
-- WHY A TRIGGER
-- `deposits` is written directly over PostgREST from the deposit form, again
-- from the attachment-preview dialog's delete (which re-sends the whole row),
-- and by `bulk_import_phase6`. An RPC would have to be adopted by each of them
-- and by anything added later — the "five scattered checks is where one gets
-- missed" shape CLAUDE.md warns about.
--
-- PROVENANCE IS A COLUMN, NOT A STRING
-- An earlier draft tagged the payment `AUTO-DEP:<deposit code>` the way
-- `set_invoice_paid` uses `AUTO-INV:`. A text reference is mutable, so editing
-- it orphans the settlement; and `set_invoice_paid`'s unpay branch deletes EVERY
-- payment carrying its reference, which for a shared tag would let one deposit's
-- cancellation destroy another's money. `payments.source_deposit_id` is a real
-- FK with a partial unique index, so a deposit owns exactly one payment and
-- cancellation can only ever find its own.
--
-- THE RECOMPUTE DELIBERATELY DOES NOT COPY MIGRATION 129
-- `set_invoice_paid` recomputes with `sum(payment_allocations.amount)`. That is
-- wrong in this schema: `reverse_payment` (05:663) writes a POSITIVE mirror
-- allocation on the reversal payment, so a raw sum counts reversed money as
-- paid. Everything here sums only allocations belonging to a `confirmed`
-- payment — both the original and its mirror are `reversed`, so they net out.
-- Migration 129 still has that bug; TODO.md tracks it.
--
-- WHAT THIS DOES NOT DO
-- The chronological rule is a settle-time admission check, exactly as strong as
-- the one `set_invoice_paid` already applies — not a persistent invariant.
-- `set_invoice_paid(…, false)` can still unmark an earlier invoice and leave a
-- later one settled (129:103). Making it an invariant means rewriting that
-- function's lock order and unmark branch, which three other paths call.

------------------------------------------------------------
-- 1. Provenance cannot be forged from a client connection
------------------------------------------------------------

-- Staff hold direct INSERT and UPDATE grants on `payments` (05:145, 05:198), so
-- without this they could point `source_deposit_id` at someone else's deposit,
-- clear it and orphan a settlement, or flip a deposit-owned payment to
-- `reversed` behind the deposit's back.
--
-- The test is `current_user`, not a GUC. An earlier draft used a
-- transaction-local flag (`set local danat.deposit_sync = 'on'`) as the
-- trigger's way of identifying itself; that is forgeable — any role able to run
-- SQL can `select set_config(…, true)`, which is exactly what src/db/testDb.ts
-- does — and `SET LOCAL` survives to transaction end, leaving the bypass armed
-- for every later payment write in the same transaction. Inside a SECURITY
-- DEFINER function `current_user` is the function's owner instead, and the three
-- Supabase client roles hold no membership that would let them SET ROLE to it.
--
-- INVOKER rights on purpose. A definer-rights guard would only ever observe its
-- own owner and would wave everything through.
create or replace function public.tg_payments_guard_deposit_provenance()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_client_role boolean := current_user in ('authenticated', 'anon', 'service_role');
begin
  -- Reversal is refused for EVERYONE, not only client roles. `reverse_payment`
  -- is itself SECURITY DEFINER, so `current_user` inside it is the owner and a
  -- role test would wave it straight through. Reversing here would reopen the
  -- invoice while the deposit still read `confirmed` — a state the deposits
  -- screen cannot explain. The deposit's own revert path deletes its payment
  -- rather than reversing it, so nothing legitimate takes this branch.
  if tg_op = 'UPDATE'
     and old.source_deposit_id is not null
     and new.status = 'reversed'
     and old.status <> 'reversed' then
    raise exception 'payment_owned_by_deposit' using errcode = '42501';
  end if;

  if not v_client_role then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.source_deposit_id is not null then
      raise exception 'payment_provenance_locked' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.source_deposit_id is distinct from old.source_deposit_id then
    raise exception 'payment_provenance_locked' using errcode = '42501';
  end if;

  -- A deposit-owned payment is a projection of its deposit, so a client role
  -- may not edit it AT ALL. Listing the derived fields individually was not
  -- enough: `payments_update_staff` also permits `tenant_id`, `unit_id`,
  -- `company_id`, `account_type` and `currency`, and re-pointing any of those
  -- would leave a payment attributed to one tenant still allocated to another
  -- tenant's invoice while its deposit insists otherwise. Whole-row immutability
  -- is both simpler to reason about and impossible to under-enumerate.
  if old.source_deposit_id is not null then
    raise exception 'payment_owned_by_deposit' using errcode = '42501';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.tg_payments_guard_deposit_provenance() from public, anon;

drop trigger if exists payments_guard_deposit_provenance on public.payments;
create trigger payments_guard_deposit_provenance
  before insert or update on public.payments
  for each row
  execute function public.tg_payments_guard_deposit_provenance();

------------------------------------------------------------
-- 2. Settle and revert
------------------------------------------------------------

-- Split out of the trigger for readability, and revoked from every client role.
-- They are not an API: `tg_deposits_sync_invoice` is the only caller, and each
-- refuses to run under a client role so that a future GRANT cannot quietly turn
-- them into one.

/**
 * يعيد حساب حالة الفاتورة من الدفعات المؤكدة وحدها.
 *
 * Sums only allocations whose payment is `confirmed`. `reverse_payment` leaves
 * a positive mirror allocation behind (05:663), so the obvious
 * `sum(payment_allocations.amount)` — which migration 129 still uses — counts
 * reversed money as paid. Never overwrites a terminal state: an invoice that
 * has since been cancelled or waived is not un-cancelled by a deposit changing.
 */
create or replace function public.recompute_invoice_from_confirmed(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_invoice public.invoices%rowtype;
  v_paid numeric(14,3);
  v_grace integer;
begin
  -- `for update` before the aggregate, not after. Without it a concurrent
  -- allocation can commit between this read and the UPDATE below, and the stale
  -- total then overwrites the newer `paid` — silently dropping the other
  -- transaction's money from the invoice.
  select i.* into v_invoice from public.invoices i where i.id = p_invoice_id for update;
  if not found then return; end if;
  if v_invoice.state in ('cancelled', 'waived') then return; end if;

  select coalesce(sum(pa.amount), 0) into v_paid
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id
   where pa.invoice_id = v_invoice.id
     and p.status = 'confirmed';

  select c.grace_days into v_grace
    from public.contracts c where c.id = v_invoice.contract_id;

  -- `balance` is generated (total - paid); assigning it is rejected.
  update public.invoices i
     set paid = v_paid,
         state = case
           when v_paid >= v_invoice.total then 'paid'::public.invoice_states
           when v_paid > 0 then 'partially_paid'::public.invoice_states
           when (v_invoice.due_date + coalesce(v_grace, 0)) < current_date
             then 'overdue'::public.invoice_states
           else 'due'::public.invoice_states
         end
   where i.id = v_invoice.id;
end;
$fn$;

revoke execute on function public.recompute_invoice_from_confirmed(uuid)
  from public, anon, authenticated, service_role;

/**
 * يلغي تسوية الإيداع: يحذف دفعته وتخصيصها ثم يعيد حساب الفاتورة.
 *
 * Finds the payment by `source_deposit_id`, never by tenant or reference, so it
 * can only ever remove what this deposit created. An invoice already settled by
 * MyFatoorah or by a manual mark keeps that money and stays paid — the owner
 * chose this over the literal "cancelled means unpaid" on 2026-08-21, because
 * the literal reading deletes payments the deposit never made.
 *
 * Receipts first: `receipts.payment_id` is `on delete restrict` (05:106).
 */
create or replace function public.revert_deposit_settlement(p_deposit_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_payment_id uuid;
  v_invoice_id uuid;
begin
  if current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'deposit_settlement_internal_only' using errcode = '42501';
  end if;

  select p.id into v_payment_id
    from public.payments p where p.source_deposit_id = p_deposit_id;
  if v_payment_id is null then return null; end if;

  select pa.invoice_id into v_invoice_id
    from public.payment_allocations pa where pa.payment_id = v_payment_id limit 1;

  delete from public.receipts r where r.payment_id = v_payment_id;
  delete from public.payment_allocations pa where pa.payment_id = v_payment_id;
  delete from public.payments p where p.id = v_payment_id;

  if v_invoice_id is not null then
    perform public.recompute_invoice_from_confirmed(v_invoice_id);
  end if;

  return v_invoice_id;
end;
$fn$;

revoke execute on function public.revert_deposit_settlement(uuid)
  from public, anon, authenticated, service_role;

/**
 * يسوّي الفاتورة المرتبطة بإيداع مؤكد بمبلغ لا يتجاوز رصيدها.
 *
 * Allocates `least(deposit.amount, invoice.balance)`. Settling the full balance
 * the way `set_invoice_paid` does would invent money the bank never received;
 * paying the deposit's full amount instead would invent ownership, because one
 * bank slip often aggregates several tenants' rent. The unattributed remainder
 * stays where it belongs — in the deposits ledger on /admin/deposits.
 *
 * A deposit covering the whole balance therefore yields `paid`, and a short one
 * yields `partially_paid`.
 */
create or replace function public.apply_deposit_settlement(p_deposit_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_deposit public.deposits%rowtype;
  v_invoice public.invoices%rowtype;
  v_tenant public.tenants%rowtype;
  v_amount numeric(14,3);
  v_payment_id uuid;
begin
  if current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'deposit_settlement_internal_only' using errcode = '42501';
  end if;

  select d.* into v_deposit from public.deposits d where d.id = p_deposit_id;
  if not found or v_deposit.invoice_id is null or v_deposit.status <> 'confirmed' then
    return null;
  end if;

  -- Serialise on the contract before touching any invoice row, so two deposits
  -- against the same contract cannot interleave between the chronological check
  -- and the write. Transaction-scoped, released at commit.
  perform pg_advisory_xact_lock(hashtextextended(v_deposit.contract_id::text, 0));

  select i.* into v_invoice
    from public.invoices i where i.id = v_deposit.invoice_id for update;
  if not found then return null; end if;

  if v_invoice.state in ('cancelled', 'waived') then
    raise exception 'deposit_invoice_terminal_state' using errcode = '23514';
  end if;

  if v_invoice.balance <= 0 then
    return v_invoice.id;
  end if;

  -- The same admission check `set_invoice_paid` applies (129:64). Compared as
  -- (year, month) so January always precedes February whatever the due dates do.
  if exists (
    select 1
      from public.invoices earlier
     where earlier.contract_id = v_invoice.contract_id
       and earlier.id <> v_invoice.id
       and earlier.balance > 0
       and earlier.state in ('due', 'overdue', 'partially_paid')
       and (earlier.period_year, earlier.period_month)
           < (v_invoice.period_year, v_invoice.period_month)
  ) then
    raise exception 'deposit_invoice_out_of_order' using errcode = '23514';
  end if;

  select t.* into v_tenant from public.tenants t where t.id = v_invoice.tenant_id;
  v_amount := least(v_deposit.amount, v_invoice.balance);

  insert into public.payments (
    code, company_id, tenant_id, unit_id, account_type, method, amount, currency,
    payment_date, reference, note, status, source_deposit_id
  ) values (
    public.next_payment_code(), v_tenant.company_id, v_invoice.tenant_id, v_invoice.unit_id,
    'commercial_account',
    -- The instrument the accountant recorded, not a blanket 'bank_transfer'.
    case when v_deposit.deposit_type = 'cheque'
      then 'cheque'::public.payment_methods
      else 'cash'::public.payment_methods end,
    v_amount, 'KWD', v_deposit.deposit_date,
    v_deposit.code, 'Settled from bank deposit ' || v_deposit.code, 'confirmed',
    v_deposit.id
  )
  on conflict (source_deposit_id) where source_deposit_id is not null do nothing
  returning payments.id into v_payment_id;

  -- Nothing came back: a concurrent transaction already settled this deposit and
  -- did all of the work below. Doing any of it again would double-allocate.
  if v_payment_id is null then
    return v_invoice.id;
  end if;

  insert into public.payment_allocations (payment_id, invoice_id, amount)
  values (v_payment_id, v_invoice.id, v_amount);

  -- The receipt trigger fires on the payment INSERT, before the allocation
  -- exists (05:463), so the snapshot it took shows an unallocated payment.
  -- `apply_payment_allocation` refreshes it for the same reason (05:589).
  update public.receipts r
     set html_snapshot = public.receipt_html_for_payment(v_payment_id)
   where r.payment_id = v_payment_id;

  perform public.recompute_invoice_from_confirmed(v_invoice.id);
  return v_invoice.id;
end;
$fn$;

revoke execute on function public.apply_deposit_settlement(uuid)
  from public, anon, authenticated, service_role;

------------------------------------------------------------
-- 3. The trigger that drives them
------------------------------------------------------------

/**
 * يبقي حالة الفاتورة متوافقة مع حالة الإيداع البنكي المرتبط بها.
 *
 * Revert-first on every path, including an edit. The invoice's balance already
 * reflects this deposit's own allocation, so capping a new amount against it
 * before removing the old one reads zero on a fully-settled invoice and the
 * edit would silently do nothing.
 *
 * SECURITY DEFINER because the permissions come apart: `deposits.update`
 * (08:135) and `invoices.update` are different grants, and under invoker rights
 * RLS would skip the invoice write silently — a settlement that quietly failed
 * looks exactly like one nobody asked for.
 */
create or replace function public.tg_deposits_sync_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_old_invoice uuid;
  v_new_invoice uuid;
  v_contract uuid;
begin
  -- Lock EVERY affected contract up front, sorted by id. The previous version
  -- locked the old contract here and left the new one to
  -- `apply_deposit_settlement`, which is an order, not a stable order: two
  -- deposits moving in opposite directions between contracts A and B would take
  -- them as A-then-B and B-then-A and deadlock. Sorting makes every transaction
  -- agree on the sequence. Advisory locks are re-entrant within a transaction,
  -- so `apply_deposit_settlement` re-taking its own is harmless.
  for v_contract in
    select distinct c
      from unnest(array[
        case when tg_op = 'UPDATE' then old.contract_id else null end,
        new.contract_id
      ]) as c
     where c is not null
     order by c
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_contract::text, 0));
  end loop;

  v_old_invoice := public.revert_deposit_settlement(new.id);

  if new.status = 'confirmed' and new.invoice_id is not null then
    v_new_invoice := public.apply_deposit_settlement(new.id);
  end if;

  -- The old invoice still needs recomputing when the link moved away from it;
  -- revert already did that for the same-invoice case, and repeating it is
  -- harmless but pointless.
  if v_old_invoice is not null and v_old_invoice is distinct from v_new_invoice then
    perform public.recompute_invoice_from_confirmed(v_old_invoice);
  end if;

  if v_old_invoice is not null or v_new_invoice is not null then
    perform public.write_audit(
      case when v_new_invoice is not null
        then 'deposit.invoice.settle' else 'deposit.invoice.revert' end,
      'deposit',
      new.id,
      jsonb_build_object('invoice_id', v_old_invoice, 'status', case when tg_op = 'UPDATE' then old.status else null end),
      jsonb_build_object('invoice_id', v_new_invoice, 'status', new.status, 'amount', new.amount),
      'success',
      null
    );
  end if;

  return null;
end;
$fn$;

revoke execute on function public.tg_deposits_sync_invoice() from public, anon, authenticated;

-- Two triggers, not one. `after insert or update … when (… old … )` is rejected
-- by PostgreSQL: an INSERT trigger has no OLD record, so a combined definition
-- fails at CREATE time.
drop trigger if exists deposits_sync_invoice on public.deposits;
drop trigger if exists deposits_sync_invoice_ins on public.deposits;
create trigger deposits_sync_invoice_ins
  after insert on public.deposits
  for each row
  execute function public.tg_deposits_sync_invoice();

-- `deposit_date` and `deposit_type` are here because they are copied into the
-- payment; leaving them out would let an edit strand a settled payment on a
-- stale date or instrument. `update … of status` fires whenever the column is
-- in the SET list, changed or not, and the form re-sends the whole row on every
-- save — the `is distinct from` tests are what stop a no-op save re-settling.
drop trigger if exists deposits_sync_invoice_upd on public.deposits;
create trigger deposits_sync_invoice_upd
  after update on public.deposits
  for each row
  when (
    new.status is distinct from old.status
    or new.invoice_id is distinct from old.invoice_id
    or new.amount is distinct from old.amount
    or new.deposit_date is distinct from old.deposit_date
    or new.deposit_type is distinct from old.deposit_type
  )
  execute function public.tg_deposits_sync_invoice();

/**
 * يلغي تسوية الإيداع قبل حذفه حتى لا تبقى دفعته يتيمة.
 *
 * BEFORE DELETE runs ahead of the foreign-key check, so removing the payment
 * here satisfies `payments.source_deposit_id`'s `on delete restrict`.
 * SECURITY DEFINER is not optional: authenticated users hold no DELETE grant on
 * `payments` (05:141), so under invoker rights every ordinary deletion from the
 * deposits screen would fail.
 */
create or replace function public.tg_deposits_revert_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_invoice_id uuid;
begin
  v_invoice_id := public.revert_deposit_settlement(old.id);

  if v_invoice_id is not null then
    perform public.write_audit(
      'deposit.invoice.revert',
      'deposit',
      old.id,
      jsonb_build_object('invoice_id', v_invoice_id, 'status', old.status, 'amount', old.amount),
      jsonb_build_object('reason', 'deposit deleted'),
      'success',
      null
    );
  end if;

  return old;
end;
$fn$;

revoke execute on function public.tg_deposits_revert_on_delete() from public, anon, authenticated;

drop trigger if exists deposits_revert_on_delete on public.deposits;
create trigger deposits_revert_on_delete
  before delete on public.deposits
  for each row
  execute function public.tg_deposits_revert_on_delete();
