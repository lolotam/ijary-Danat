-- ---------------------------------------------------------------------------
-- 108 - manual payment reason and Method of Payment
-- ---------------------------------------------------------------------------
--
-- Three things, all in service of one question: how was this invoice actually
-- settled, and if a human settled it by hand, why?
--
-- 1. invoices.manual_payment_reason / invoices.payment_method.
-- 2. A `manual_payment_reasons` option list whose items carry the settlement
--    method in metadata, so the reason DRIVES the payment method. Migration 23
--    hardcoded every manually settled payment to 'cash', which meant a bank
--    transfer and a cheque were both reported as cash. Capturing the reason is
--    what finally supplies the information to fix that.
-- 3. A trigger that maintains invoices.payment_method from payment_allocations.
--
-- On (3): payment_method is deliberately NOT written by application code. Every
-- settlement path — manual marking, the MyFatoorah gateway, partial payments,
-- reversals, and the placeholder-adoption branch added in migration 107's
-- companion change — already goes through payment_allocations. A trigger there
-- covers all of them at once, including the paths implemented in TypeScript,
-- and no caller can forget to update the column. It also makes the "empty cell
-- when unpaid" rule a consequence rather than a rendering special-case:
-- un-marking deletes the allocation, which nulls the columns.

alter table public.invoices
  add column if not exists manual_payment_reason text,
  add column if not exists payment_method text;

comment on column public.invoices.manual_payment_reason is
  'option_list_items.value from the manual_payment_reasons list. Set only when an admin marks the invoice paid by hand; cleared when the last allocation goes away.';
comment on column public.invoices.payment_method is
  'Derived from the allocated payment by trg_invoice_payment_method. Never write this from application code.';

-- --- 1. the reason catalog ---------------------------------------------------
-- Free-text list (absent from ENUM_BACKED_OPTION_LISTS), so admins may add their
-- own reasons. metadata.payment_method is optional: an item without it settles
-- as 'cash', which is the pre-existing behaviour, so a hand-added reason can
-- never break settlement.

insert into public.option_lists (code, name_ar, name_en, description_ar, description_en, is_system)
values (
  'manual_payment_reasons',
  'أسباب الدفع اليدوي', 'Reason of manual payment',
  'الأسباب المتاحة عند تعليم فاتورة كمدفوعة يدويًا.',
  'Selectable reasons shown when an invoice is marked paid by hand.',
  true
)
on conflict (code) do update
  set name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      description_ar = excluded.description_ar,
      description_en = excluded.description_en;

insert into public.option_list_items (list_id, value, label_ar, label_en, sort_order, metadata)
select l.id, v.value, v.label_ar, v.label_en, v.sort_order, v.metadata
from public.option_lists l
cross join (values
    ('bank_transfer', 'تحويل بنكي', 'Bank transfer', 10, '{"payment_method": "bank_transfer"}'::jsonb),
    ('complete_partial_payment', 'دفعة كاملة / جزئية', 'Complete / partial payment', 20, '{"payment_method": "cash"}'::jsonb),
    ('cheque', 'شيك', 'Check', 30, '{"payment_method": "cheque"}'::jsonb),
    ('audit_adjustment', 'تدقيق / تعديل بيانات', 'Audit / data adjustment', 40, '{"payment_method": "cash"}'::jsonb)
  ) as v(value, label_ar, label_en, sort_order, metadata)
where l.code = 'manual_payment_reasons'
on conflict (list_id, value) do update
  set label_ar = excluded.label_ar,
      label_en = excluded.label_en,
      metadata = excluded.metadata;
-- Deliberately does NOT touch is_active or sort_order on replay: an admin who
-- disabled or reordered a reason must not have that undone by a re-run.

-- --- 2. payment_method trigger ----------------------------------------------

create or replace function public.sync_invoice_payment_method()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice_id uuid;
  v_method text;
begin
  v_invoice_id := coalesce(new.invoice_id, old.invoice_id);

  -- Most recent surviving allocation wins. An invoice settled across several
  -- payments shows how it was finished, which is what "Method of Payment"
  -- means to someone reading the row.
  select p.method::text into v_method
  from public.payment_allocations pa
  join public.payments p on p.id = pa.payment_id
  where pa.invoice_id = v_invoice_id
    and p.status = 'confirmed'
  order by p.payment_date desc, p.created_at desc
  limit 1;

  update public.invoices i
    set payment_method = v_method,
        -- No allocation left means nothing was settled, so a manual reason for
        -- settling it is stale by definition.
        manual_payment_reason = case when v_method is null then null else i.manual_payment_reason end
    where i.id = v_invoice_id;

  return null;
end;
$$;

drop trigger if exists trg_invoice_payment_method on public.payment_allocations;
create trigger trg_invoice_payment_method
  after insert or delete on public.payment_allocations
  for each row execute function public.sync_invoice_payment_method();

-- --- 3. set_invoice_paid gains the reason -----------------------------------
-- DROP FIRST. Adding a parameter creates an OVERLOAD in Postgres, it does not
-- replace: leaving the 2-argument version in place lets PostgREST keep resolving
-- callers to it and silently discard every reason.

drop function if exists public.set_invoice_paid(uuid, boolean);

create or replace function public.set_invoice_paid(
  p_invoice_id uuid,
  p_paid boolean,
  p_manual_payment_reason text default null
)
returns table (payment_id uuid, invoice_state text)
language plpgsql security definer set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_tenant public.tenants%rowtype;
  v_reference text;
  v_payment_id uuid;
  v_payment record;
  v_new_paid numeric(14,3);
  v_new_state public.invoice_states;
  v_grace integer;
  v_method public.payment_methods;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select i.* into v_invoice from public.invoices i where i.id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  select t.* into v_tenant from public.tenants t where t.id = v_invoice.tenant_id;
  v_reference := 'AUTO-INV:' || v_invoice.code;

  if p_paid then
    if v_invoice.balance <= 0 then
      return query select null::uuid, v_invoice.state::text;
      return;
    end if;

    -- The reason decides how the money is recorded as having arrived. An
    -- unmapped or unknown reason falls back to 'cash', which is exactly what
    -- migration 23 always did, so a hand-added reason cannot break settlement.
    select (oli.metadata ->> 'payment_method')::public.payment_methods
      into v_method
    from public.option_list_items oli
    join public.option_lists ol on ol.id = oli.list_id
    where ol.code = 'manual_payment_reasons'
      and oli.value = p_manual_payment_reason
      and oli.is_active;
    v_method := coalesce(v_method, 'cash'::public.payment_methods);

    insert into public.payments (
      code, company_id, tenant_id, unit_id, account_type, method, amount, currency,
      payment_date, reference, note, status
    ) values (
      public.next_payment_code(), v_tenant.company_id, v_invoice.tenant_id, v_invoice.unit_id,
      'commercial_account', v_method, v_invoice.balance, 'KWD',
      -- Dated inside the invoice's own period so month-by-month reporting lines up.
      least(v_invoice.due_date, current_date),
      v_reference, 'Marked paid from invoice ' || v_invoice.code, 'confirmed'
    )
    returning payments.id into v_payment_id;

    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (v_payment_id, v_invoice.id, v_invoice.balance);
  else
    -- Remove only the auto-created payments for this invoice.
    for v_payment in
      select p.id from public.payments p
      where p.tenant_id = v_invoice.tenant_id and p.reference = v_reference
    loop
      -- A confirmed payment gets a receipt from a trigger; drop it first or
      -- the receipts FK blocks the delete.
      delete from public.receipts r where r.payment_id = v_payment.id;
      delete from public.payment_allocations pa where pa.payment_id = v_payment.id;
      delete from public.payments p where p.id = v_payment.id;
    end loop;
    v_payment_id := null;
  end if;

  -- Recompute the invoice from its surviving allocations.
  select coalesce(sum(pa.amount), 0) into v_new_paid
  from public.payment_allocations pa where pa.invoice_id = v_invoice.id;
  select c.grace_days into v_grace from public.contracts c where c.id = v_invoice.contract_id;

  v_new_state := case
    when v_new_paid >= v_invoice.total then 'paid'
    when v_new_paid > 0 then 'partially_paid'
    when (v_invoice.due_date + coalesce(v_grace, 0)) < current_date then 'overdue'
    else 'due'
  end;

  -- `balance` is a generated column (total - paid); assigning it is rejected.
  -- payment_method is owned by trg_invoice_payment_method and deliberately not
  -- set here; the reason is cleared on the way out because an invoice nobody
  -- settled by hand has no reason for having been settled by hand.
  update public.invoices i
    set paid = v_new_paid,
        state = v_new_state,
        manual_payment_reason = case when p_paid then p_manual_payment_reason else null end
    where i.id = v_invoice.id;

  return query select v_payment_id, v_new_state::text;
end;
$$;

-- Grants do NOT carry across signatures, and anon holds its own grant separate
-- from PUBLIC — migration 96 exists precisely because revoking from PUBLIC left
-- anon able to execute money-moving definer functions.
revoke all on function public.set_invoice_paid(uuid, boolean, text) from public, anon;
grant execute on function public.set_invoice_paid(uuid, boolean, text) to authenticated, service_role;

revoke all on function public.sync_invoice_payment_method() from public, anon;
