-- 163_contract_extra_charges.sql
--
-- Task 4: a contract can carry recurring monthly charges beyond rent —
-- cleaning, security, service — each classified by an expense category and
-- each billed on every invoice the contract raises.
--
-- This file is schema only. 164 teaches the two functions that price a period
-- from scratch to read it, 165 does the same for the two that reprice an
-- existing invoice, and 166 teaches the save RPC to write it. Four files
-- because the bodies are verbatim copies of long plpgsql functions and one file
-- would blow past the 500-600 line ceiling; and because this one is then safe
-- to apply while the old bundle is still serving, an empty table changing
-- nothing about what anyone is billed.

------------------------------------------------------------------------
-- 1. Table
------------------------------------------------------------------------
create table if not exists public.contract_extra_charges (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  -- `restrict`, not `set null` or `cascade`: a category disappearing would
  -- otherwise silently change what every future invoice bills, or silently
  -- stop billing it. Deleting a category that is still priced into a live
  -- lease should fail loudly and make someone decide.
  category_id uuid not null references public.expense_categories(id) on delete restrict,
  amount numeric(14,3) not null check (amount > 0),
  line_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One charge per category per contract. Two "cleaning" rows would render as
  -- two identical invoice lines that no one can tell apart on a PDF; an
  -- operator who wants 150 instead of 100 must edit the row, not add another.
  constraint contract_extra_charges_contract_category_unique unique (contract_id, category_id)
);

create index if not exists contract_extra_charges_contract_idx
  on public.contract_extra_charges (contract_id);

drop trigger if exists set_updated_at on public.contract_extra_charges;
create trigger set_updated_at before update on public.contract_extra_charges
  for each row execute function public.tg_set_updated_at();

------------------------------------------------------------------------
-- 2. Grants and RLS — mirrors public.contract_units (migration 110)
------------------------------------------------------------------------
-- REVOKE before GRANT: Supabase default privileges grant ALL on any new public
-- table to anon and authenticated, so a bare GRANT leaves write access already
-- in place underneath. This table decides what tenants are charged.
revoke all on public.contract_extra_charges from public, anon, authenticated;
grant select, insert, update, delete on public.contract_extra_charges to authenticated;
grant all on public.contract_extra_charges to service_role;

alter table public.contract_extra_charges enable row level security;

-- Per-operation split and the contracts.* permission codes, matching
-- contract_units exactly: an extra charge is part of the contract's terms, so
-- whoever may edit the contract may edit its charges — not a separate right.
drop policy if exists contract_extra_charges_select_permitted on public.contract_extra_charges;
create policy contract_extra_charges_select_permitted on public.contract_extra_charges
  for select to authenticated
  using (public.has_permission(auth.uid(), 'contracts.read'));

drop policy if exists contract_extra_charges_insert_permitted on public.contract_extra_charges;
create policy contract_extra_charges_insert_permitted on public.contract_extra_charges
  for insert to authenticated
  with check (public.has_permission(auth.uid(), 'contracts.create'));

drop policy if exists contract_extra_charges_update_permitted on public.contract_extra_charges;
create policy contract_extra_charges_update_permitted on public.contract_extra_charges
  for update to authenticated
  using (public.has_permission(auth.uid(), 'contracts.update'))
  with check (public.has_permission(auth.uid(), 'contracts.update'));

drop policy if exists contract_extra_charges_delete_permitted on public.contract_extra_charges;
create policy contract_extra_charges_delete_permitted on public.contract_extra_charges
  for delete to authenticated
  using (public.has_permission(auth.uid(), 'contracts.delete'));

drop policy if exists contract_extra_charges_service_role on public.contract_extra_charges;
create policy contract_extra_charges_service_role on public.contract_extra_charges
  for all to service_role using (true) with check (true);

------------------------------------------------------------------------
-- 3. contract_extra_charges_total — one definition of "the extras"
------------------------------------------------------------------------
-- Four separate functions price an invoice (generate_invoices_for_year,
-- contract_period_amounts, regenerate_contract_invoices and
-- sync_contract_invoice_schedule). Each of them needs this sum, and four
-- hand-copied `select coalesce(sum(...), 0)` bodies is four places for them to
-- drift apart — which is exactly how this database ended up with a rent total
-- that three functions computed and a fourth did not.
--
-- `contracts.monthly_amount` is deliberately NOT widened to include this. That
-- column is the trigger-maintained total of contract_units (migration 110) and
-- is read across the contract list and the reports as the RENT. Folding
-- service charges into it would misstate every one of those without a single
-- error anywhere. Rent and extras meet on the invoice, not before it.
create or replace function public.contract_extra_charges_total(p_contract_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(ec.amount), 0)::numeric(14,3)
    from public.contract_extra_charges ec
   where ec.contract_id = p_contract_id;
$$;

-- Not granted to `authenticated`, for the same reason as
-- `append_extra_charge_items` (migration 164): it is SECURITY DEFINER with no
-- permission check of its own, so as a reachable RPC it would report any
-- contract's charge total to any signed-in user, RLS notwithstanding. The four
-- pricing functions still call it -- inside a SECURITY DEFINER body EXECUTE is
-- checked against the owner, not the invoker.
revoke execute on function public.contract_extra_charges_total(uuid)
  from public, anon, authenticated;
grant execute on function public.contract_extra_charges_total(uuid) to service_role;
