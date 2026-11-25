-- 53_gmail_connections.sql
-- Stores the OAuth grant for the mailbox synced into the unified inbox.
--
-- Before this, connecting a mailbox meant hand-minting a refresh token and
-- redeploying with GMAIL_REFRESH_TOKEN set. An admin can now connect and
-- disconnect Gmail from /admin/settings/integrations, and the sync worker
-- (src/fns/gmailSyncJob.ts) reads the stored grant, falling back to the
-- environment variable so an already-wired deployment keeps working.

create table if not exists public.gmail_connections (
  id uuid primary key default gen_random_uuid(),
  -- One connected mailbox per deployment; reconnecting replaces the grant
  -- rather than accumulating stale tokens.
  company_id uuid not null unique references public.companies(id) on delete cascade,
  email_address text not null,
  -- Long-lived credential granting read access to the mailbox. Deliberately
  -- excluded from the `authenticated` grant below.
  refresh_token text not null,
  scope text,
  token_type text,
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz not null default now(),
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.gmail_connections enable row level security;

drop policy if exists "Allow admins to view gmail connections" on public.gmail_connections;
drop policy if exists "Allow admins to disconnect gmail" on public.gmail_connections;

-- Admins need to see *whether* a mailbox is connected, which address, and how
-- the last sync went. They never need the token, and the column grant below is
-- what actually enforces that — a policy alone would expose every column.
create policy "Allow admins to view gmail connections"
  on public.gmail_connections
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

create policy "Allow admins to disconnect gmail"
  on public.gmail_connections
  for delete
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- REVOKE FIRST — this is not belt-and-braces, it is load-bearing.
--
-- The Supabase image ships
--   alter default privileges in schema public grant all on tables to anon, authenticated, service_role
-- so every new table in `public` arrives with FULL table-level privileges for
-- anon and authenticated already granted. A column-level GRANT does not narrow
-- that: table-level SELECT wins, and `select refresh_token` succeeds. Verified
-- the hard way — src/db/gmail.sqltest.ts asserted the token was unreadable and
-- failed, printing the token, until this revoke was added.
revoke all on public.gmail_connections from anon;
revoke all on public.gmail_connections from authenticated;

-- Column-level grant: `refresh_token` is absent, so `select *` as an end user
-- is a permission error rather than a leak. Writing the grant this way means a
-- compromised anon/publishable key still cannot read the credential — only the
-- service-role client (the OAuth callback and the sync worker) can.
grant select (
  id,
  company_id,
  email_address,
  scope,
  token_type,
  connected_by,
  connected_at,
  last_synced_at,
  last_sync_error,
  created_at,
  updated_at
) on public.gmail_connections to authenticated;
grant delete on public.gmail_connections to authenticated;
grant all on public.gmail_connections to service_role;

-- Keeps updated_at honest; tg_set_updated_at is defined in 01_schema_core.sql.
drop trigger if exists gmail_connections_set_updated_at on public.gmail_connections;
create trigger gmail_connections_set_updated_at
  before update on public.gmail_connections
  for each row execute function public.tg_set_updated_at();
