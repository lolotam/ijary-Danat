-- 159_manual_payment_method.sql
--
-- Marking an invoice paid with the reason "Audit / data adjustment" recorded the
-- settling payment as **Cash**, so reporting could not tell a real cash payment
-- from a bookkeeping correction.
--
-- The cause is a mapping, not a bug in the code path: migration 108 seeded
-- `manual_payment_reasons.audit_adjustment` with `{"payment_method": "cash"}`,
-- because `public.payment_methods` had no value that could represent it. Every
-- reason had to land on some existing tender type, and `cash` was the catch-all.
--
-- This migration removes the need for that indirection. The admin now picks the
-- method itself, from the same catalog the Add Payment form uses, and the RPC
-- records it directly. The reason lookup stays as the fallback so callers that
-- still pass only a reason keep working across the deploy window.
--
-- Ordering matters: the new enum value is added in its own statement, before
-- anything uses it. Postgres refuses to use a new enum value inside the
-- transaction that added it, and the apply paths here (psql per statement, and
-- scripts/test-db.sh) are autocommit, so each statement commits before the next.

-- --- 1. the new tender type -------------------------------------------------

alter type public.payment_methods add value if not exists 'audit_adjustment';

-- --- 2. offer it in the Payment Method catalog -------------------------------
--
-- `admin.payments.tsx` reads the `payment_methods` option list via
-- `useListDrivenOptions`, falling back to a hardcoded array only when the list
-- is empty. Production's list has rows, so the list is authoritative and a new
-- enum value would not appear in either dropdown without this insert.
--
-- Same shape as migration 21's reconciliation of this list: `is_system` so the
-- catalog guard (migrations 60/61) treats it as a platform row, and a scoped
-- `on conflict do nothing` so re-applying the migration cannot resurrect an item
-- an admin deliberately disabled.

do $$
declare
  _list uuid;
begin
  select id into _list from public.option_lists where code = 'payment_methods';
  if _list is not null then
    insert into public.option_list_items (list_id, value, label_ar, label_en, sort_order, is_system)
      values (_list, 'audit_adjustment', 'تدقيق / تعديل بيانات', 'Audit / data adjustment', 60, true)
      on conflict (list_id, value) do nothing;
  end if;
end $$;

-- --- 3. point the reason at its own method -----------------------------------
--
-- Only for installations still on the reason-driven path. `complete_partial_payment`
-- keeps mapping to `cash` deliberately: a complete or partial payment handed over
-- in person genuinely is cash unless the admin says otherwise, and now they can.

update public.option_list_items oli
  set metadata = jsonb_set(coalesce(oli.metadata, '{}'::jsonb),
                           '{payment_method}', '"audit_adjustment"'::jsonb)
  from public.option_lists ol
 where ol.id = oli.list_id
   and ol.code = 'manual_payment_reasons'
   and oli.value = 'audit_adjustment';

-- --- 4. settle with an explicit method ---------------------------------------
--
-- `create or replace function` cannot add a parameter — it would create a second
-- overload, and a 3-argument call would then match both, which PostgREST rejects
-- as ambiguous. The old bundle calls with 3 arguments until the deploy swaps, so
-- the drop-and-create below is what keeps that window working, and `p_method`
-- defaults to null so a 3-argument call still resolves.
--
-- Dropping also drops the grants, which `create or replace` would have kept.
-- They are re-issued at the end; migration 142 broke `has_permission` for `anon`
-- by re-issuing a function and forgetting exactly that.

drop function if exists public.set_invoice_paid(uuid, boolean, text);

create function public.set_invoice_paid(
  p_invoice_id uuid,
  p_paid boolean,
  p_manual_payment_reason text default null,
  p_method text default null
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

    -- Same contract, earlier period, still payable. Waived/cancelled are not
    -- unpaid; a later invoice on a different contract is not this contract's
    -- debt. Compared as (year, month) so January always precedes February
    -- regardless of due_date quirks.
    if exists (
      select 1
      from public.invoices earlier
      where earlier.contract_id = v_invoice.contract_id
        and earlier.id <> v_invoice.id
        and earlier.balance > 0
        and earlier.state in ('due', 'overdue', 'partially_paid')
        and (earlier.period_year, earlier.period_month)
            < (v_invoice.period_year, v_invoice.period_month)
    ) then
      raise exception 'Invoices must be paid in chronological order.';
    end if;

    -- A gateway method means money moved through MyFatoorah and left a
    -- transaction behind. Nothing did here — an admin typed this — so accepting
    -- one would manufacture a payment that reconciliation can never match.
    if p_method is not null
       and p_method in ('payment_link', 'knet', 'card', 'applepay', 'googlepay') then
      raise exception 'Gateway payment methods cannot be recorded manually: %', p_method
        using errcode = '22023';
    end if;

    -- Precedence: an explicit method wins, because the admin chose it for this
    -- invoice. The reason catalog is consulted only when no method was passed,
    -- which is what a caller on the previous bundle does. `cash` stays the final
    -- fallback so an admin-added reason with no mapping cannot block settlement.
    if p_method is not null then
      v_method := p_method::public.payment_methods;
    else
      select (oli.metadata ->> 'payment_method')::public.payment_methods
        into v_method
      from public.option_list_items oli
      join public.option_lists ol on ol.id = oli.list_id
      where ol.code = 'manual_payment_reasons'
        and oli.value = p_manual_payment_reason
        and oli.is_active;
    end if;
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
  --
  -- The reason now falls back to the method: the dialog sends one value, and
  -- both columns should describe the same event rather than one of them going
  -- blank because the admin answered with a method instead of a reason.
  update public.invoices i
    set paid = v_new_paid,
        state = v_new_state,
        manual_payment_reason = case
          when p_paid then coalesce(p_manual_payment_reason, p_method)
          else null
        end
    where i.id = v_invoice.id;

  return query select v_payment_id, v_new_state::text;
end;
$$;

-- `revoke from public` does not reach anon: it holds its own grant (migration 96),
-- and a drop-and-create starts from the default ALL-to-PUBLIC that Supabase applies.
revoke all on function public.set_invoice_paid(uuid, boolean, text, text) from public, anon;
grant execute on function public.set_invoice_paid(uuid, boolean, text, text)
  to authenticated, service_role;

-- --- 5. a reversed payment is not how the invoice was settled ----------------
--
-- Pre-existing bug, found by writing a regression test for this change.
--
-- `trg_invoice_payment_method` fires on `payment_allocations` only. Reversing a
-- payment inserts a mirror allocation — which fires the trigger while the
-- original is still `confirmed`, so the invoice is stamped with the method being
-- taken back — and *then* sets the original to `status = 'reversed'` in an
-- UPDATE on `public.payments`, which nothing is listening to. The invoice was
-- therefore left advertising the method of money it no longer holds.
--
-- The selection predicate was already right: both the original and its mirror
-- end at `status = 'reversed'`, so `status = 'confirmed'` excludes them. What was
-- missing is a reason to recompute. This adds that trigger.

create or replace function public.sync_invoice_payment_method_for_payment()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- Every invoice this payment touched, recomputed from whatever money is still
  -- standing against it. Statement-level would be cheaper, but the row trigger
  -- keeps this identical in shape to the allocation-level one it mirrors, and a
  -- payment rarely spans more than a handful of invoices.
  update public.invoices i
    set payment_method = (
          select p.method::text
          from public.payment_allocations pa
          join public.payments p on p.id = pa.payment_id
          where pa.invoice_id = i.id
            and p.status = 'confirmed'
          order by p.payment_date desc, p.created_at desc
          limit 1
        )
    where i.id in (
      select pa.invoice_id from public.payment_allocations pa where pa.payment_id = new.id
    );

  -- `manual_payment_reason` describes a settlement made by hand. Once that
  -- payment no longer stands the reason is stale — even when some *other*
  -- payment still settles the invoice, which is why this cannot key off
  -- `payment_method is null`: that would leave a hand-settlement reason attached
  -- to money somebody else actually paid.
  --
  -- `set_invoice_paid` stamps its payment with `AUTO-INV:<invoice code>`, so a
  -- surviving confirmed payment carrying that reference is the only thing that
  -- earns the reason its place.
  update public.invoices i
    set manual_payment_reason = null
    where i.id in (
        select pa.invoice_id from public.payment_allocations pa where pa.payment_id = new.id
      )
      and not exists (
        select 1
        from public.payment_allocations pa
        join public.payments p on p.id = pa.payment_id
        where pa.invoice_id = i.id
          and p.status = 'confirmed'
          and p.reference = 'AUTO-INV:' || i.code
      );

  return null;
end;
$$;

-- A trigger function is never called over PostgREST, but `anon` still receives
-- EXECUTE by default on a new function and `anonExecute.sqltest.ts` enforces that
-- only the three RLS helpers keep it. Matches migration 108's revoke on the
-- allocation-level sibling.
revoke all on function public.sync_invoice_payment_method_for_payment() from public, anon;

drop trigger if exists trg_payment_status_invoice_method on public.payments;
create trigger trg_payment_status_invoice_method
  after update of status on public.payments
  for each row
  when (old.status is distinct from new.status)
  execute function public.sync_invoice_payment_method_for_payment();

comment on column public.invoices.manual_payment_reason is
  'Why this invoice was settled by hand. Holds an option_list_items.value from manual_payment_reasons, or — since migration 159, when the admin answered with a method instead — a public.payment_methods value. Set only on a manual settlement; cleared when the last allocation goes away.';
