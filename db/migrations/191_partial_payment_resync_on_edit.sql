-- 191_partial_payment_resync_on_edit.sql
--
-- يعيد مزامنة تسوية الدفعة الجزئية عند تعديل المبلغ أو الفاتورة أو تاريخ الدفع،
-- بدلاً من رفض التعديل كما فعلت الهجرة 160 (القرار D3).
--
-- WHY AN AFTER UPDATE TRIGGER, NOT BEFORE
-- The money lives on `payments` / `payment_allocations`, not on the ledger
-- row. A BEFORE trigger that tried to revert-and-reapply would still see the
-- old amount on `NEW` only after assignment, and 147's `sync_status` (AFTER
-- UPDATE OF state ON invoices) writes `partial_payments.status` — a BEFORE
-- UPDATE that then caused a recompute-to-unpaid would hit "tuple to be
-- updated was already modified". AFTER UPDATE matches the INSERT path that
-- already works: the ledger row is committed to the statement, then the
-- nested `sync_status` write of `status` is a later UPDATE of a finished
-- tuple. Proven by the fully-paid-reduction SQL test.
--
-- LOCK ORDER
-- `edit_partial_payment` takes the contract advisory locks (sorted) BEFORE
-- the ledger UPDATE, so two RPC edits on one contract cannot deadlock.
-- The trigger takes the same locks (re-entrant) so a direct UPDATE is still
-- serialised against `apply_partial_payment_settlement` and deposits. A
-- direct UPDATE holds its row lock first; if it then waits for an advisory
-- lock held by an RPC whose recompute makes 147's `sync_status` fan-out
-- write that same row, Postgres aborts one side with `40P01`. Retryable,
-- never corrupt. The UI has no direct-update path after this change.
--
-- RECOMPUTE BEFORE APPLY
-- `balance` is a stored generated column of `paid`. Reverting deletes the
-- allocation; without recomputing first, the re-apply would still see the
-- old `paid` and refuse a same-invoice increase as `partial_payment_exceeds_balance`.
--
-- DELETE-PATH GAP (unchanged)
-- 160's BEFORE/AFTER DELETE triggers take no advisory lock. Recorded, not
-- fixed (spec D6).
--
-- Wrapped in one transaction so `psql -f` cannot leave the table with the
-- old immutability trigger dropped and the resync not yet installed.

begin;

lock table public.partial_payments in share row exclusive mode;

-- Read-only preflight: every payment that claims a partial must still match
-- the ledger. A mismatch here is an invariant break the resync assumes away;
-- failing before any DROP leaves the operator a database they can repair.
do $$
declare
  v_bad text;
begin
  select string_agg(p.id::text, ', ' order by p.id)
    into v_bad
    from public.payments p
    left join public.partial_payments pp on pp.id = p.source_partial_payment_id
   where p.source_partial_payment_id is not null
     and (
       pp.id is null
       or p.status is distinct from 'confirmed'
       or p.amount is distinct from pp.amount
       or (select count(*) from public.payment_allocations pa where pa.payment_id = p.id)
           is distinct from 1
       or not exists (
         select 1
           from public.payment_allocations pa
          where pa.payment_id = p.id
            and pa.amount is not distinct from p.amount
            and pa.invoice_id is not distinct from pp.invoice_id
       )
     );
  if v_bad is not null then
    raise exception 'partial_payment_resync_preflight_failed: %', v_bad;
  end if;
end $$;

drop trigger if exists partial_payments_settled_immutable on public.partial_payments;
drop function if exists public.tg_partial_payments_settled_immutable();
drop trigger if exists partial_payments_settle_on_link on public.partial_payments;
drop function if exists public.tg_partial_payments_settle_on_link();

/**
 * يسدّد الدفعة الجزئية على فاتورة، مع علمي التصحيح وتجاوز الترتيب الزمني.
 *
 * The 1-argument form stays as a wrapper with (false, false) so 160's INSERT
 * trigger and 161's backfill keep their call sites. `p_correction` is why a
 * replacement receipt is labelled "(corrected)" rather than looking like a
 * first settlement. `p_skip_order_check` is why a typo fix on a later month
 * still works after an earlier month has been reopened.
 */
create or replace function public.apply_partial_payment_settlement(
  p_partial_payment_id uuid,
  p_correction boolean,
  p_skip_order_check boolean
)
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
  v_note text;
begin
  if current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'partial_payment_settlement_internal_only' using errcode = '42501';
  end if;

  select pp.* into v_partial
    from public.partial_payments pp where pp.id = p_partial_payment_id;
  if not found or v_partial.invoice_id is null then
    return null;
  end if;

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

  if v_partial.amount > v_invoice.balance then
    raise exception 'partial_payment_exceeds_balance' using errcode = '23514';
  end if;

  if not p_skip_order_check and exists (
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

  v_note := 'Settled from partial payment on invoice ' || v_invoice.code;
  if p_correction then
    v_note := v_note || ' (corrected)';
  end if;

  insert into public.payments (
    code, company_id, tenant_id, unit_id, account_type, method, amount, currency,
    payment_date, note, status, source_partial_payment_id
  ) values (
    public.next_payment_code(), v_tenant.company_id, v_invoice.tenant_id, v_invoice.unit_id,
    'commercial_account', 'cash', v_partial.amount, 'KWD',
    v_partial.paid_date,
    v_note, 'confirmed',
    v_partial.id
  )
  on conflict (source_partial_payment_id) where source_partial_payment_id is not null
  do nothing
  returning payments.id into v_payment_id;

  if v_payment_id is null then
    return v_invoice.id;
  end if;

  insert into public.payment_allocations (payment_id, invoice_id, amount)
  values (v_payment_id, v_invoice.id, v_partial.amount);

  update public.receipts r
     set html_snapshot = public.receipt_html_for_payment(v_payment_id)
   where r.payment_id = v_payment_id;

  perform public.recompute_invoice_from_confirmed(v_invoice.id);
  return v_invoice.id;
end;
$fn$;

revoke execute on function public.apply_partial_payment_settlement(uuid, boolean, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.apply_partial_payment_settlement(p_partial_payment_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'partial_payment_settlement_internal_only' using errcode = '42501';
  end if;
  return public.apply_partial_payment_settlement(p_partial_payment_id, false, false);
end;
$fn$;

revoke execute on function public.apply_partial_payment_settlement(uuid)
  from public, anon, authenticated, service_role;

/**
 * يعيد مزامنة التسوية بعد تعديل مبلغ أو فاتورة أو تاريخ دفع صف الدفعة الجزئية.
 *
 * `IS DISTINCT FROM` is the no-op guard: `UPDATE OF` fires when the column is
 * targeted, and a note-only save (or `SET amount = amount`) must not reissue
 * a receipt. Terminal *source* invoices are refused because
 * `recompute_invoice_from_confirmed` returns early for cancelled/waived, so
 * reverting there would strand a stale `paid`.
 */
create or replace function public.tg_partial_payments_resync()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_owned boolean;
  v_old_contract uuid;
  v_new_contract uuid;
  v_lock_key uuid;
  v_old_state text;
begin
  if new.amount is not distinct from old.amount
     and new.invoice_id is not distinct from old.invoice_id
     and new.paid_date is not distinct from old.paid_date then
    return null;
  end if;

  select exists (
    select 1 from public.payments p where p.source_partial_payment_id = old.id
  ) into v_owned;

  if v_owned then
    select i.state::text into v_old_state
      from public.invoices i where i.id = old.invoice_id;
    if v_old_state in ('cancelled', 'waived') then
      raise exception 'partial_payment_invoice_terminal_state' using errcode = '23514';
    end if;
  end if;

  select i.contract_id into v_old_contract
    from public.invoices i where i.id = old.invoice_id;
  select i.contract_id into v_new_contract
    from public.invoices i where i.id = new.invoice_id;

  for v_lock_key in
    select distinct c
      from unnest(array[v_old_contract, v_new_contract]) as c
     where c is not null
     order by c
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key::text, 0));
  end loop;

  perform public.revert_partial_payment_settlement(old.id);
  if old.invoice_id is not null then
    perform public.recompute_invoice_from_confirmed(old.invoice_id);
  end if;

  if new.invoice_id is not null then
    -- `IS NOT DISTINCT FROM`, not `=`: linking from a null invoice_id would
    -- otherwise pass NULL as the skip flag, and `IF NOT NULL` skips the
    -- chronological check — the opposite of "new links keep the check".
    perform public.apply_partial_payment_settlement(
      new.id,
      v_owned,
      new.invoice_id is not distinct from old.invoice_id
    );
  end if;

  return null;
end;
$fn$;

revoke execute on function public.tg_partial_payments_resync() from public, anon;

drop trigger if exists partial_payments_resync on public.partial_payments;
create trigger partial_payments_resync
  after update of amount, invoice_id, paid_date on public.partial_payments
  for each row
  execute function public.tg_partial_payments_resync();

/**
 * يرفض تعديل أكثر من صف دفعة جزئية في جملة واحدة.
 *
 * 147's fan-out inside a multi-row statement can hit "tuple already modified",
 * and no UI issues such statements. Postgres does not allow transition tables
 * on a trigger with a column list, so this fires on every UPDATE and counts
 * only the rows whose money columns changed — 147's own status-only fan-out
 * updates many rows and must not trip it.
 */
create or replace function public.tg_partial_payments_bulk_edit_guard()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if (
    select count(*)
      from edited n
      join previous o on o.id = n.id
     where n.amount is distinct from o.amount
        or n.invoice_id is distinct from o.invoice_id
        or n.paid_date is distinct from o.paid_date
  ) > 1 then
    raise exception 'partial_payment_bulk_edit_unsupported' using errcode = '23514';
  end if;
  return null;
end;
$fn$;

revoke execute on function public.tg_partial_payments_bulk_edit_guard() from public, anon;

drop trigger if exists partial_payments_bulk_edit_guard on public.partial_payments;
create trigger partial_payments_bulk_edit_guard
  after update on public.partial_payments
  referencing old table as previous new table as edited
  for each statement
  execute function public.tg_partial_payments_bulk_edit_guard();

/**
 * يعدّل صف الدفعة الجزئية بعد أخذ أقفال العقود، حتى لا يتداخل تعديلان متزامنان.
 *
 * The trigger still does the money work; this RPC is the ordering discipline
 * the UI uses so two edits cannot deadlock. Direct writers keep working and
 * rely on deadlock detection (see the file header).
 *
 * Every column the dialog can edit travels through here — contract link
 * (tenant/contract/unit/building) and, for an unlinked row, the manual
 * status. A settled row's status is derived from its invoice (147), so it is
 * only written when the row ends up unlinked; the link guard (151) validates
 * the invoice against the new contract and tenant. Locks cover the old
 * invoice's contract, the new invoice's contract and the new link contract.
 */
drop function if exists public.edit_partial_payment(uuid, numeric, date, uuid, text);

create or replace function public.edit_partial_payment(
  p_id uuid,
  p_amount numeric,
  p_paid_date date,
  p_invoice_id uuid,
  p_note text,
  p_tenant_id uuid,
  p_contract_id uuid,
  p_unit_id uuid,
  p_building_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $fn$
declare
  v_partial public.partial_payments%rowtype;
  v_old_contract uuid;
  v_new_contract uuid;
  v_lock_key uuid;
  v_updated public.partial_payments%rowtype;
begin
  -- Same shape as every other money RPC (05: create/update invoice,
  -- reverse_payment): enforced for authenticated callers; superuser and
  -- service paths pass through.
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'partial_payments.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select pp.* into v_partial from public.partial_payments pp where pp.id = p_id;
  if not found then
    raise exception 'partial_payment_not_found' using errcode = 'P0002';
  end if;

  select i.contract_id into v_old_contract
    from public.invoices i where i.id = v_partial.invoice_id;
  select i.contract_id into v_new_contract
    from public.invoices i where i.id = p_invoice_id;

  for v_lock_key in
    select distinct c
      from unnest(array[v_old_contract, v_new_contract, p_contract_id]) as c
     where c is not null
     order by c
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key::text, 0));
  end loop;

  update public.partial_payments
     set amount = p_amount,
         paid_date = p_paid_date,
         invoice_id = p_invoice_id,
         note = p_note,
         tenant_id = coalesce(p_tenant_id, tenant_id),
         contract_id = p_contract_id,
         unit_id = p_unit_id,
         building_id = p_building_id,
         status = case
           when p_invoice_id is null then coalesce(p_status, status)
           else status
         end
   where id = p_id;

  -- Not RETURNING: that tuple is the outer UPDATE's, before the AFTER trigger
  -- ran. Reducing the partial that fully paid an invoice reopens it, and 147's
  -- sync_status then writes `status = incomplete` on this same row; the caller
  -- records the returned row as the audit "after", so it must be the final one.
  select pp.* into v_updated from public.partial_payments pp where pp.id = p_id;

  return to_jsonb(v_updated);
end;
$fn$;

revoke execute on function public.edit_partial_payment(uuid, numeric, date, uuid, text, uuid, uuid, uuid, uuid, text)
  from public, anon;
grant execute on function public.edit_partial_payment(uuid, numeric, date, uuid, text, uuid, uuid, uuid, uuid, text)
  to authenticated;

comment on table public.partial_payments is
  'Part-payment ledger. A row naming an invoice settles it through a real payment and allocation (migration 160); editing amount/invoice/paid_date re-syncs that settlement (migration 191). A row with a null invoice_id is inert. Deliberately absent from get_budget_summary and from get_payments_overview''s net: the money is already counted once, through the payment the settlement creates. Adding it back would double-count. The delete path still takes no advisory lock (recorded gap).';

commit;
