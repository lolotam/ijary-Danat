-- 332_email_sender_per_company.sql (T170)
--
-- مُرسِل البريد لكل شركة: أسرار المُرسِل في `company_secrets` المشفّرة، والمُرسِل
-- الافتراضي للمنصة لمن لا مُرسِل له (قصة المستخدم 10، FR-068 و FR-069).
--
-- Per data-model.md section 5 and research.md R9:
--   - `provider_configs` keeps the sender's *settings*; the credential itself
--     moves to `company_secrets`, encrypted with AES-256-GCM under
--     `INTEGRATIONS_MASTER_KEY` (the only place that encrypts is the app,
--     `src/lib/secrets.server.ts`).
--   - A company secret belongs to one provider row: `owner_kind = 'email'`
--     and `owner_id = provider_configs.id`, with the name of the credential:
--       * `api_key`       — the Resend API key of the company's own sender;
--       * `password`      — the SMTP password of the company's own sender;
--       * `webhook_secret`— the secret that signs the company's Resend
--                          webhook deliveries.
--     The row's `version` is the `provider_configs.secrets_version` the send
--     reads, so a rotated credential never leaves the old one in use.
--   - The platform's own credential never enters `company_secrets`: it belongs
--     to the platform, and it is read from the environment
--     (`PLATFORM_EMAIL_PROVIDER`, `PLATFORM_EMAIL_FROM`, `RESEND_API_KEY`,
--     `SMTP_*`).
--
-- ONE-TIME RE-ENTRY (the operator does this once, after the deploy)
-- The values that exist today cannot be encrypted by SQL: the master key lives
-- in the application, never in the database. So:
--   1. A company that wants its own sender enters the credential once in its
--      panel; the application encrypts it into `company_secrets` as above and
--      raises `provider_configs.secrets_version` from 0 to 1.
--   2. A company that does nothing keeps sending through the platform's
--      default sender, with its name as the display name and its address as
--      the reply-to.
--   3. The rows seeded before this migration keep `secrets_version = 0` and
--      their environment references, and the send still reads them — so the
--      migration changes nothing for a live sender.
--
-- RLS
-- `company_secrets` already carries forced RLS and a `company_service` policy
-- keyed to `current_company_id()` (migration 318); this migration adds a
-- column to `provider_configs` and no data to that table.
--
-- Rollback:
--   drop function if exists public.platform_email_notification_owner(text);
--   drop index if exists public.notifications_provider_message_id_idx;
--   alter table public.provider_configs drop column if exists secrets_version;

------------------------------------------------------------
-- 1. provider_configs.secrets_version
------------------------------------------------------------

-- Which version of the company's own credential this row sends with:
--   0 — the row still uses the platform's environment reference, which is how
--       every row seeded before this migration behaves;
--   1 or more — the version of the `company_secrets` rows that hold the
--       company's own credential (owner_kind 'email', owner_id this row).
--
-- Zero rather than one, unlike `gateway_connections.credentials_version`:
-- there the first credential set is version one, and here the first set of a
-- company's own credential is the one that moves the row off the platform's
-- shared environment reference.
alter table public.provider_configs
  add column if not exists secrets_version int not null default 0;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'provider_configs_secrets_version_positive'
       and conrelid = 'public.provider_configs'::regclass
  ) then
    alter table public.provider_configs
      add constraint provider_configs_secrets_version_positive
      check (secrets_version >= 0);
  end if;
end $$;

comment on column public.provider_configs.secrets_version is
  'Version of the company_secrets rows holding this sender''s own credential (owner_kind ''email'', owner_id = provider_configs.id). Zero means the row still uses the platform''s environment reference.';

------------------------------------------------------------
-- 2. The platform webhook''s cross-company lookup
------------------------------------------------------------

-- The platform's default sender sends for every company that has no sender of
-- its own, so a bounce for one of those messages arrives at the platform
-- webhook with no company in the URL. This function answers the only question
-- the handler asks: which company does this message id belong to.
--
-- It reads across companies on purpose, which is why it is `security definer`
-- and why EXECUTE is granted to `company_service` alone: the caller is the
-- application's own signed token, never the browser's public key.
--
-- A caller that carries a company may only look up its own notifications;
-- `current_company_id()` is null only for the platform's own token, which is
-- the one caller entitled to ask about any company.
create or replace function public.platform_email_notification_owner(p_message_id text)
returns table (
  company_id uuid,
  notification_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select n.company_id, n.id
    from public.notifications n
   where n.provider_message_id = p_message_id
     and (public.current_company_id() is null or n.company_id = public.current_company_id())
  union all
  select n.company_id, n.id
    from public.notifications n
   where n.provider_message_id like '%' || p_message_id || '%'
     and n.provider_message_id <> p_message_id
     and exists (
       select 1
         from unnest(string_to_array(n.provider_message_id, ',')) as part(part)
        where btrim(part.part) = p_message_id
     )
     and (public.current_company_id() is null or n.company_id = public.current_company_id())
   limit 1;
$$;

-- The message id is stored as it came from the provider. A `channel: "both"`
-- notification stores "<email-id>,<whatsapp-id>", so the exact match answers
-- the common case and the split match the joined one.

-- The `PUBLIC` grant that Supabase's default privileges add to new functions
-- is revoked first, so `anon` cannot even attempt the call (migration 96).
revoke all on function public.platform_email_notification_owner(text)
  from public, anon, authenticated, company_service, service_role;
grant execute on function public.platform_email_notification_owner(text)
  to company_service, service_role;

------------------------------------------------------------
-- 3. Index for the lookup above
------------------------------------------------------------

-- The exact-match branch of the lookup is the one that runs for every
-- delivery event, and it was a sequential scan over the whole table.
create index if not exists notifications_provider_message_id_idx
  on public.notifications (provider_message_id)
  where provider_message_id is not null;
