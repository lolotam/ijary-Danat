-- 152_deposit_invoice_link.sql
--
-- Gives a bank deposit somewhere to say which contract and invoice it pays for,
-- and keeps that link coherent. The settlement it drives lives in 153; the bank
-- catalogue the form reads lives in 154. Apply all three together — 153's
-- triggers are inert without these columns, and 152 alone changes no behaviour.
--
-- WHY THE LINK IS OPTIONAL
-- Both columns are nullable and paired: a deposit names a contract and an
-- invoice together, or neither. An unreconciled deposit is the normal state of
-- a deposit on the day it is written down, so requiring the link would reject
-- every honest entry. Production held zero deposit rows on 2026-08-21, so the
-- constraints below apply to an empty table.
--
-- WHY `restrict` AND NOT `set null`
-- `set null` would clear `invoice_id` and leave `contract_id` behind, which
-- violates the paired check in the same statement that caused it — so deleting
-- an invoice would fail on a confusing constraint error rather than a clear one.
-- `tg_invoices_unlink_deposits` clears both together instead, which is the thing
-- a referential action cannot do and a trigger can.

------------------------------------------------------------
-- 1. The link, and the invariants that keep it coherent
------------------------------------------------------------

alter table public.deposits
  add column if not exists contract_id uuid references public.contracts(id) on delete restrict;
alter table public.deposits
  add column if not exists invoice_id uuid references public.invoices(id) on delete restrict;

-- `restrict`, not `set null`. `set null` would clear `invoice_id` and leave
-- `contract_id` populated, which violates the paired check below — so deleting
-- an invoice would fail on a confusing constraint error instead of a clear one.
-- `payment_allocations.invoice_id` is already `restrict` (05:97), so a settled
-- invoice is undeletable regardless; this only says the same thing about a
-- deposit that has not settled yet. `tg_invoices_unlink_deposits` in part 2
-- keeps invoice regeneration working despite it.

do $$ begin
  alter table public.deposits
    add constraint deposits_contract_invoice_paired
    check ((contract_id is null) = (invoice_id is null));
exception when duplicate_object then null; end $$;

-- The currency lock the owner asked for, in the database rather than only in
-- the form. Without it the table and the CSV importer still accept any string,
-- and a USD deposit would go on to produce a KWD payment. Production holds no
-- deposit rows at all as of 2026-08-21, so this applies to an empty table.
do $$ begin
  alter table public.deposits
    add constraint deposits_currency_kwd check (currency = 'KWD');
exception when duplicate_object then null; end $$;

create index if not exists deposits_contract_idx on public.deposits (contract_id);
create index if not exists deposits_invoice_idx on public.deposits (invoice_id);

alter table public.payments
  add column if not exists source_deposit_id uuid references public.deposits(id) on delete restrict;

-- The partial unique index is the idempotency mechanism, not decoration: a
-- second attempt to settle the same deposit collides here instead of writing a
-- second payment. The settle path inserts with `on conflict … do nothing` and
-- branches on whether a row came back.
create unique index if not exists payments_source_deposit_uidx
  on public.payments (source_deposit_id)
  where source_deposit_id is not null;

comment on column public.deposits.contract_id is
  'Contract this bank deposit pays toward. Null together with invoice_id — an '
  'unreconciled deposit is a normal state, so the link is optional.';
comment on column public.deposits.invoice_id is
  'The single invoice this deposit settles when its status is confirmed. '
  'Maintained against payments via tg_deposits_sync_invoice (migration 153).';
comment on column public.payments.source_deposit_id is
  'Set only by the deposit sync trigger (migration 153). Its presence means this payment exists '
  'because a deposit was confirmed, and that cancelling that deposit removes '
  'exactly this row. Unique, so one deposit can never own two payments.';

------------------------------------------------------------
-- 2. Invoice deletion must not be blocked by an unsettled link
------------------------------------------------------------

-- Invoice regeneration and reapply delete due/overdue invoices (139:389,
-- 127:353, 127:438). A *pending* linked deposit owns no allocation, so nothing
-- else shields its invoice and the new FK would abort the whole regeneration
-- run with an incidental FK violation. This clears both link columns together —
-- together, because the paired check forbids clearing one alone, which is
-- exactly what an FK `set null` action cannot do and a trigger can.
--
-- Only deposits owning no payment are unlinked. A confirmed deposit's invoice
-- carries an allocation and is already undeletable through
-- `payment_allocations`' own restrict, so that case does not reach here — and
-- if it ever did, the FK refusing is the correct outcome rather than silently
-- deleting an invoice a bank deposit paid.
--
-- SECURITY DEFINER: whoever regenerates invoices holds `invoices.*` and need
-- not hold `deposits.update`, and under invoker rights RLS would skip this
-- UPDATE silently — a link that quietly failed to clear looks identical to one
-- that was never there.
create or replace function public.tg_invoices_unlink_deposits()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_unlinked integer;
begin
  -- An invoice can carry more than one deposit, so this counts rows with GET
  -- DIAGNOSTICS rather than `returning … into`, which captures only the last
  -- row and would under-report the moment a second deposit existed.
  update public.deposits d
     set contract_id = null,
         invoice_id = null
   where d.invoice_id = old.id
     and not exists (
       select 1 from public.payments p where p.source_deposit_id = d.id
     );
  get diagnostics v_unlinked = row_count;

  if v_unlinked > 0 then
    perform public.write_audit(
      'deposit.invoice.unlink',
      'invoice',
      old.id,
      jsonb_build_object('invoice_code', old.code),
      jsonb_build_object('reason', 'invoice deleted', 'deposits_unlinked', v_unlinked),
      'success',
      null
    );
  end if;

  return old;
end;
$fn$;

revoke execute on function public.tg_invoices_unlink_deposits() from public, anon, authenticated;

drop trigger if exists invoices_unlink_deposits on public.invoices;
create trigger invoices_unlink_deposits
  before delete on public.invoices
  for each row
  execute function public.tg_invoices_unlink_deposits();

------------------------------------------------------------
-- 3. A link must be coherent before anything acts on it
------------------------------------------------------------

-- Same shape as `tg_partial_payments_link_guard` (147): three independent
-- foreign keys with nothing relating them means a malformed write can attach
-- one contract's deposit to another contract's invoice, and the sync would then
-- settle an unrelated debt.
--
-- Deliberately NOT security definer: it only reads `public.invoices`, which
-- every staff user can already read, and a function needing no elevation should
-- not have any.
create or replace function public.tg_deposits_link_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
declare
  v_invoice_contract uuid;
begin
  if new.invoice_id is null then
    return new;
  end if;

  select i.contract_id into v_invoice_contract
    from public.invoices i
   where i.id = new.invoice_id;

  if not found then
    raise exception 'deposit_invoice_not_found' using errcode = '23503';
  end if;

  if new.contract_id is distinct from v_invoice_contract then
    raise exception 'deposit_invoice_contract_mismatch' using errcode = '23514';
  end if;

  return new;
end;
$fn$;

drop trigger if exists deposits_link_guard on public.deposits;
create trigger deposits_link_guard
  before insert or update of invoice_id, contract_id on public.deposits
  for each row
  execute function public.tg_deposits_link_guard();
