-- Create contact_inquiries table
create table if not exists public.contact_inquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text not null,
  subject text,
  message text not null,
  created_at timestamptz not null default now()
);

-- Enable RLS
alter table public.contact_inquiries enable row level security;

-- Policies. Each is dropped first so the file stays re-runnable — CREATE POLICY
-- has no IF NOT EXISTS, and without the drops re-applying db/migrations/ aborts
-- here. This is the repo-wide idiom (see 08_phase6_expenses_deposits_budget.sql).
drop policy if exists "Allow public insertion of contact inquiries" on public.contact_inquiries;
drop policy if exists "Allow staff to view contact inquiries" on public.contact_inquiries;
drop policy if exists "Allow admins to delete contact inquiries" on public.contact_inquiries;

-- 1. Anyone (anon) can insert inquiries
create policy "Allow public insertion of contact inquiries"
  on public.contact_inquiries
  for insert
  with check (true);

-- 2. Only staff (admin, accountant, collector) can select contact inquiries
create policy "Allow staff to view contact inquiries"
  on public.contact_inquiries
  for select
  using (
    public.has_role(auth.uid(), 'admin') or 
    public.has_role(auth.uid(), 'accountant') or 
    public.has_role(auth.uid(), 'collector')
  );

-- 3. Only admins can delete contact inquiries
create policy "Allow admins to delete contact inquiries"
  on public.contact_inquiries
  for delete
  using (public.has_role(auth.uid(), 'admin'));

-- Grants
grant insert on public.contact_inquiries to anon;
grant insert, select, delete on public.contact_inquiries to authenticated;
grant all on public.contact_inquiries to service_role;
