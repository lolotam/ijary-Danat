-- 160_partial_payment_settlement.sql
--
-- Makes a partial payment that names an invoice actually settle it: it inserts a
-- real `payments` row and its allocation, and deleting the partial removes them.
-- Cumulative partials reaching the invoice total therefore mark it paid, which is
-- what the Partial Payments panel has always implied and never did.
--
-- THIS OVERTURNS MIGRATION 147
-- 147 said plainly that "a status column describes a row; it must never move
-- money", and `refunds.sqltest.ts` was written to hold it to that. Migration 153
-- had already performed the identical inversion for `deposits`, and its header
-- names 147 as the thing it inverts. This is that same move, applied to the table
-- 147 was actually about. Every guard 153 installs is reproduced here because
-- every reason for them transfers unchanged.
--
-- WHAT STAYS TRUE FROM 147
-- `partial_payments.status` is still derived FROM the invoice by
-- `tg_partial_payments_sync_status`, and a partial with a null `invoice_id` is
-- still completely inert. Only the linked case moves money.
--
-- WHY A TRIGGER AND NOT AN RPC
-- `partial_payments` is written directly over PostgREST by `useCreateMoneyRecord`
-- and could be written by anything added later. An RPC would have to be adopted
-- by each writer -- the "five scattered checks is where one gets missed" shape
-- CLAUDE.md warns about.
--
-- THE RECOMPUTE REUSES `recompute_invoice_from_confirmed`
-- It must not copy migration 129's `sum(payment_allocations.amount)`:
-- `reverse_payment` (05:663) writes a POSITIVE mirror allocation on the reversal
-- payment, so a raw sum counts reversed money as paid. The shared function joins
-- to `payments` and filters `status = 'confirmed'`, so an original and its mirror
-- net out.
--
-- THREE DELIBERATE DEVIATIONS FROM THE DEPOSIT BLUEPRINT
--   * an amount above the invoice balance RAISES rather than capping with
--     `least(...)`: the panel must make over-entry impossible, and a silent cap
--     would leave the ledger row and its allocation disagreeing about the number;
--   * settlement fires on INSERT, because `partial_payments` has no confirm step;
--   * editing a settled row is refused rather than re-synced.
--
-- ALSO IN THIS FILE
-- `companies.email_logo_url`, for the Resend delivery card. It ships here rather
-- than in a 161 because it is one deploy and migrations are applied by hand.

------------------------------------------------------------
-- 1. Provenance is a column, not a string
------------------------------------------------------------

-- A text reference is mutable, so editing it orphans the settlement; and
-- `set_invoice_paid`'s unpay branch deletes EVERY payment carrying its reference
-- (159:139-149), which for a shared tag would let one row's cancellation destroy
-- another's money. A real FK with a partial unique index means a partial payment
-- owns exactly one payment and a revert can only ever find its own.
alter table public.payments
  add column if not exists source_partial_payment_id uuid;

do $$
begin
  alter table public.payments
    add constraint payments_source_partial_payment_id_fkey
    foreign key (source_partial_payment_id)
    references public.partial_payments(id) on delete restrict;
exception when duplicate_object then null;
end $$;

create unique index if not exists payments_source_partial_payment_uidx
  on public.payments (source_partial_payment_id)
  where source_partial_payment_id is not null;

comment on column public.payments.source_partial_payment_id is
  'The partial payment this payment was created to settle. Owned by the settlement trigger; a client connection cannot set, clear or repoint it.';

------------------------------------------------------------
-- 2. Provenance cannot be forged from a client connection
------------------------------------------------------------

-- A SEPARATE guard from `tg_payments_guard_deposit_provenance` (153:74) rather
-- than an extension of it. Re-issuing that function would mean reproducing its
-- live body exactly to avoid weakening the deposit rules it already enforces;
-- two narrow triggers, each owning one column, cannot break each other.
--
-- Staff hold direct INSERT and UPDATE grants on `payments` (05:145, 05:198), so
-- without this they could point `source_partial_payment_id` at someone else's
-- ledger row, clear it and orphan a settlement, or edit a partial-owned payment
-- behind the ledger's back.
--
-- The test is `current_user`, not a GUC. A transaction-local flag is forgeable --
-- any role able to run SQL can `select set_config(..., true)`, which is exactly
-- what src/db/testDb.ts does -- and `SET LOCAL` survives to transaction end,
-- leaving the bypass armed for every later payment write in the same
-- transaction. Inside a SECURITY DEFINER function `current_user` is the
-- function's owner instead, and the three Supabase client roles hold no
-- membership that would let them SET ROLE to it.
--
-- INVOKER rights on purpose. A definer-rights guard would only ever observe its
-- own owner and would wave everything through.
-- يمنع أي دور عميل من تزوير ملكية الدفعة أو تعديل دفعة مملوكة لدفعة جزئية.
create or replace function public.tg_payments_guard_partial_provenance()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_client_role boolean := current_user in ('authenticated', 'anon', 'service_role');
begin
  -- Reversal is refused for EVERYONE, not only client roles, exactly as 153 does
  -- for deposits. `reverse_payment` is itself SECURITY DEFINER, so `current_user`
  -- inside it is the owner and a role test would wave it straight through.
  -- Reversing here would reopen the invoice while the ledger row still asserted
  -- its amount -- the money would read as paid in one place and unpaid in the
  -- other. The revert path DELETES this payment rather than reversing it, so
  -- nothing legitimate takes this branch.
  if tg_op = 'UPDATE'
     and old.source_partial_payment_id is not null
     and new.status = 'reversed'
     and old.status <> 'reversed' then
    raise exception 'payment_owned_by_partial_payment' using errcode = '42501';
  end if;

  if not v_client_role then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.source_partial_payment_id is not null then
      raise exception 'payment_provenance_locked' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.source_partial_payment_id is distinct from old.source_partial_payment_id then
    raise exception 'payment_provenance_locked' using errcode = '42501';
  end if;

  -- Whole-row immutability under a client role, for 153's reason: listing the
  -- derived fields individually under-enumerates, because `payments_update_staff`
  -- also permits `tenant_id`, `unit_id`, `company_id`, `account_type` and
  -- `currency`, and re-pointing any of those would leave a payment attributed to
  -- one tenant still allocated to another tenant's invoice.
  if old.source_partial_payment_id is not null then
    raise exception 'payment_owned_by_partial_payment' using errcode = '42501';
  end if;

  return new;
end;
$fn$;

revoke execute on function public.tg_payments_guard_partial_provenance() from public, anon;

drop trigger if exists payments_guard_partial_provenance on public.payments;
create trigger payments_guard_partial_provenance
  before insert or update on public.payments
  for each row
  execute function public.tg_payments_guard_partial_provenance();

------------------------------------------------------------
-- 3. Settle and revert
------------------------------------------------------------

-- Split out of the triggers for readability, and revoked from every client role.
-- They are not an API: the triggers below are the only callers, and each refuses
-- to run under a client role so that a future GRANT cannot quietly turn them into
-- one.

/**
 * يسدّد الدفعة الجزئية على الفاتورة التي تشير إليها، بإنشاء دفعة حقيقية
 * وتخصيصها، ثم إعادة احتساب حالة الفاتورة.
 *
 * Mirrors `apply_deposit_settlement` (153) step for step, with the three
 * deviations recorded in this file's header.
 */
create or replace function public.apply_partial_payment_settlement(p_partial_payment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_partial public.partial_payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_tenant public.tenants%rowtype;
  v_invoice_contract uuid;
  v_payment_id uuid;
begin
  if current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'partial_payment_settlement_internal_only' using errcode = '42501';
  end if;

  select pp.* into v_partial
    from public.partial_payments pp where pp.id = p_partial_payment_id;
  if not found or v_partial.invoice_id is null then
    return null;
  end if;

  -- Serialise on the contract before touching any invoice row, so two partials
  -- against the same contract cannot interleave between the chronological check
  -- and the write. Same lock key as `apply_deposit_settlement`, so a deposit and
  -- a partial on one contract serialise against each other too.
  --
  -- The key comes from the INVOICE, not from `partial_payments.contract_id`.
  -- Deposits may use its own column because `deposits_contract_invoice_paired`
  -- forces (contract_id is null) = (invoice_id is null); this table has no such
  -- constraint, and `tg_partial_payments_link_guard` (151:44) checks contract_id
  -- only when it is non-null. A row naming an invoice with a null contract_id is
  -- reachable, and keying off it would give two writers on one contract different
  -- keys -- losing exactly the race the balance check below depends on winning.
  -- `invoices.contract_id` is NOT NULL.
  select i.contract_id into v_invoice_contract
    from public.invoices i where i.id = v_partial.invoice_id;
  if v_invoice_contract is null then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_invoice_contract::text, 0));

  select i.* into v_invoice
    from public.invoices i where i.id = v_partial.invoice_id for update;
  if not found then return null; end if;

  if v_invoice.state in ('cancelled', 'waived') then
    raise exception 'partial_payment_invoice_terminal_state' using errcode = '23514';
  end if;

  -- The real cap. The `max` attribute on the input is UX; two dialogs open at
  -- once both pass client validation, and only one may win.
  if v_partial.amount > v_invoice.balance then
    raise exception 'partial_payment_exceeds_balance' using errcode = '23514';
  end if;

  -- The same admission check `set_invoice_paid` applies (159:118-129). Compared
  -- as (year, month) so January always precedes February whatever the due dates
  -- do.
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
    raise exception 'partial_payment_invoice_out_of_order' using errcode = '23514';
  end if;

  select t.* into v_tenant from public.tenants t where t.id = v_invoice.tenant_id;

  -- `reference` is left null deliberately. `set_invoice_paid`'s unpay branch
  -- deletes payments BY REFERENCE (159:139-149), so a made-up tag would put this
  -- money in reach of an unrelated invoice's cancellation.
  insert into public.payments (
    code, company_id, tenant_id, unit_id, account_type, method, amount, currency,
    payment_date, note, status, source_partial_payment_id
  ) values (
    public.next_payment_code(), v_tenant.company_id, v_invoice.tenant_id, v_invoice.unit_id,
    'commercial_account', 'cash', v_partial.amount, 'KWD',
    v_partial.paid_date,
    'Settled from partial payment on invoice ' || v_invoice.code, 'confirmed',
    v_partial.id
  )
  on conflict (source_partial_payment_id) where source_partial_payment_id is not null
  do nothing
  returning payments.id into v_payment_id;

  -- Nothing came back: a concurrent transaction already settled this row and did
  -- all of the work below. Doing any of it again would double-allocate.
  if v_payment_id is null then
    return v_invoice.id;
  end if;

  insert into public.payment_allocations (payment_id, invoice_id, amount)
  values (v_payment_id, v_invoice.id, v_partial.amount);

  -- The receipt trigger fires on the payment INSERT, before the allocation exists
  -- (05:463), so the snapshot it took shows an unallocated payment.
  -- `apply_payment_allocation` refreshes it for the same reason (05:589).
  update public.receipts r
     set html_snapshot = public.receipt_html_for_payment(v_payment_id)
   where r.payment_id = v_payment_id;

  perform public.recompute_invoice_from_confirmed(v_invoice.id);
  return v_invoice.id;
end;
$fn$;

revoke execute on function public.apply_partial_payment_settlement(uuid) from public, anon, authenticated, service_role;

/**
 * يلغي تسديد الدفعة الجزئية: يحذف الإيصال والتخصيص والدفعة، دون إعادة احتساب
 * الفاتورة — تلك تتم في مُشغّل AFTER DELETE.
 *
 * Finds the payment by `source_partial_payment_id` alone -- never by reference or
 * tenant. That is the whole point of the column: a revert can only ever find the
 * payment its own ledger row created.
 *
 * WHY THE RECOMPUTE IS NOT HERE, UNLIKE `revert_deposit_settlement`
 * This runs from BEFORE DELETE, where the ledger row still exists. Recomputing
 * takes the invoice from `paid` back to `partially_paid`, which fires
 * `partial_payments_sync_status` (147, AFTER UPDATE OF state ON invoices), whose
 * `update partial_payments ... where invoice_id = ... and status <> 'incomplete'`
 * matches the very row being deleted -- and Postgres raises "tuple to be deleted
 * was already modified by an operation triggered by the current command".
 * Deposits is immune only because sync_status writes `partial_payments`, never
 * `deposits`. Moving the recompute to AFTER DELETE leaves it no surviving row to
 * collide with.
 */
create or replace function public.revert_partial_payment_settlement(p_partial_payment_id uuid)
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
    raise exception 'partial_payment_settlement_internal_only' using errcode = '42501';
  end if;

  select p.id into v_payment_id
    from public.payments p where p.source_partial_payment_id = p_partial_payment_id;
  if v_payment_id is null then return null; end if;

  select pa.invoice_id into v_invoice_id
    from public.payment_allocations pa where pa.payment_id = v_payment_id limit 1;

  -- A confirmed payment gets a receipt from a trigger; drop it first or the
  -- receipts FK blocks the delete.
  delete from public.receipts r where r.payment_id = v_payment_id;
  delete from public.payment_allocations pa where pa.payment_id = v_payment_id;
  delete from public.payments p where p.id = v_payment_id;

  return v_invoice_id;
end;
$fn$;

revoke execute on function public.revert_partial_payment_settlement(uuid) from public, anon, authenticated, service_role;

------------------------------------------------------------
-- 4. Triggers on partial_payments
------------------------------------------------------------

-- يستدعي التسديد بعد إدراج دفعة جزئية مرتبطة بفاتورة.
create or replace function public.tg_partial_payments_settle()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.apply_partial_payment_settlement(new.id);
  return null;  -- AFTER trigger: the return value is discarded.
end;
$fn$;

-- A trigger function needs no EXECUTE grant to fire, and migration 96's rule
-- is that no SECURITY DEFINER function in `public` is anon-executable.
revoke execute on function public.tg_partial_payments_settle() from public, anon;

drop trigger if exists partial_payments_settle on public.partial_payments;
create trigger partial_payments_settle
  after insert on public.partial_payments
  for each row when (new.invoice_id is not null)
  execute function public.tg_partial_payments_settle();

-- BEFORE DELETE removes the money rows, which is all `on delete restrict` on
-- `payments.source_partial_payment_id` needs satisfied. It must NOT recompute --
-- see `revert_partial_payment_settlement`'s own comment.
-- يحذف الدفعة وتخصيصها قبل حذف صف الدفعة الجزئية، دون إعادة احتساب.
create or replace function public.tg_partial_payments_revert_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.revert_partial_payment_settlement(old.id);
  return old;
end;
$fn$;

-- A trigger function needs no EXECUTE grant to fire, and migration 96's rule
-- is that no SECURITY DEFINER function in `public` is anon-executable.
revoke execute on function public.tg_partial_payments_revert_on_delete() from public, anon;

drop trigger if exists partial_payments_revert_on_delete on public.partial_payments;
create trigger partial_payments_revert_on_delete
  before delete on public.partial_payments
  for each row execute function public.tg_partial_payments_revert_on_delete();

-- AFTER DELETE, with the ledger row gone, so the invoice's own sync_status
-- trigger has nothing left to update and cannot collide with the delete.
-- يعيد احتساب الفاتورة بعد اختفاء صف الدفعة الجزئية.
create or replace function public.tg_partial_payments_recompute_after_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  perform public.recompute_invoice_from_confirmed(old.invoice_id);
  return null;
end;
$fn$;

-- A trigger function needs no EXECUTE grant to fire, and migration 96's rule
-- is that no SECURITY DEFINER function in `public` is anon-executable.
revoke execute on function public.tg_partial_payments_recompute_after_delete() from public, anon;

drop trigger if exists partial_payments_recompute_after_delete on public.partial_payments;
create trigger partial_payments_recompute_after_delete
  after delete on public.partial_payments
  for each row when (old.invoice_id is not null)
  execute function public.tg_partial_payments_recompute_after_delete();

-- A settled row is immutable in the two columns that describe the money. Edit is
-- refused rather than re-synced: fewer states, and no window in which the
-- allocation and the ledger row disagree.
--
-- The `UPDATE OF amount, invoice_id` column list is load-bearing. Widening it to
-- a bare BEFORE UPDATE would make every settlement raise, because
-- `tg_partial_payments_sync_status` sets `status` on exactly these rows.
-- يمنع تعديل مبلغ أو فاتورة دفعة جزئية سبق أن سدّدت.
create or replace function public.tg_partial_payments_settled_immutable()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if (new.amount is distinct from old.amount
      or new.invoice_id is distinct from old.invoice_id)
     and exists (select 1 from public.payments p
                  where p.source_partial_payment_id = old.id) then
    raise exception 'partial_payment_settled_immutable' using errcode = '23514';
  end if;
  return new;
end;
$fn$;

drop trigger if exists partial_payments_settled_immutable on public.partial_payments;
create trigger partial_payments_settled_immutable
  before update of amount, invoice_id on public.partial_payments
  for each row execute function public.tg_partial_payments_settled_immutable();

comment on table public.partial_payments is
  'Part-payment ledger. A row naming an invoice settles it through a real payment and allocation (migration 160); a row with a null invoice_id is inert. Deliberately absent from get_budget_summary and from get_payments_overview''s net: the money is already counted once, through the payment the settlement creates. Adding it back would double-count.';

------------------------------------------------------------
-- 5. Backfill rows written before this migration
------------------------------------------------------------

-- Production holds partial payments that name an invoice and settled nothing --
-- money an accountant recorded and the system ignored.
--
-- Pre-flight first. A bare `partial_payment_exceeds_balance` raised from inside
-- the loop names no row; this names every row that would fail, before any of them
-- does. It is best-effort by construction: it reads balances as they stand BEFORE
-- the loop, so two rows against one invoice that each fit individually but exceed
-- it together will both pass here and the second will fail inside the loop. That
-- is the loop's job to catch; this exists to make the common case legible.
do $$
declare v_bad text;
begin
  select string_agg(pp.id::text || ' (' || i.code || ')', ', ')
    into v_bad
    from public.partial_payments pp
    join public.invoices i on i.id = pp.invoice_id
    left join public.payments p on p.source_partial_payment_id = pp.id
   where pp.invoice_id is not null and p.id is null
     and (pp.amount > i.balance
          or i.state in ('cancelled', 'waived')
          or exists (
            select 1 from public.invoices earlier
             where earlier.contract_id = i.contract_id
               and earlier.id <> i.id
               and earlier.balance > 0
               and earlier.state in ('due', 'overdue', 'partially_paid')
               and (earlier.period_year, earlier.period_month)
                   < (i.period_year, i.period_month)));
  if v_bad is not null then
    raise exception 'backfill_would_fail_for: %', v_bad;
  end if;
end $$;

-- Ordered oldest-invoice first so the chronological check cannot reject a row
-- that a later iteration would have unblocked.
--
-- A row that still fails aborts the migration. A silently skipped backfill is
-- indistinguishable from a successful one, and the difference is money.
--
-- Only three of the migrations in this directory open an explicit transaction, so
-- `psql -f` autocommits per statement: this DO block is ONE statement, and a
-- mid-loop raise rolls back every settlement the loop made while leaving the DDL
-- above it committed. That is recoverable -- fix the offending row and re-run the
-- block -- but it is written down here so nobody concludes the whole migration
-- must be undone.
do $$
declare r record;
begin
  for r in
    select pp.id
      from public.partial_payments pp
      join public.invoices i on i.id = pp.invoice_id
      left join public.payments p on p.source_partial_payment_id = pp.id
     where pp.invoice_id is not null and p.id is null
     order by i.period_year, i.period_month, pp.created_at
  loop
    perform public.apply_partial_payment_settlement(r.id);
  end loop;
end $$;

------------------------------------------------------------
-- 6. Email logo (Resend delivery card)
------------------------------------------------------------

-- Nullable IS the fallback: null means "use companies.logo_url". The `branding`
-- bucket is public (21:34, re-asserted by 74:139-145), so the URL stored here is
-- fetchable by a mail client, which a signed URL would not be.
alter table public.companies
  add column if not exists email_logo_url text;

comment on column public.companies.email_logo_url is
  'Absolute public URL of the logo embedded in outgoing email. Null falls back to logo_url. Must be publicly fetchable -- mail clients load it remotely.';
