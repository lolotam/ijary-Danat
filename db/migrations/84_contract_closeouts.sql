-- 84_contract_closeouts.sql
--
-- Schema foundation for Contract Close-out (end-of-tenancy workflow).
--
-- Tables only. No RPCs, no triggers that mutate contracts/invoices/refunds —
-- those land in later migrations. Nothing in the app calls these tables yet.
--
-- Status columns use text + CHECK (matching payments.status, concessions.status)
-- rather than new enum types: a new enum value cannot be used in the same
-- transaction that creates it, and one file should stay self-contained.
--
-- GRANTS/REVOKES are load-bearing. Supabase's default privileges grant ALL on
-- every new public table to anon and authenticated. `revoke ... from public`
-- does NOT reach them — they hold their own grants. Migration 78 documents a
-- confirmed production exploit from exactly that omission. Every table below
-- revokes from public, anon, and authenticated by name before the narrow grants.

------------------------------------------------------------
-- 1. contract_closeouts
------------------------------------------------------------

create table if not exists public.contract_closeouts (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete restrict,
  tenant_id   uuid not null references public.tenants(id)   on delete restrict,
  -- Snapshots: a close-out still reads correctly after reassignment/rename.
  unit_id     uuid references public.units(id)     on delete set null,
  building_id uuid references public.buildings(id) on delete set null,
  company_id  uuid references public.companies(id) on delete set null,

  status text not null default 'draft'
    check (status in ('draft', 'completed', 'cancelled')),

  outcome text not null
    check (outcome in ('keep_terminated', 'freeze', 'archive')),

  final_contract_state public.contract_states not null
    check (final_contract_state in ('expired', 'terminated', 'frozen')),

  archive_tenant boolean not null default false,

  move_out_date date not null,

  deposit_held       numeric(14,3) not null default 0 check (deposit_held       >= 0),
  deductions_total   numeric(14,3) not null default 0 check (deductions_total   >= 0),
  settled_total      numeric(14,3) not null default 0 check (settled_total      >= 0),
  written_off_total  numeric(14,3) not null default 0 check (written_off_total  >= 0),
  refund_total       numeric(14,3) not null default 0 check (refund_total       >= 0),
  balance_due_tenant numeric(14,3) not null default 0 check (balance_due_tenant >= 0),

  refund_id uuid references public.refunds(id) on delete set null,
  idempotency_key text not null unique,
  result jsonb,
  contract_updated_at timestamptz,
  note text,

  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  cancelled_by uuid references auth.users(id) on delete set null,
  cancelled_at timestamptz,

  constraint closeout_completed_needs_actor
    check (status <> 'completed' or (completed_by is not null and completed_at is not null)),
  constraint closeout_cancelled_needs_actor
    check (status <> 'cancelled' or (cancelled_by is not null and cancelled_at is not null)),
  constraint closeout_refund_only_when_completed
    check (refund_id is null or status = 'completed'),
  constraint closeout_archive_tenant_needs_archive
    check (not archive_tenant or outcome = 'archive')
);

-- Load-bearing: the three outcomes differ in archived_at, not only in state.
-- A close-out does NOT always archive.
--
--   keep_terminated -> contracts.state = terminated, archived_at stays null
--                      (remains in normal lists)
--   freeze          -> contracts.state = frozen,     archived_at stays null
--                      (remains in normal lists)
--   archive         -> contracts.state = terminated or expired, archived_at = now()
--                      (moves to Archived lists)
comment on column public.contract_closeouts.outcome is
  'Final disposition of the contract. keep_terminated: state=terminated, archived_at null (stays in normal lists). freeze: state=frozen, archived_at null (stays in normal lists). archive: state=terminated|expired, archived_at=now() (moves to Archived lists). A close-out does not always archive.';

comment on column public.contract_closeouts.archive_tenant is
  'Meaningful only when outcome = archive (enforced by closeout_archive_tenant_needs_archive). When true, the tenant is archived alongside the contract.';

-- At most one active draft per contract. A CHECK cannot express a cross-row
-- rule, and a security definer function cannot bypass a unique index.
create unique index if not exists closeouts_one_draft_per_contract
  on public.contract_closeouts (contract_id) where status = 'draft';

create index if not exists contract_closeouts_contract_id_idx
  on public.contract_closeouts (contract_id);
create index if not exists contract_closeouts_tenant_id_idx
  on public.contract_closeouts (tenant_id);
create index if not exists contract_closeouts_status_idx
  on public.contract_closeouts (status);
create index if not exists contract_closeouts_completed_at_idx
  on public.contract_closeouts (completed_at);

drop trigger if exists contract_closeouts_set_updated_at on public.contract_closeouts;
create trigger contract_closeouts_set_updated_at
  before update on public.contract_closeouts
  for each row execute function public.tg_set_updated_at();

-- REVOKE FIRST — load-bearing (see file header / migrations 53 and 78).
revoke all on public.contract_closeouts from public, anon, authenticated;
-- Close-outs are cancelled, never deleted — no delete grant to authenticated.
grant select, insert, update on public.contract_closeouts to authenticated;
grant all on public.contract_closeouts to service_role;

alter table public.contract_closeouts enable row level security;

drop policy if exists contract_closeouts_staff_read on public.contract_closeouts;
create policy contract_closeouts_staff_read on public.contract_closeouts
  for select to authenticated
  using (public.is_staff(auth.uid()));

drop policy if exists contract_closeouts_insert_permitted on public.contract_closeouts;
create policy contract_closeouts_insert_permitted on public.contract_closeouts
  for insert to authenticated
  with check (public.has_permission(auth.uid(), 'contracts.close_out'));

drop policy if exists contract_closeouts_update_permitted on public.contract_closeouts;
create policy contract_closeouts_update_permitted on public.contract_closeouts
  for update to authenticated
  using (public.has_permission(auth.uid(), 'contracts.close_out'))
  with check (public.has_permission(auth.uid(), 'contracts.close_out'));

drop policy if exists contract_closeouts_service_role_all on public.contract_closeouts;
create policy contract_closeouts_service_role_all on public.contract_closeouts
  for all to service_role
  using (true) with check (true);

------------------------------------------------------------
-- 2. contract_closeout_deductions
------------------------------------------------------------

create table if not exists public.contract_closeout_deductions (
  id uuid primary key default gen_random_uuid(),
  closeout_id uuid not null references public.contract_closeouts(id) on delete cascade,
  line integer not null,
  kind text not null check (kind in ('damages', 'cleaning', 'utilities', 'unpaid_rent', 'other')),
  description_ar text,
  description_en text,
  -- amount > 0, not >= 0: a zero deduction is a data-entry error, not a business fact.
  amount numeric(14,3) not null check (amount > 0),
  created_at timestamptz not null default now(),
  unique (closeout_id, line)
);

comment on column public.contract_closeout_deductions.amount is
  'Must be > 0. A zero deduction is a data-entry error, not a business fact.';

create index if not exists contract_closeout_deductions_closeout_id_idx
  on public.contract_closeout_deductions (closeout_id);

revoke all on public.contract_closeout_deductions from public, anon, authenticated;
-- Draft line edits include removing a line — delete is a normal edit here.
grant select, insert, update, delete on public.contract_closeout_deductions to authenticated;
grant all on public.contract_closeout_deductions to service_role;

alter table public.contract_closeout_deductions enable row level security;

drop policy if exists contract_closeout_deductions_staff_read on public.contract_closeout_deductions;
create policy contract_closeout_deductions_staff_read on public.contract_closeout_deductions
  for select to authenticated
  using (public.is_staff(auth.uid()));

drop policy if exists contract_closeout_deductions_insert_permitted on public.contract_closeout_deductions;
create policy contract_closeout_deductions_insert_permitted on public.contract_closeout_deductions
  for insert to authenticated
  with check (public.has_permission(auth.uid(), 'contracts.close_out'));

drop policy if exists contract_closeout_deductions_update_permitted on public.contract_closeout_deductions;
create policy contract_closeout_deductions_update_permitted on public.contract_closeout_deductions
  for update to authenticated
  using (public.has_permission(auth.uid(), 'contracts.close_out'))
  with check (public.has_permission(auth.uid(), 'contracts.close_out'));

drop policy if exists contract_closeout_deductions_delete_permitted on public.contract_closeout_deductions;
create policy contract_closeout_deductions_delete_permitted on public.contract_closeout_deductions
  for delete to authenticated
  using (public.has_permission(auth.uid(), 'contracts.close_out'));

drop policy if exists contract_closeout_deductions_service_role_all on public.contract_closeout_deductions;
create policy contract_closeout_deductions_service_role_all on public.contract_closeout_deductions
  for all to service_role
  using (true) with check (true);

------------------------------------------------------------
-- 3. contract_closeout_invoice_actions
------------------------------------------------------------

create table if not exists public.contract_closeout_invoice_actions (
  id uuid primary key default gen_random_uuid(),
  closeout_id uuid not null references public.contract_closeouts(id) on delete cascade,
  -- on delete restrict matches payment_allocations: an action row must not
  -- silently vanish if someone tries to drop the invoice.
  invoice_id  uuid not null references public.invoices(id) on delete restrict,
  action text not null
    check (action in ('leave', 'settle_from_deposit', 'write_off', 'cancel', 'mark_disputed')),
  amount numeric(14,3) not null default 0 check (amount >= 0),
  -- Stored, not derived: this is what makes a close-out statement reproducible
  -- years later without re-deriving from audit_logs.
  previous_state  public.invoice_states,
  resulting_state public.invoice_states,
  created_at timestamptz not null default now(),
  unique (closeout_id, invoice_id)
);

comment on column public.contract_closeout_invoice_actions.previous_state is
  'Invoice state at the moment the close-out acted. Stored (not derived) so a close-out statement remains reproducible years later without re-deriving from audit_logs.';

comment on column public.contract_closeout_invoice_actions.resulting_state is
  'Invoice state after the close-out action. Stored (not derived) for the same reproducibility reason as previous_state.';

create index if not exists contract_closeout_invoice_actions_closeout_id_idx
  on public.contract_closeout_invoice_actions (closeout_id);
create index if not exists contract_closeout_invoice_actions_invoice_id_idx
  on public.contract_closeout_invoice_actions (invoice_id);

revoke all on public.contract_closeout_invoice_actions from public, anon, authenticated;
grant select, insert, update, delete on public.contract_closeout_invoice_actions to authenticated;
grant all on public.contract_closeout_invoice_actions to service_role;

alter table public.contract_closeout_invoice_actions enable row level security;

drop policy if exists contract_closeout_invoice_actions_staff_read on public.contract_closeout_invoice_actions;
create policy contract_closeout_invoice_actions_staff_read on public.contract_closeout_invoice_actions
  for select to authenticated
  using (public.is_staff(auth.uid()));

drop policy if exists contract_closeout_invoice_actions_insert_permitted on public.contract_closeout_invoice_actions;
create policy contract_closeout_invoice_actions_insert_permitted on public.contract_closeout_invoice_actions
  for insert to authenticated
  with check (public.has_permission(auth.uid(), 'contracts.close_out'));

drop policy if exists contract_closeout_invoice_actions_update_permitted on public.contract_closeout_invoice_actions;
create policy contract_closeout_invoice_actions_update_permitted on public.contract_closeout_invoice_actions
  for update to authenticated
  using (public.has_permission(auth.uid(), 'contracts.close_out'))
  with check (public.has_permission(auth.uid(), 'contracts.close_out'));

drop policy if exists contract_closeout_invoice_actions_delete_permitted on public.contract_closeout_invoice_actions;
create policy contract_closeout_invoice_actions_delete_permitted on public.contract_closeout_invoice_actions
  for delete to authenticated
  using (public.has_permission(auth.uid(), 'contracts.close_out'));

drop policy if exists contract_closeout_invoice_actions_service_role_all on public.contract_closeout_invoice_actions;
create policy contract_closeout_invoice_actions_service_role_all on public.contract_closeout_invoice_actions
  for all to service_role
  using (true) with check (true);

------------------------------------------------------------
-- 4. contract_operational_events
------------------------------------------------------------

-- This is NOT audit_logs.
--
-- audit_logs is forensic, append-only, written by write_audit with request
-- metadata, and read by the Audit screen filtered by actor.
--
-- This is the contract's operational timeline: close-outs started/completed,
-- archive/restore, refund reverse/void, invoice write-off/dispute. It is
-- rendered on the contract detail page. Different audience, different query
-- shape (by contract_id, chronological).
create table if not exists public.contract_operational_events (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  tenant_id   uuid references public.tenants(id) on delete set null,
  closeout_id uuid references public.contract_closeouts(id) on delete set null,
  event_type text not null check (event_type in (
    'closeout_started', 'closeout_cancelled', 'closeout_completed',
    'archived', 'restored', 'refund_reversed', 'refund_voided',
    'invoice_written_off', 'invoice_disputed', 'dispute_cleared'
  )),
  occurred_at timestamptz not null default now(),
  actor_id uuid references auth.users(id) on delete set null,
  payload jsonb,
  note text
);

comment on table public.contract_operational_events is
  'Contract operational timeline (close-outs, archive/restore, refund reverse/void, invoice write-off/dispute), rendered on the contract detail page. NOT audit_logs: audit_logs is forensic, append-only, written by write_audit with request metadata, and read by the Audit screen filtered by actor. Different audience, different query shape.';

create index if not exists contract_operational_events_contract_occurred_idx
  on public.contract_operational_events (contract_id, occurred_at desc);

revoke all on public.contract_operational_events from public, anon, authenticated;
-- Read-only for authenticated staff. No insert/update/delete grant.
grant select on public.contract_operational_events to authenticated;
grant all on public.contract_operational_events to service_role;

alter table public.contract_operational_events enable row level security;

drop policy if exists contract_operational_events_staff_read on public.contract_operational_events;
create policy contract_operational_events_staff_read on public.contract_operational_events
  for select to authenticated
  using (public.is_staff(auth.uid()));

-- READ POLICY ONLY. There is deliberately no insert/update/delete policy for
-- authenticated. The absence IS the deny: later security definer RPCs will
-- write as owner and bypass RLS. Do not "fix" this by adding a write policy.
drop policy if exists contract_operational_events_service_role_all on public.contract_operational_events;
create policy contract_operational_events_service_role_all on public.contract_operational_events
  for all to service_role
  using (true) with check (true);

------------------------------------------------------------
-- 5. Verification — data-independent CHECK invariants
------------------------------------------------------------
-- Style mirrors migration 76 section 9. Counts rows that violate the table
-- CHECKs; on a healthy database (empty or populated) the count is always 0.
-- If someone later drops a constraint, this block fails on the next apply.

do $$
declare
  _bad integer;
begin
  select count(*) into _bad
    from public.contract_closeouts
   where status = 'completed'
     and (completed_by is null or completed_at is null);
  if _bad > 0 then
    raise exception
      'closeout_completed_needs_actor violated for % row(s)', _bad;
  end if;

  select count(*) into _bad
    from public.contract_closeouts
   where status = 'cancelled'
     and (cancelled_by is null or cancelled_at is null);
  if _bad > 0 then
    raise exception
      'closeout_cancelled_needs_actor violated for % row(s)', _bad;
  end if;

  select count(*) into _bad
    from public.contract_closeouts
   where archive_tenant and outcome <> 'archive';
  if _bad > 0 then
    raise exception
      'closeout_archive_tenant_needs_archive violated for % row(s)', _bad;
  end if;

  select count(*) into _bad
    from public.contract_closeouts
   where refund_id is not null and status <> 'completed';
  if _bad > 0 then
    raise exception
      'closeout_refund_only_when_completed violated for % row(s)', _bad;
  end if;
end;
$$;
