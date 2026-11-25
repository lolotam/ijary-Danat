-- 86_invoice_dispute_and_write_off.sql
--
-- Invoice write-off and dispute flags.
--
-- DECISION (do not redesign): `waived` MEANS WRITTEN OFF. The invoice_states
-- enum has carried `waived` since migration 05 with ZERO writers; it appears
-- only as a read-guard in apply_payment_allocation and regenerate_contract_invoices.
-- This migration is the first writer.
--
-- Dispute is a FLAG, not a state: a disputed invoice keeps its real state
-- (due / overdue / partially_paid / …) and stays in A/R aging. Disputed_at is
-- set/cleared without touching state or balance.

------------------------------------------------------------
-- 1. Columns on public.invoices
------------------------------------------------------------

alter table public.invoices
  add column if not exists disputed_at timestamptz;

alter table public.invoices
  add column if not exists dispute_reason text;

alter table public.invoices
  add column if not exists disputed_by uuid references auth.users(id) on delete set null;

do $$ begin
  alter table public.invoices
    add constraint invoices_dispute_needs_reason
    check (disputed_at is null or nullif(trim(dispute_reason), '') is not null);
exception when duplicate_object then null;
end $$;

create index if not exists invoices_disputed_at_idx
  on public.invoices (disputed_at)
  where disputed_at is not null;

comment on column public.invoices.disputed_at is
  'Dispute is a flag, not a state. When set, the invoice keeps its real state and stays in A/R aging. Cleared by clear_invoice_dispute.';

------------------------------------------------------------
-- 2. write_off_invoice — first writer of state = waived
------------------------------------------------------------

-- DO NOT TOUCH `paid`. Migration 55 records that migration 52 wrote `paid`
-- without backing allocations and the next set_invoice_paid recomputed it from
-- surviving allocations and silently zeroed it. Leaving `paid` alone keeps
-- `balance` (generated as total - paid) as the written-off amount, which is
-- what a close-out statement must print.
--
-- A PARTIALLY PAID invoice CAN be written off for its remaining balance — that
-- is the normal case. Do NOT copy regenerate_contract_invoices' skip rule here.

create or replace function public.write_off_invoice(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.write_off') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A write-off reason is required';
  end if;

  select i.* into v_invoice
  from public.invoices i where i.id = p_invoice_id
  for update;
  if not found then raise exception 'Invoice not found'; end if;

  if v_invoice.state in ('paid', 'cancelled', 'waived') then
    raise exception 'Invoice cannot be written off in its current state';
  end if;
  if v_invoice.balance <= 0 then
    raise exception 'Invoice has no remaining balance to write off';
  end if;

  -- paid is intentionally left alone (see file header / migration 55 note).
  update public.invoices i
     set state = 'waived'::public.invoice_states
   where i.id = v_invoice.id;

  perform public.write_audit(
    'invoice.write_off',
    'invoice',
    v_invoice.id,
    to_jsonb(v_invoice),
    jsonb_build_object(
      'state', 'waived',
      'reason', trim(p_reason),
      'balance_written_off', v_invoice.balance
    ),
    'success',
    null
  );

  insert into public.contract_operational_events (
    contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    v_invoice.contract_id,
    v_invoice.tenant_id,
    'invoice_written_off',
    auth.uid(),
    jsonb_build_object(
      'invoice_id', v_invoice.id,
      'balance_written_off', v_invoice.balance
    ),
    trim(p_reason)
  );
end;
$$;

revoke all on function public.write_off_invoice(uuid, text) from public, anon;
grant execute on function public.write_off_invoice(uuid, text)
  to authenticated, service_role;

------------------------------------------------------------
-- 3. set_invoice_dispute / clear_invoice_dispute — flag only
------------------------------------------------------------

create or replace function public.set_invoice_dispute(p_invoice_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.dispute') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'A dispute reason is required';
  end if;

  select i.* into v_invoice
  from public.invoices i where i.id = p_invoice_id
  for update;
  if not found then raise exception 'Invoice not found'; end if;

  -- Must NOT change state or balance — dispute is a flag, not a state.
  update public.invoices i
     set disputed_at = now(),
         dispute_reason = trim(p_reason),
         disputed_by = auth.uid()
   where i.id = v_invoice.id;

  perform public.write_audit(
    'invoice.dispute',
    'invoice',
    v_invoice.id,
    to_jsonb(v_invoice),
    jsonb_build_object(
      'disputed', true,
      'dispute_reason', trim(p_reason)
    ),
    'success',
    null
  );

  insert into public.contract_operational_events (
    contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    v_invoice.contract_id,
    v_invoice.tenant_id,
    'invoice_disputed',
    auth.uid(),
    jsonb_build_object('invoice_id', v_invoice.id),
    trim(p_reason)
  );
end;
$$;

revoke all on function public.set_invoice_dispute(uuid, text) from public, anon;
grant execute on function public.set_invoice_dispute(uuid, text)
  to authenticated, service_role;

create or replace function public.clear_invoice_dispute(p_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.dispute') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select i.* into v_invoice
  from public.invoices i where i.id = p_invoice_id
  for update;
  if not found then raise exception 'Invoice not found'; end if;

  if v_invoice.disputed_at is null then
    raise exception 'Invoice is not disputed';
  end if;

  -- Must NOT change state or balance.
  update public.invoices i
     set disputed_at = null,
         dispute_reason = null,
         disputed_by = null
   where i.id = v_invoice.id;

  perform public.write_audit(
    'invoice.dispute_clear',
    'invoice',
    v_invoice.id,
    to_jsonb(v_invoice),
    jsonb_build_object('disputed', false),
    'success',
    null
  );

  insert into public.contract_operational_events (
    contract_id, tenant_id, event_type, actor_id, payload, note
  ) values (
    v_invoice.contract_id,
    v_invoice.tenant_id,
    'dispute_cleared',
    auth.uid(),
    jsonb_build_object('invoice_id', v_invoice.id),
    null
  );
end;
$$;

revoke all on function public.clear_invoice_dispute(uuid) from public, anon;
grant execute on function public.clear_invoice_dispute(uuid)
  to authenticated, service_role;
