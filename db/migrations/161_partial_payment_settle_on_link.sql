-- 161_partial_payment_settle_on_link.sql
--
-- Closes a hole migration 160 left open: linking an EXISTING partial payment to
-- an invoice settled nothing.
--
-- 160 settles on INSERT only. But the Partial Payments panel can edit a saved
-- row, and `tg_partial_payments_settled_immutable` refuses an `invoice_id`
-- change only when a payment already exists — which is precisely never for a row
-- that has not been settled yet. So the sequence
--
--   1. save a partial payment with no invoice   (inert, correct)
--   2. edit it and pick an invoice              (linked, and settled NOTHING)
--
-- reproduced the original bug through the edit path: a ledger row naming an
-- invoice, with no payment, no allocation, and an invoice whose balance never
-- moved. Exactly what 160 was written to make impossible.
--
-- WHY A TRIGGER RATHER THAN WIDENING 160's
-- 160 is already applied to production, and editing an applied migration does
-- not reach a database that has already run it. This is additive and idempotent.
--
-- WHY IT IS SAFE TO RE-RUN THE SETTLEMENT
-- `apply_partial_payment_settlement` inserts with
-- `on conflict (source_partial_payment_id) do nothing` and returns early when
-- nothing comes back, so a row that is already settled is a no-op. The trigger
-- does not need to know whether one exists.
--
-- WHAT THIS DOES NOT DO
-- Un-linking or re-pointing a SETTLED row stays refused by
-- `tg_partial_payments_settled_immutable` (160). The correction path is to
-- delete the row, which reverses the settlement, and create it again.

-- يسدّد الدفعة الجزئية عند ربطها بفاتورة بعد إنشائها، لا عند الإنشاء وحده.
--
-- Fires on the link transition rather than on every update, so the ordinary
-- status write from `tg_partial_payments_sync_status` never reaches it.
create or replace function public.tg_partial_payments_settle_on_link()
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

-- A trigger function needs no EXECUTE grant to fire, and migration 96's rule is
-- that no SECURITY DEFINER function in `public` is anon-executable.
revoke execute on function public.tg_partial_payments_settle_on_link() from public, anon;

drop trigger if exists partial_payments_settle_on_link on public.partial_payments;
create trigger partial_payments_settle_on_link
  after update of invoice_id on public.partial_payments
  for each row
  when (new.invoice_id is not null and old.invoice_id is distinct from new.invoice_id)
  execute function public.tg_partial_payments_settle_on_link();

-- Pre-flight, aggregated per invoice. 160's version compared each row against
-- the balance individually, so two rows that each fit but together do not passed
-- it and failed inside the loop instead -- after the loop had already committed
-- earlier settlements. Summing per invoice reports that case before any money
-- moves.
do $$
declare v_bad text;
begin
  select string_agg(distinct i.code, ', ') into v_bad
    from public.partial_payments pp
    join public.invoices i on i.id = pp.invoice_id
    left join public.payments p on p.source_partial_payment_id = pp.id
   where pp.invoice_id is not null and p.id is null
   group by i.id, i.code, i.balance, i.state
  having sum(pp.amount) > min(i.balance)
      or min(i.state::text) in ('cancelled', 'waived');
  if v_bad is not null then
    raise exception 'backfill_would_fail_for_invoices: %', v_bad;
  end if;
end $$;

-- Any row already in this state before the trigger existed. Same ordering and
-- the same abort-on-failure stance as 160's backfill, and a no-op on a database
-- where 160's own backfill already caught everything.
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
