-- 180_whatsapp_inbox.sql
-- WhatsApp inbox storage for the Evolution API integration: messages, chats
-- and contacts, plus the transactional ingestion RPC the webhook and the
-- outbound delivery layer share.
--
-- Single-tenant on purpose (no user_id scoping): this is one company's one
-- WhatsApp number, read by staff who hold notifications.read. Read state is
-- global per chat — a small admin team shares one unread counter, and that
-- limitation is accepted (a per-user read table can follow if the team grows).

------------------------------------------------------------
-- Tables
------------------------------------------------------------

create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  -- Provider message id; the idempotency key for webhook replays and for the
  -- outbound-echo dedupe (dispatcher records the send, the fromMe webhook
  -- upserts the same id and is ignored).
  message_id text not null unique,
  -- Bare international digits; the conversation key. Never a JID.
  chat_number text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  from_me boolean not null default false,
  body text,
  message_type text not null default 'text',
  media_type text,
  media_id text,
  media_filename text,
  sent_at timestamptz not null default now(),
  status text not null default 'sent',
  -- Allow-listed diagnostic subset of the webhook payload (key, type,
  -- timestamps). Never the full body: Evolution payloads can embed base64.
  raw jsonb,
  created_at timestamptz not null default now()
);

-- Keyset pagination for the thread view: compound (sent_at, id) cursor.
create index if not exists whatsapp_messages_chat_sent_idx
  on public.whatsapp_messages (chat_number, sent_at desc, id desc);

create table if not exists public.whatsapp_chats (
  chat_number text primary key,
  display_name text,
  last_message_preview text,
  last_message_at timestamptz,
  unread_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  -- Bare international digits, same normalisation as whatsapp_chats.chat_number.
  phone text not null unique,
  name text,
  email text,
  notes text,
  tags text[] not null default '{}',
  tenant_id uuid references public.tenants(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

------------------------------------------------------------
-- RLS + grants: clients read (permission-gated); only service_role writes.
-- All writes go through server functions so permission checks and the
-- ingestion transaction cannot be bypassed from the browser.
------------------------------------------------------------

alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_chats enable row level security;
alter table public.whatsapp_contacts enable row level security;

drop policy if exists "Allow notification staff to read whatsapp messages" on public.whatsapp_messages;
create policy "Allow notification staff to read whatsapp messages"
  on public.whatsapp_messages
  for select
  to authenticated
  using (public.has_permission(auth.uid(), 'notifications.read'));

drop policy if exists "Allow notification staff to read whatsapp chats" on public.whatsapp_chats;
create policy "Allow notification staff to read whatsapp chats"
  on public.whatsapp_chats
  for select
  to authenticated
  using (public.has_permission(auth.uid(), 'notifications.read'));

drop policy if exists "Allow notification staff to read whatsapp contacts" on public.whatsapp_contacts;
create policy "Allow notification staff to read whatsapp contacts"
  on public.whatsapp_contacts
  for select
  to authenticated
  using (public.has_permission(auth.uid(), 'notifications.read'));

-- REVOKE FIRST — same load-bearing reason as 53/179.
revoke all on public.whatsapp_messages from anon;
revoke all on public.whatsapp_messages from authenticated;
revoke all on public.whatsapp_chats from anon;
revoke all on public.whatsapp_chats from authenticated;
revoke all on public.whatsapp_contacts from anon;
revoke all on public.whatsapp_contacts from authenticated;

grant select on public.whatsapp_messages to authenticated;
grant select on public.whatsapp_chats to authenticated;
grant select on public.whatsapp_contacts to authenticated;
grant all on public.whatsapp_messages to service_role;
grant all on public.whatsapp_chats to service_role;
grant all on public.whatsapp_contacts to service_role;

drop trigger if exists whatsapp_chats_set_updated_at on public.whatsapp_chats;
create trigger whatsapp_chats_set_updated_at
  before update on public.whatsapp_chats
  for each row execute function public.tg_set_updated_at();

drop trigger if exists whatsapp_contacts_set_updated_at on public.whatsapp_contacts;
create trigger whatsapp_contacts_set_updated_at
  before update on public.whatsapp_contacts
  for each row execute function public.tg_set_updated_at();

------------------------------------------------------------
-- ingest_whatsapp_messages: the ONE write path for message rows.
--
-- Transactional and idempotent: the chat counters move only for rows the
-- insert actually landed, so a webhook replay (same message_id) cannot bump
-- unread twice, and the increment is a SQL expression so concurrent deliveries
-- cannot lose updates. Preview/last_message_at advance only for newer
-- messages, so a delayed replay cannot regress the chat list.
------------------------------------------------------------

create or replace function public.ingest_whatsapp_messages(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r jsonb;
  inserted_id uuid;
  inserted_count integer := 0;
  v_sent_at timestamptz;
  v_from_me boolean;
  v_preview text;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    v_sent_at := coalesce((r->>'sent_at')::timestamptz, now());
    v_from_me := coalesce((r->>'from_me')::boolean, false);

    insert into public.whatsapp_messages
      (message_id, chat_number, direction, from_me, body, message_type,
       media_type, media_id, media_filename, sent_at, raw)
    values
      (r->>'message_id',
       r->>'chat_number',
       r->>'direction',
       v_from_me,
       r->>'body',
       coalesce(r->>'message_type', 'text'),
       r->>'media_type',
       r->>'media_id',
       r->>'media_filename',
       v_sent_at,
       r->'raw')
    on conflict (message_id) do nothing
    returning id into inserted_id;

    if inserted_id is null then
      continue;  -- replay of a message we already hold
    end if;
    inserted_count := inserted_count + 1;

    v_preview := coalesce(
      nullif(trim(r->>'body'), ''),
      '[' || coalesce(r->>'media_type', r->>'message_type', 'message') || ']'
    );

    insert into public.whatsapp_chats
      (chat_number, display_name, last_message_preview, last_message_at, unread_count)
    values
      (r->>'chat_number',
       nullif(trim(r->>'push_name'), ''),
       v_preview,
       v_sent_at,
       case when v_from_me then 0 else 1 end)
    on conflict (chat_number) do update
      set last_message_preview = case
            when excluded.last_message_at >= coalesce(whatsapp_chats.last_message_at, 'epoch'::timestamptz)
            then excluded.last_message_preview
            else whatsapp_chats.last_message_preview
          end,
          last_message_at = greatest(
            coalesce(whatsapp_chats.last_message_at, 'epoch'::timestamptz),
            excluded.last_message_at
          ),
          -- Fill-empty only: a push name never overwrites an admin-set name.
          display_name = coalesce(whatsapp_chats.display_name, excluded.display_name),
          unread_count = whatsapp_chats.unread_count + case when v_from_me then 0 else 1 end,
          updated_at = now();

    -- Contact auto-capture, same fill-empty-only rule for the name.
    insert into public.whatsapp_contacts (phone, name)
    values (r->>'chat_number', nullif(trim(r->>'push_name'), ''))
    on conflict (phone) do update
      set name = coalesce(whatsapp_contacts.name, excluded.name),
          updated_at = now();
  end loop;

  return inserted_count;
end;
$$;

-- Server-only: the webhook handler and the delivery layer call this with the
-- service role. Nothing user-facing may write messages directly.
revoke all on function public.ingest_whatsapp_messages(jsonb) from public;
revoke all on function public.ingest_whatsapp_messages(jsonb) from anon;
revoke all on function public.ingest_whatsapp_messages(jsonb) from authenticated;
grant execute on function public.ingest_whatsapp_messages(jsonb) to service_role;
