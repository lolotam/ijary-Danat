-- 192_invoice_payment_breakdown.sql
--
-- يثبت مصدر دفعة البوابة على صف الدفعة نفسه، ويعطي الحوار والمستند لقطة
-- واحدة للمبالغ: سياق تعديل الدفعة الجزئية، وتفصيل طرق السداد على الفاتورة.
--
-- `payment_request_id` exists because `payment_requests.resulting_payment_id`
-- is a scalar: one gateway request that settled several months only points at
-- the last payment. The webhook writes this column on every confirmed insert;
-- the backfill recovers rows written before it existed.
--
-- The breakdown RPC is SECURITY DEFINER so a tenant can read `payment_requests`
-- (they have no SELECT on that table) without widening its RLS. Authorisation
-- is the invoice's own `invoices_select_allowed` predicate, copied verbatim —
-- a future change to that policy must be mirrored here (structure test).

-- One transaction: the compatibility trigger must exist before the backfill
-- runs, or a gateway payment inserted by the old bundle between the two
-- would commit without provenance and never be revisited.
begin;

alter table public.payments
  add column if not exists payment_request_id uuid
    references public.payment_requests(id) on delete set null;

create index if not exists payments_payment_request_id_idx
  on public.payments (payment_request_id)
  where payment_request_id is not null;

comment on column public.payments.payment_request_id is
  'The payment_requests row that created this payment, when it came from the gateway. Written by the webhook; backfilled from resulting_payment_id and from notes starting MyFatoorah <code>. Null means the payment is manual (or a partial-payment settlement).';

/**
 * يستنتج طلب الدفع لدفعة بوابة أُدرجت بلا `payment_request_id`، من ملاحظة الويب هوك.
 *
 * Migrations are applied before the new bundle deploys, so a gateway
 * completion in that window is inserted by the old webhook without the
 * column — and nothing would ever revisit it. The webhook's own note format
 * (`MyFatoorah <code> — m/y`) is the durable clue; this closes the window and
 * any future writer that forgets the field. Explicit values are never touched.
 */
create or replace function public.tg_payments_infer_gateway_provenance()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if new.payment_request_id is null and new.note like 'MyFatoorah %' then
    select pr.id into new.payment_request_id
      from public.payment_requests pr
     where new.note like 'MyFatoorah ' || pr.code || ' %'
     limit 1;
  end if;
  return new;
end;
$fn$;

revoke execute on function public.tg_payments_infer_gateway_provenance() from public, anon;

drop trigger if exists payments_infer_gateway_provenance on public.payments;
create trigger payments_infer_gateway_provenance
  before insert on public.payments
  for each row execute function public.tg_payments_infer_gateway_provenance();

-- resulting_payment_id first: it is the request's own pointer. Note prefix
-- second, and only where the column is still null, so a request that settled
-- several months labels every confirmed payment whose note the webhook wrote.
update public.payments p
   set payment_request_id = pr.id
  from public.payment_requests pr
 where p.payment_request_id is null
   and pr.resulting_payment_id = p.id;

update public.payments p
   set payment_request_id = pr.id
  from public.payment_requests pr
 where p.payment_request_id is null
   and p.status = 'confirmed'
   -- The space after the code is load-bearing: without it 'PREQ-1' would also
   -- claim every note written for 'PREQ-10'.
   and p.note like 'MyFatoorah ' || pr.code || ' %';

/**
 * يعيد هل الدفعة الجزئية مسدَّدة، ومقدار ما تخصّصه على فاتورة الحوار.
 *
 * PostgREST would embed `payments` as an array: the unique index on
 * `source_partial_payment_id` is partial, so it does not count as to-one.
 * One statement, invoker rights, so RLS on the four tables still applies.
 */
create or replace function public.get_partial_payment_edit_context(p_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $fn$
  select jsonb_build_object(
    'settled', exists (
      select 1 from public.payments pay
       where pay.source_partial_payment_id = pp.id
    ),
    'credited_amount', coalesce((
      select pa.amount
        from public.payments pay
        join public.payment_allocations pa on pa.payment_id = pay.id
       where pay.source_partial_payment_id = pp.id
         and pay.status = 'confirmed'
         and pa.invoice_id is not distinct from pp.invoice_id
       limit 1
    ), 0),
    'invoice', case
      when i.id is null then null
      else jsonb_build_object(
        'id', i.id,
        'code', i.code,
        'period_year', i.period_year,
        'period_month', i.period_month,
        'balance', i.balance,
        'state', i.state
      )
    end
  )
  from public.partial_payments pp
  left join public.invoices i on i.id = pp.invoice_id
  where pp.id = p_id
$fn$;

revoke execute on function public.get_partial_payment_edit_context(uuid)
  from public, anon;
grant execute on function public.get_partial_payment_edit_context(uuid)
  to authenticated;

/**
 * لقطة سداد الفاتورة: الإجماليات ومجموعات التخصيص حسب المصدر وطريقة الدفع.
 *
 * SECURITY DEFINER so the tenant can see gateway provenance without a SELECT
 * grant on `payment_requests`. The invoice row is the authorisation anchor:
 * the predicate below is copied verbatim from `invoices_select_allowed`
 * (05:159-165). Returns null when the caller may not see the invoice.
 */
create or replace function public.get_invoice_payment_breakdown(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_invoice public.invoices%rowtype;
  v_paid_from numeric(14,3);
  v_groups jsonb;
begin
  if not exists (
    select 1 from public.invoices
     where id = p_invoice_id
       and (
         public.is_staff(auth.uid()) or (
           is_visible_to_tenant and exists (
             select 1 from public.profiles p where p.id = auth.uid() and p.tenant_id = invoices.tenant_id
           )
         )
       )
  ) then
    return null;
  end if;

  select i.* into v_invoice from public.invoices i where i.id = p_invoice_id;
  if not found then
    return null;
  end if;

  select coalesce(sum(pa.amount), 0)::numeric(14,3)
    into v_paid_from
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id
   where pa.invoice_id = v_invoice.id
     and p.status = 'confirmed';

  select coalesce(
    jsonb_agg(g.row order by g.first_paid_on, g.source, g.method),
    '[]'::jsonb
  )
    into v_groups
    from (
      select jsonb_build_object(
               'source', case
                 when p.source_partial_payment_id is not null then 'partial'
                 when p.payment_request_id is not null then 'gateway'
                 else 'manual'
               end,
               'method', p.method,
               'amount', sum(pa.amount)::numeric(14,3),
               'first_paid_on', min(p.payment_date),
               'payments', count(distinct p.id)
             ) as row,
             min(p.payment_date) as first_paid_on,
             case
               when p.source_partial_payment_id is not null then 'partial'
               when p.payment_request_id is not null then 'gateway'
               else 'manual'
             end as source,
             p.method
        from public.payment_allocations pa
        join public.payments p on p.id = pa.payment_id
       where pa.invoice_id = v_invoice.id
         and p.status = 'confirmed'
       group by
         case
           when p.source_partial_payment_id is not null then 'partial'
           when p.payment_request_id is not null then 'gateway'
           else 'manual'
         end,
         p.method
    ) g;

  return jsonb_build_object(
    'invoice', jsonb_build_object(
      'code', v_invoice.code,
      'subtotal', v_invoice.subtotal,
      'discount', v_invoice.discount,
      'total', v_invoice.total,
      'paid', v_invoice.paid,
      'balance', v_invoice.balance,
      'state', v_invoice.state
    ),
    'paid_from_allocations', v_paid_from,
    'reconciled', v_paid_from = v_invoice.paid,
    'groups', v_groups
  );
end;
$fn$;

revoke execute on function public.get_invoice_payment_breakdown(uuid)
  from public, anon;
grant execute on function public.get_invoice_payment_breakdown(uuid)
  to authenticated;

commit;
