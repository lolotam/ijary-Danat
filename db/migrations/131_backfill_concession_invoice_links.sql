-- 131_backfill_concession_invoice_links.sql
-- يربط الفواتير المخصومة سابقًا بسجل الخصم الذي أنشأها، قبل أن يفقد التوليد
-- قدرته على اشتقاق الخصم من نطاق التاريخ.
--
-- Migration 127 stopped percentage/fixed discounts being re-derived from
-- concession date ranges at generation time, and protects an invoice from
-- regeneration only when it has a concession_invoices row. Invoices discounted
-- BEFORE 127 have a non-zero `discount` and no such row, which leaves them in a
-- state 127 did not anticipate:
--
--   * the next regenerate would drop them to full price, silently, because
--     nothing re-derives the discount and nothing protects them; and
--   * apply_concession_to_invoices refuses an invoice whose discount is already
--     non-zero, so an admin could not re-attach the discount by hand either.
--
-- Written as a callable function rather than a bare DO block so it can be
-- tested: the SQL suite builds an empty database, where an inline backfill
-- would run against no rows and prove nothing.

create or replace function public.backfill_concession_invoice_links()
returns table (linked integer, left_for_review integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice record;
  v_concession_id uuid;
  v_match_count integer;
begin
  linked := 0;
  left_for_review := 0;

  for v_invoice in
    select i.id, i.code, i.contract_id, i.period_year, i.period_month
      from public.invoices i
     where coalesce(i.discount, 0) > 0
       and not exists (
         select 1 from public.concession_invoices ci where ci.invoice_id = i.id
       )
     order by i.code
  loop
    -- The ONE active percentage/fixed concession on this invoice's own contract
    -- whose range covers its period. Where the match is not unique the row is
    -- left alone and reported: guessing which concession produced a given
    -- amount of money is worse than leaving a human to look at it.
    -- array_agg, not min(): Postgres has no min() aggregate for uuid.
    select count(*), (array_agg(cn.id))[1]
      into v_match_count, v_concession_id
      from public.concessions cn
     where cn.contract_id = v_invoice.contract_id
       and cn.status = 'active'
       and cn.type <> 'free_months'
       and cn.start_date <= make_date(v_invoice.period_year, v_invoice.period_month, 1)
       and cn.end_date >= make_date(v_invoice.period_year, v_invoice.period_month, 1);

    if v_match_count = 1 then
      insert into public.concession_invoices (concession_id, invoice_id)
      values (v_concession_id, v_invoice.id)
      on conflict do nothing;
      linked := linked + 1;
    else
      left_for_review := left_for_review + 1;
      raise notice 'Invoice % has a discount but % candidate concessions; left unlinked',
        v_invoice.code, v_match_count;
    end if;
  end loop;

  return next;
end;
$$;

revoke all on function public.backfill_concession_invoice_links() from public;
revoke all on function public.backfill_concession_invoice_links() from anon;
revoke all on function public.backfill_concession_invoice_links() from authenticated;
grant execute on function public.backfill_concession_invoice_links() to service_role;

select * from public.backfill_concession_invoice_links();
