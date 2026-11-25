-- 177_add_evolution_provider.sql
-- Adds 'evolution_api' as a notification provider so WhatsApp sends can route
-- through the self-hosted Evolution API container (Baileys QR gateway) instead
-- of a Meta Cloud API account.
-- Schema-only: ALTER TYPE. The provider_configs INSERT and the trigger body
-- that references the new label live in 178_evolution_provider_config.sql —
-- Postgres forbids using a new enum label in DML inside the same transaction
-- that adds it (same split as 133/134). Idempotent.

do $$ begin
  alter type public.notification_providers add value if not exists 'evolution_api';
exception
  when duplicate_object then null;
  when others then
    begin
      alter type public.notification_providers add value 'evolution_api';
    exception when duplicate_object then null;
    end;
end $$;
