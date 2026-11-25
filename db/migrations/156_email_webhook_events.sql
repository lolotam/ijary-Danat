-- 156_email_webhook_events.sql
--
-- An archive of the delivery events Resend posts back to
-- `/api/public/resend-webhook`, plus the replay key that makes redelivery a
-- no-op. Nothing in the money path reads this table; it exists so that a
-- bounced tenant invoice stops being invisible.
--
-- WHY NOT `webhook_events`
-- That table is keyed by `gateway public.gateway_providers`, an enum whose only
-- value is 'myfatoorah', and carries `provider_payment_id`. Widening a payment
-- gateway enum to hold an email provider would make every future reader of
-- `webhook_events` ask whether a row is money or mail, and the answer would be
-- a string comparison. A separate table costs one migration and keeps the
-- question from existing.
--
-- WHY THE UNIQUE INDEX IS ON `provider_event_id`
-- Svix — the delivery layer Resend uses — sends a stable `svix-id` per message
-- and retries with the SAME id until it gets a 2xx. That id, not a hash of the
-- bytes, is what tells a retry apart from a genuinely new event. The partial
-- `where not null` mirrors `webhook_events_gateway_provider_event_id_uidx`: a
-- row we could not attribute must still be recordable.

create table if not exists public.email_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider public.notification_providers not null,
  event_type text,
  provider_event_id text,
  provider_message_id text,
  notification_id uuid references public.notifications(id) on delete set null,
  raw_payload jsonb,
  signature_valid boolean not null default false,
  processed boolean not null default false,
  result text,
  error text,
  received_at timestamptz not null default now()
);

-- `set null` and not `restrict`: the archive must never be the reason a
-- notification cannot be deleted. Losing the link costs a join; blocking the
-- delete would surface as an unexplained failure in an unrelated screen.

create unique index if not exists email_webhook_events_provider_event_id_uidx
  on public.email_webhook_events (provider, provider_event_id)
  where provider_event_id is not null;
create index if not exists email_webhook_events_message_id_idx
  on public.email_webhook_events (provider_message_id);
create index if not exists email_webhook_events_received_at_idx
  on public.email_webhook_events (received_at desc);

comment on table public.email_webhook_events is
  'Delivery events posted back by the email provider (Resend). Written only by the service role from /api/public/resend-webhook.';
comment on column public.email_webhook_events.provider_event_id is
  'The svix-id header. Stable across Svix retries, which is what makes replay detection exact.';
comment on column public.email_webhook_events.result is
  'What the handler did: applied, ignored_event_type, transient_bounce, unmatched, replay, or unverified.';

-- Supabase grants ALL on new public tables to anon and authenticated through
-- default privileges, so enabling RLS alone would not be enough — revoke first,
-- then grant back deliberately (the rule migration 96 established).
revoke all on public.email_webhook_events from public, anon, authenticated;
grant select on public.email_webhook_events to authenticated;
grant all on public.email_webhook_events to service_role;

alter table public.email_webhook_events enable row level security;

drop policy if exists email_webhook_events_select_admin on public.email_webhook_events;
create policy email_webhook_events_select_admin on public.email_webhook_events
  for select to authenticated
  using (public.has_permission(auth.uid(), 'notifications.read'));

drop policy if exists email_webhook_events_service_all on public.email_webhook_events;
create policy email_webhook_events_service_all on public.email_webhook_events
  for all to service_role
  using (true)
  with check (true);
