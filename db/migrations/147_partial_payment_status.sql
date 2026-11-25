-- 147_partial_payment_status.sql
--
-- Gives `public.partial_payments` a settlement status, and keeps that status in
-- step with the invoice each row points at.
--
-- `invoice_id` has existed on this table since migration 56 and has never been
-- written by anything. The Partial Payments panel now sets it, so a part-payment
-- note can name the invoice it refers to — and once it does, the obvious
-- question is whether that invoice has since been settled.
--
-- WHY A TRIGGER AND NOT CLIENT CODE
-- An invoice reaches `paid` down three separate paths: `set_invoice_paid` from
-- the admin table, the MyFatoorah webhook, and `paymentReconcileJob`. Checking
-- the status flip at each of them is the shape CLAUDE.md warns about for
-- `runEventWorkflow` — "five scattered checks is where one gets missed, and a
-- missed one is invisible". One trigger covers every path including any added
-- later, and `bun run test:sql` can prove it.
--
-- WHAT THIS DOES NOT DO
-- `partial_payments` stays inert: excluded from `get_budget_summary`, allocating
-- against nothing, changing no invoice balance. `refunds.sqltest.ts` asserts
-- exactly that and is the guard against this migration drifting into the money
-- path. A status column describes a row; it must never move money.

------------------------------------------------------------
-- 1. Status column
------------------------------------------------------------

alter table public.partial_payments
  add column if not exists status text not null default 'incomplete';

-- Added separately from the column so re-applying the migration against a
-- database that already has the column still installs the constraint.
alter table public.partial_payments
  drop constraint if exists partial_payments_status_check;
alter table public.partial_payments
  add constraint partial_payments_status_check
  check (status in ('incomplete', 'complete'));

comment on column public.partial_payments.status is
  'incomplete = the referenced invoice is still outstanding; complete = it has '
  'been settled. Fully derived for rows carrying an invoice_id — computed on '
  'write by tg_partial_payments_link_guard and kept in step afterwards by '
  'tg_partial_payments_sync_status. Freely set by the admin only on rows with '
  'no invoice_id.';

-- The status trigger and the tenant-detail tab both filter on this column.
create index if not exists partial_payments_invoice_idx
  on public.partial_payments (invoice_id);

------------------------------------------------------------
-- 2. Status follows the invoice, in both directions
------------------------------------------------------------

-- SYMMETRIC ON PURPOSE. An earlier draft flipped only paid -> complete, on the
-- reasoning that an admin could edit a row back by hand. That was circular: the
-- same design disables editing on exactly those rows. A reversed payment, an
-- un-marked invoice or a voided gateway settlement must be able to reopen what
-- it closed, or the system has a state it can enter and not leave.
--
-- SECURITY DEFINER because the two permissions come apart: an admin who may
-- mark an invoice paid (`invoices.update`) need not hold
-- `partial_payments.update`, and under the invoker's rights the RLS policy would
-- skip the UPDATE silently — the worst possible outcome, since a status that
-- quietly failed to flip looks identical to one that was never meant to.
create or replace function public.tg_partial_payments_sync_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.state = 'paid' then
    update public.partial_payments
       set status = 'complete'
     where invoice_id = new.id
       and status <> 'complete';
  elsif old.state = 'paid' then
    update public.partial_payments
       set status = 'incomplete'
     where invoice_id = new.id
       and status <> 'incomplete';
  end if;
  -- AFTER trigger: the return value is discarded.
  return null;
end;
$fn$;

-- `src/db/anonExecute.sqltest.ts` is set-based and fails the whole suite for any
-- anon-executable SECURITY DEFINER outside three named RLS helpers. A new
-- function arrives with EXECUTE granted to PUBLIC, so this is not optional.
revoke execute on function public.tg_partial_payments_sync_status() from public, anon;

drop trigger if exists partial_payments_sync_status on public.invoices;
create trigger partial_payments_sync_status
  after update of state on public.invoices
  for each row
  when (new.state is distinct from old.state)
  execute function public.tg_partial_payments_sync_status();

------------------------------------------------------------
-- 3. A linked row's status is derived, never authored
------------------------------------------------------------

-- Two rules, in one BEFORE trigger because they answer the same question — what
-- does this row's invoice link mean.
--
-- (a) THE LINK MUST BE COHERENT. Migration 56 gave `invoice_id`, `contract_id`
--     and `tenant_id` three independent foreign keys and nothing relating them
--     to each other, so a malformed write can attach one contract's part-payment
--     to another contract's invoice — and the trigger in part 2 would then
--     happily flip that row when the unrelated invoice settled.
--
-- (b) STATUS FOLLOWS THE INVOICE. Part 2 keeps a linked row in step *as the
--     invoice changes state*, but it cannot see a row that is written already
--     claiming `complete` against an invoice that never moves. That row would be
--     closed on arrival and, because the UI locks linked complete rows, could
--     never be reopened — reintroducing exactly the one-way state part 2 exists
--     to prevent. So for a linked row the column is computed here from the
--     invoice, and whatever the client sent is discarded.
--
--     A row with no `invoice_id` keeps whatever the admin set: nothing overrules
--     them there, and it stays editable.
--
-- Deliberately NOT security definer: it only reads `public.invoices`, which
-- every staff user can already read, so invoker rights are enough — and a
-- function that needs no elevation should not have any.
create or replace function public.tg_partial_payments_link_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_invoice_state text;
  v_invoice_contract uuid;
begin
  if new.invoice_id is null then
    return new;
  end if;

  select i.state::text, i.contract_id
    into v_invoice_state, v_invoice_contract
    from public.invoices i
   where i.id = new.invoice_id;

  if not found then
    raise exception 'partial_payment_invoice_not_found' using errcode = '23503';
  end if;

  if new.contract_id is not null and v_invoice_contract is distinct from new.contract_id then
    raise exception 'partial_payment_invoice_contract_mismatch' using errcode = '23514';
  end if;

  new.status := case when v_invoice_state = 'paid' then 'complete' else 'incomplete' end;
  return new;
end;
$fn$;

drop trigger if exists partial_payments_invoice_matches_contract on public.partial_payments;
drop trigger if exists partial_payments_link_guard on public.partial_payments;
create trigger partial_payments_link_guard
  before insert or update of invoice_id, contract_id, status on public.partial_payments
  for each row
  execute function public.tg_partial_payments_link_guard();
