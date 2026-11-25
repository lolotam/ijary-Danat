-- 195_due_day_first.sql
--
-- الإيجار يستحق في الأول من شهره. Operator decision 2026-09-14: every open
-- contract bills on the 1st, and every unpaid invoice moves with it. The
-- one-time consequence — September invoices become overdue on the next
-- nightly run and reminders go out in one burst — was accepted explicitly.
-- Paid, waived and cancelled invoices are settled history and stay put, and
-- so does every invoice of a terminated, expired or archived contract.
--
-- One-time normalisation, not a rule: the form, the save RPC and bulk import
-- keep accepting 1–28 (their defaults were already 1). Due dates only move
-- earlier here, so no overdue → due reversal is needed.

update public.contracts
   set due_day = 1
 where due_day <> 1
   and archived_at is null
   and state not in ('terminated', 'expired');

update public.invoices i
   set due_date = make_date(i.period_year, i.period_month, 1)
  from public.contracts c
 where c.id = i.contract_id
   and c.due_day = 1
   and c.archived_at is null
   and c.state not in ('terminated', 'expired')
   and i.state in ('due', 'overdue', 'partially_paid')
   and i.due_date <> make_date(i.period_year, i.period_month, 1);
