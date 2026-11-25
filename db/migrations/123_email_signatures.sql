-- 123: Email signatures for the Gmail compose dialog.
--
-- Signatures are per-admin, not per-company: two staff sending from the same
-- shared mailbox still sign as themselves.
--
-- `details` holds the structured fields the builder renders from, and the
-- rendered HTML is stored beside it rather than derived on read, so a sent
-- message and a later preview cannot disagree. `details` is the source of truth
-- for *editing*. The alternative — regex-parsing the stored HTML back into form
-- fields — returns confidently wrong data the moment the markup stops matching
-- the template that produced it, which is why it is not done here.

create table if not exists public.email_signatures (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  content_html text not null default '',
  details jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists email_signatures_admin_idx
  on public.email_signatures (admin_id);

-- One default per admin, enforced by the database. Enforced only in the client,
-- two tabs saving at once leave two defaults and the compose dialog then
-- auto-appends whichever row happens to sort first.
create unique index if not exists email_signatures_one_default_per_admin
  on public.email_signatures (admin_id)
  where is_default;

alter table public.email_signatures enable row level security;

-- Supabase grants ALL on new public tables to anon and authenticated by
-- default, and `revoke ... from public` does not touch grants those roles hold
-- in their own right. Revoke explicitly before granting anything back.
revoke all on public.email_signatures from anon, authenticated;
grant select, insert, update, delete on public.email_signatures to authenticated;

drop policy if exists email_signatures_owner_read on public.email_signatures;
create policy email_signatures_owner_read on public.email_signatures
  for select to authenticated using (admin_id = auth.uid());

drop policy if exists email_signatures_owner_write on public.email_signatures;
create policy email_signatures_owner_write on public.email_signatures
  for all to authenticated
  using (admin_id = auth.uid())
  with check (admin_id = auth.uid());

-- Setting a default is two writes — clear the old one, set the new one — and
-- two client mutations are not atomic. If the second fails, the admin is left
-- with no default at all; and two tabs can both clear and then race, with one
-- hitting the unique index above. One function, one transaction.
create or replace function public.set_default_email_signature(_signature_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- security invoker plus RLS means a caller can only ever reach their own
  -- rows; the admin_id filter is belt-and-braces, not the boundary.
  update public.email_signatures
     set is_default = false, updated_at = now()
   where admin_id = auth.uid() and is_default;

  update public.email_signatures
     set is_default = true, updated_at = now()
   where id = _signature_id and admin_id = auth.uid();

  if not found then
    raise exception 'Signature % not found for the current user', _signature_id;
  end if;
end;
$$;

-- New functions are executable by anon and authenticated by default, and
-- `revoke ... from public` does not touch the grants those roles hold in their
-- own right. This one is security invoker so RLS still contains it, but anon
-- has no business calling it at all.
revoke all on function public.set_default_email_signature(uuid) from public, anon;
grant execute on function public.set_default_email_signature(uuid) to authenticated;

-- Signature logos reuse the existing public `branding` bucket (migration 21)
-- under a signatures/ prefix. A logo is an <img src> in a message that lands in
-- an unauthenticated inbox, so it has to be public-read; `branding` already is
-- (`branding_public_read ... for select to public`) and already carries an
-- admin-write policy. A new bucket would need both policies restated and would
-- add another directory to the xattr-preserving backup burden that broke every
-- image in the July 2026 server move. No storage changes are needed here.
