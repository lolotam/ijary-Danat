-- 238_breakdown_service_role_bypass.sql
--
-- يسمح لدور الخادم بقراءة لقطة سداد الفاتورة حتى تُرفق ملفات PDF بإيصالات الدفع.
--
-- Incident 2026-09-26: every payment receipt (email and WhatsApp) went out
-- without its PDF. `renderPaymentReceiptPdfs` and `renderInvoiceDocumentPdf`
-- call get_invoice_payment_breakdown through supabaseAdmin; the guard checks
-- is_staff(auth.uid()), auth.uid() is null under the service key, so the RPC
-- returned null and the renderer refused to attach anything.
--
-- A hand-applied prod hotfix (2026-09-09) had added this bypass but was never
-- committed, so migration 227 — copied from the repo's 192 body — silently
-- removed it on 2026-09-24. This makes the bypass part of the migration
-- history. Body is 227's with only the guard wrapped; same signature and
-- return type, so `create or replace` is safe. anon still gets no execute.

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
  -- The server's PDF renderers call this with the service key, where
  -- auth.uid() is null and the visibility guard below can only say no. They
  -- are already scoped to the payment or invoice being rendered, so the
  -- service role skips the per-user guard. Keep this on every re-issue.
  if auth.role() is distinct from 'service_role' then
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
               'last_paid_on', max(p.payment_date),
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

grant execute on function public.get_invoice_payment_breakdown(uuid) to service_role;
