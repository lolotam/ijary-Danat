-- 41_invoice_years.sql
-- Registry of selectable years for the Monthly Invoices page.
--
-- The Monthly Invoices overview shows a year dropdown. Years that already have
-- invoices are derived from invoices.period_year; this table lets an operator
-- register additional past/future years that have no invoices yet (so they show
-- up in the dropdown). By design a year is ADD-ONLY: there is no delete policy,
-- so once registered a year can never be removed.
--
-- Adding a year is gated by the `invoices.create` permission (same right that
-- generates invoices). Reads are open to any authenticated user.
-- Idempotent.

create table if not exists public.invoice_years (
  year int primary key,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null
);

alter table public.invoice_years enable row level security;

-- Any authenticated user may read the registry.
drop policy if exists invoice_years_read on public.invoice_years;
create policy invoice_years_read on public.invoice_years
  for select to authenticated
  using (true);

-- Adding a year requires invoices.create. No update/delete policy exists, so
-- rows are permanent (RLS denies by default for uncovered commands).
drop policy if exists invoice_years_insert_perm on public.invoice_years;
create policy invoice_years_insert_perm on public.invoice_years
  for insert to authenticated
  with check (public.has_permission(auth.uid(), 'invoices.create'));

grant select, insert on public.invoice_years to authenticated;
grant all on public.invoice_years to service_role;
