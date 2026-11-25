-- 250_concession_delete_recomputes_state.sql
--
-- يعيد حساب حالة الفاتورة بعد حذف الخصم، فلا تبقى «مدفوعة» ورصيدها أكبر من صفر.
--
-- The defect: deleting a concession restored `total = subtotal` on every invoice
-- it had discounted, but never recomputed their `state`. An invoice that the
-- tenant had paid at its DISCOUNTED total therefore kept the state `paid`
-- while its balance was back above zero — the ledger said "settled" and the
-- money said "400 still owed". The invariant spec records it in §1.2, the
-- "حذف خصم" row: "يعيد فتح فاتورة مدفوعة، ولا يعيد حساب state فتبقى paid ورصيدها
-- > 0".
--
-- The fix is one line inside `tg_restore_invoices_on_concession_delete`:
-- `perform public.recompute_invoice_from_confirmed(v_invoice.id);`, right
-- after the totals are restored and before the concession line items are
-- removed. No new logic is invented here:
--
--   - `recompute_invoice_from_confirmed` (218) already locks the invoice row
--     (`for update`) BEFORE it sums, so the write cannot race a concurrent
--     allocation the way an unlocked recompute would.
--   - It sums ONLY the allocations whose payment is `confirmed`, so the state
--     it writes is the one the settled money supports: `paid` when the
--     confirmed payments cover the total, `overdue` ahead of `partially_paid`
--     when the due date has passed (the precedence 218 established), and
--     `partially_paid`/`due` otherwise.
--   - It returns early for `cancelled` and `waived` invoices, so a write-off
--     is not silently undone by a concession delete.
--
-- This is item 7 of §5 ("إصلاح حالة حذف الخصم") of the invoice-order invariant
-- spec — docs/specs/invoice-order-invariant.md — issue #280, phase 1 slice P1a.
--
-- Function only: no data is touched, and the trigger is neither dropped nor
-- recreated — the function name is unchanged, so the existing BEFORE DELETE
-- trigger on public.concessions keeps calling it.
--
-- Rollback: re-apply the body from migration 127 (127_concession_invoices.sql),
-- which remains the reference copy of the pre-fix version.

create or replace function public.tg_restore_invoices_on_concession_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link record;
  v_invoice public.invoices%rowtype;
begin
  if old.type = 'free_months' then
    return old;
  end if;

  for v_link in
    select ci.invoice_id
      from public.concession_invoices ci
     where ci.concession_id = old.id
  loop
    select i.* into v_invoice
      from public.invoices i
     where i.id = v_link.invoice_id
     for update;
    if not found then
      continue;
    end if;

    update public.invoices
       set discount = 0,
           total = subtotal
     where id = v_invoice.id;

    perform public.recompute_invoice_from_confirmed(v_invoice.id);

    delete from public.invoice_items
     where invoice_id = v_invoice.id
       and is_concession = true;
  end loop;

  return old;
end;
$$;

revoke execute on function public.tg_restore_invoices_on_concession_delete()
  from public, anon;
