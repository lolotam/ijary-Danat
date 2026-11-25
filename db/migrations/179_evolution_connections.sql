-- 179_evolution_connections.sql
-- Stores the paired Evolution API (WhatsApp QR) session for the deployment.
--
-- A singleton row (id = 1): this is a single-company app with one WhatsApp
-- number, and making the row a singleton is what keeps the provider config and
-- the paired session from ever disagreeing about the instance name — server
-- code reads the name from here, never from provider_configs.
--
-- `webhook_secret` authenticates Evolution's webhook calls to
-- /api/public/evolution-webhook. `previous_webhook_secret` exists so rotation
-- is race-free: the new secret is configured on Evolution first, and until
-- that succeeds the webhook keeps accepting the old one.

create table if not exists public.evolution_connections (
  id int primary key default 1 check (id = 1),
  instance_name text not null default 'danat',
  -- Shared secret Evolution sends back as the x-danat-webhook-secret header.
  -- Deliberately excluded from the `authenticated` grant below.
  webhook_secret text not null,
  previous_webhook_secret text,
  connected_number text,
  last_connection_state text,
  -- QR codes are pairing credentials: served to the admin only through a
  -- server function, cleared once the session opens or disconnects.
  last_qr text,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.evolution_connections enable row level security;

drop policy if exists "Allow admins to view evolution connection" on public.evolution_connections;

-- Admins need to see *whether* a session is paired, which number, and its
-- state. They never need the webhook secret or the QR payload; the column
-- grant below is what actually enforces that.
create policy "Allow admins to view evolution connection"
  on public.evolution_connections
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- REVOKE FIRST — load-bearing, not belt-and-braces. The Supabase image grants
-- ALL on new public tables to anon/authenticated by default, and a column
-- grant cannot narrow a table-level SELECT (see 53_gmail_connections.sql for
-- the incident that proved it).
revoke all on public.evolution_connections from anon;
revoke all on public.evolution_connections from authenticated;

-- Column-level grant: webhook secrets and the QR are absent, so `select *` as
-- an end user is a permission error rather than a leak.
grant select (
  id,
  instance_name,
  connected_number,
  last_connection_state,
  connected_at,
  created_at,
  updated_at
) on public.evolution_connections to authenticated;
grant all on public.evolution_connections to service_role;

-- Keeps updated_at honest; tg_set_updated_at is defined in 01_schema_core.sql.
drop trigger if exists evolution_connections_set_updated_at on public.evolution_connections;
create trigger evolution_connections_set_updated_at
  before update on public.evolution_connections
  for each row execute function public.tg_set_updated_at();
