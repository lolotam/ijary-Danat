-- 193_partial_payment_delete_lock.sql
--
-- يأخذ مُشغّل حذف الدفعة الجزئية قفل العقد الاستشاري قبل إرجاع المال، فيغلق
-- الثغرة التي سجّلتها الهجرة 191 في مسار الحذف.
--
-- WHY THIS MIGRATION EXISTS
-- `apply_partial_payment_settlement` (160) and `tg_partial_payments_resync`
-- (191) both serialise on the contract advisory lock, but deleting a settled
-- partial reverted the payment and recomputed the invoice with no lock at
-- all — a delete could interleave with a concurrent settlement or deposit on
-- the same contract. The admin UI deletes over PostgREST
-- (`useDeleteMoneyRecord` in `useRefunds.ts`), so there is no RPC to wrap:
-- the BEFORE DELETE trigger is the one choke point every delete passes
-- through, and the lock must live there.
--
-- ONE KEY FOR ALL THREE PATHS
-- The key is `hashtextextended(contract_id::text, 0)`, identical to 160 and
-- 191 and read from the INVOICE like they do — never from
-- `partial_payments.contract_id`, which can be null on a linked row — so
-- insert, edit and delete serialise on one key, and against deposits (153)
-- too.
--
-- SAME DEADLOCK CAVEAT AS A DIRECT UPDATE
-- The deleting statement already holds the row lock on the ledger row when
-- the advisory lock is requested, so a conflict with an RPC edit resolves by
-- deadlock detection: Postgres aborts one side with `40P01`. Retryable, never
-- corrupt — the trade 191 already accepted for direct UPDATEs.
--
-- THE BEFORE/AFTER SPLIT IS UNTOUCHED
-- The recompute stays in the AFTER DELETE trigger for 160's recorded reason:
-- recomputing in BEFORE DELETE fires 147's `sync_status` into the very row
-- being deleted ("tuple to be deleted was already modified by an operation
-- triggered by the current command"). Only the lock is added here; no money
-- ordering changes.
--
-- The trigger itself is NOT recreated: `partial_payments_revert_on_delete`
-- already points at `tg_partial_payments_revert_on_delete`, and
-- `create or replace function` swaps the body in place under the same OID.
--
-- Wrapped in one transaction so `psql -f` cannot leave a half-replaced
-- function. Idempotent: every statement below is re-runnable.

begin;

/**
 * يحذف مال الدفعة الجزئية المسدَّدة بعد أخذ قفل العقد الاستشاري.
 *
 * The lock precedes `revert_partial_payment_settlement` because that is the
 * first statement that touches money. The key comes from the invoice's
 * contract — never `partial_payments.contract_id`, nullable on a linked row
 * (see 160's own comment on `apply_partial_payment_settlement`) — so all
 * three writer paths share one key. The recompute deliberately stays in the
 * AFTER DELETE trigger; this function only removes the money rows.
 */
create or replace function public.tg_partial_payments_revert_on_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_contract uuid;
begin
  if old.invoice_id is not null then
    select i.contract_id into v_contract
      from public.invoices i where i.id = old.invoice_id;
    if v_contract is not null then
      perform pg_advisory_xact_lock(hashtextextended(v_contract::text, 0));
    end if;
  end if;

  perform public.revert_partial_payment_settlement(old.id);
  return old;
end;
$fn$;

-- A trigger function needs no EXECUTE grant to fire, and migration 96's rule
-- is that no SECURITY DEFINER function in `public` is anon-executable.
revoke execute on function public.tg_partial_payments_revert_on_delete() from public, anon;

comment on table public.partial_payments is
  'Part-payment ledger. A row naming an invoice settles it through a real payment and allocation (migration 160); editing amount/invoice/paid_date re-syncs that settlement (migration 191). A row with a null invoice_id is inert. Deliberately absent from get_budget_summary and from get_payments_overview''s net: the money is already counted once, through the payment the settlement creates. Adding it back would double-count. Deleting a settled row takes the same contract advisory lock (migration 193).';

commit;
