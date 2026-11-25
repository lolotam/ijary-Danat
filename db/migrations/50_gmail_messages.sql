-- 50_gmail_messages.sql
-- Inbox consolidation: a unified inbox now hosts tenant messages, visitor
-- (contact) inquiries, leasing leads, and Gmail-synced messages. The first
-- three reuse existing tables; Gmail messages land here.
--
-- Rows are written by the Gmail sync worker (src/fns/gmailSyncJob.ts) which runs
-- on a cron tick via the service-role client (bypasses RLS). Staff read them in
-- the "Gmail" tab of the admin inbox and can mark them read; admins can delete.

create table if not exists public.gmail_messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- Stable per-message key so re-syncing is idempotent. Normally the RFC 822
  -- Message-ID header; when a message carries none, the worker substitutes
  -- 'gmail:' || the Gmail message id, which is always present.
  --
  -- NOT NULL is load-bearing, not decoration: the unique constraint below is
  -- (company_id, message_id), and in Postgres null is never equal to null — so
  -- while this column was nullable, every header-less message re-inserted on
  -- every tick, silently contradicting the idempotency this table promises.
  message_id text not null,
  thread_id text,
  from_address text not null,
  to_address text,
  subject text,
  snippet text,
  body_text text,
  received_at timestamptz not null,
  is_read boolean not null default false,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, message_id)
);

create index if not exists gmail_messages_company_received_idx
  on public.gmail_messages (company_id, received_at desc);

create index if not exists gmail_messages_unread_idx
  on public.gmail_messages (company_id, is_read)
  where is_read = false;

alter table public.gmail_messages enable row level security;

-- Each policy is dropped first so the file stays re-runnable — CREATE POLICY has
-- no IF NOT EXISTS, and without the drops re-applying db/migrations/ aborts here.
-- This is the repo-wide idiom (see 08_phase6_expenses_deposits_budget.sql).
drop policy if exists "Allow staff to view gmail messages" on public.gmail_messages;
drop policy if exists "Allow admins to delete gmail messages" on public.gmail_messages;
drop policy if exists "Allow admins to update gmail messages" on public.gmail_messages;
drop policy if exists "Allow staff to update gmail messages" on public.gmail_messages;

-- Read and mark-read are both staff-level, matching tenant_messages
-- (22_batch_features.sql:81-89) — the inbox renders for any staff member, so
-- gating the update on admin alone made the mark-read button fail silently for
-- accountants and collectors.
create policy "Allow staff to view gmail messages"
  on public.gmail_messages
  for select
  to authenticated
  using (public.is_staff(auth.uid()));

create policy "Allow staff to update gmail messages"
  on public.gmail_messages
  for update
  to authenticated
  using (public.is_staff(auth.uid()))
  with check (public.is_staff(auth.uid()));

-- Deletion stays admin-only, matching contact_inquiries.
create policy "Allow admins to delete gmail messages"
  on public.gmail_messages
  for delete
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

grant select, delete, update on public.gmail_messages to authenticated;
grant all on public.gmail_messages to service_role;
