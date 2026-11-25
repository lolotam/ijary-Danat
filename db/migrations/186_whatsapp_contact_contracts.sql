-- 186_whatsapp_contact_contracts.sql
-- Links a WhatsApp contact to one or more contracts (many-to-many). The
-- contact form picks a tenant, then any of that tenant's contracts; the
-- contacts table shows the linked contract codes as clickable chips.
--
-- ON DELETE CASCADE both ways: removing a contact or a contract silently
-- drops the link — the link is a pointer, never data of its own.
--
-- Same access model as the other whatsapp tables (180): clients read with
-- notifications.read, and every write goes through server fns with the
-- service role. Idempotent.

create table if not exists public.whatsapp_contact_contracts (
  contact_id uuid not null references public.whatsapp_contacts(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (contact_id, contract_id)
);

alter table public.whatsapp_contact_contracts enable row level security;

drop policy if exists "Allow notification staff to read whatsapp contact contracts"
  on public.whatsapp_contact_contracts;
create policy "Allow notification staff to read whatsapp contact contracts"
  on public.whatsapp_contact_contracts
  for select
  to authenticated
  using (public.has_permission(auth.uid(), 'notifications.read'));

-- REVOKE FIRST — same load-bearing reason as 53/179/180.
revoke all on public.whatsapp_contact_contracts from anon;
revoke all on public.whatsapp_contact_contracts from authenticated;
grant select on public.whatsapp_contact_contracts to authenticated;
grant all on public.whatsapp_contact_contracts to service_role;
