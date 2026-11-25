-- 218_recompute_overdue_precedence.sql
--
-- يعيد ترتيب أولوية حالة الفاتورة في recompute_invoice_from_confirmed لتغليب التأخر على الدفع الجزئي.
--
-- Migration 153 ranked `partially_paid` above `overdue`, the outlier: both
-- `apply_payment_allocation` (217:142-147) and the nightly `evaluate_overdue`
-- (82) rank overdue first, so a same-day partial payment flickered to
-- `partially_paid` until midnight flipped it to `overdue` — and the dashboard
-- "paid" KPI jumped then dropped with it (spec decision D3). This replaces the
-- function body verbatim from 153:141-181 except the CASE order, which becomes
-- paid → overdue → partially_paid → due. Signature, security, search_path and
-- grants are preserved exactly as 153.

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
  -- Precedence is paid → overdue → partially_paid → due, matching
  -- `apply_payment_allocation` (217) and `evaluate_overdue` (82): an overdue
  -- invoice that received a partial payment reads `overdue`, not
  -- `partially_paid`, so reminders and the overdue KPI keep seeing it.
  update public.invoices i
     set paid = v_paid,
         state = case
           when v_paid >= v_invoice.total then 'paid'::public.invoice_states
           when (v_invoice.due_date + coalesce(v_grace, 0)) < current_date
             then 'overdue'::public.invoice_states
           when v_paid > 0 then 'partially_paid'::public.invoice_states
           else 'due'::public.invoice_states
         end
   where i.id = v_invoice.id;
end;
$fn$;

revoke execute on function public.recompute_invoice_from_confirmed(uuid)
  from public, anon, authenticated, service_role;
