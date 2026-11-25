-- 22_batch_features.sql
-- Schema for the July 2026 feature batch:
--   1. Public "landing" bucket for direct image uploads (shops logos, gallery,
--      portal auth background, property images).
--   2. properties.image_url — property card / detail photo.
--   3. commercial_brands.contract_id — optional link from a storefront brand to an
--      active contract (drives store logo on tenant / unit / portal pages).
--   4. companies.portal_bg_url — background image of the /portal/auth page.
--   5. tenant_messages — portal inbox messages (tenant → admin) with optional
--      attachment, surfaced in the Admin Inbox next to contact inquiries.
-- Idempotent.

-- 1. Landing bucket (public read, admin write) --------------------------------
insert into storage.buckets (id, name, public)
values ('landing', 'landing', true)
on conflict (id) do update set public = true;

drop policy if exists landing_public_read on storage.objects;
create policy landing_public_read on storage.objects
  for select to public using (bucket_id = 'landing');

drop policy if exists landing_admin_write on storage.objects;
create policy landing_admin_write on storage.objects
  for all to authenticated
  using (bucket_id = 'landing' and public.has_role(auth.uid(), 'admin'))
  with check (bucket_id = 'landing' and public.has_role(auth.uid(), 'admin'));

-- 2. Property image -----------------------------------------------------------
alter table public.properties
  add column if not exists image_url text;

-- 3. Brand -> contract link ---------------------------------------------------
alter table public.commercial_brands
  add column if not exists contract_id uuid references public.contracts(id) on delete set null;

create index if not exists commercial_brands_contract_id_idx
  on public.commercial_brands (contract_id);

-- 4. Portal auth page background ----------------------------------------------
alter table public.companies
  add column if not exists portal_bg_url text;

-- 5. Tenant messages (Admin Inbox) -------------------------------------------
create table if not exists public.tenant_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sender_profile_id uuid references public.profiles(id) on delete set null,
  subject text,
  body text not null,
  attachment_path text,
  status text not null default 'new' check (status in ('new', 'read', 'archived')),
  created_at timestamptz not null default now()
);

create index if not exists tenant_messages_status_idx on public.tenant_messages (status);
create index if not exists tenant_messages_tenant_idx on public.tenant_messages (tenant_id);

grant select, insert, update, delete on public.tenant_messages to authenticated;
grant all on public.tenant_messages to service_role;

alter table public.tenant_messages enable row level security;

-- Tenants may create + read their own messages.
drop policy if exists tenant_messages_tenant_insert on public.tenant_messages;
create policy tenant_messages_tenant_insert on public.tenant_messages
  for insert to authenticated
  with check (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.tenant_id = tenant_messages.tenant_id
  ));

drop policy if exists tenant_messages_tenant_select on public.tenant_messages;
create policy tenant_messages_tenant_select on public.tenant_messages
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.tenant_id = tenant_messages.tenant_id
  ));

-- Staff can read and manage every message.
drop policy if exists tenant_messages_staff_select on public.tenant_messages;
create policy tenant_messages_staff_select on public.tenant_messages
  for select to authenticated using (public.is_staff(auth.uid()));

drop policy if exists tenant_messages_staff_update on public.tenant_messages;
create policy tenant_messages_staff_update on public.tenant_messages
  for update to authenticated
  using (public.is_staff(auth.uid()))
  with check (public.is_staff(auth.uid()));

drop policy if exists tenant_messages_staff_delete on public.tenant_messages;
create policy tenant_messages_staff_delete on public.tenant_messages
  for delete to authenticated using (public.is_staff(auth.uid()));

drop policy if exists tenant_messages_service_role_all on public.tenant_messages;
create policy tenant_messages_service_role_all on public.tenant_messages
  for all to service_role using (true) with check (true);

-- Attachments bucket (private; staff read via signed URLs, tenants upload own).
insert into storage.buckets (id, name, public)
values ('tenant-messages', 'tenant-messages', false)
on conflict (id) do update set public = false;

drop policy if exists tenant_messages_attachments_select on storage.objects;
create policy tenant_messages_attachments_select on storage.objects
  for select to authenticated
  using (bucket_id = 'tenant-messages' and (
    public.is_staff(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.tenant_id is not null
        and (storage.foldername(name))[1] = p.tenant_id::text
    )
  ));

drop policy if exists tenant_messages_attachments_insert on storage.objects;
create policy tenant_messages_attachments_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'tenant-messages' and exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.tenant_id is not null
      and (storage.foldername(name))[1] = p.tenant_id::text
  ));
