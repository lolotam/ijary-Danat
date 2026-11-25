-- 133_add_postora_provider.sql
-- Adds 'postora' as a notification provider so WhatsApp sends can route through
-- Postora's partner API instead of Danat's own Meta Cloud API credentials.
-- Schema-only: ALTER TYPE. The provider_configs INSERT and the trigger body
-- that references the new label live in 134_postora_provider_config.sql —
-- Postgres forbids using a new enum label in DML inside the same transaction
-- that adds it (same split as 31/32). Idempotent.

do $$ begin
  alter type public.notification_providers add value if not exists 'postora';
exception
  when duplicate_object then null;
  when others then
    begin
      alter type public.notification_providers add value 'postora';
    exception when duplicate_object then null;
    end;
end $$;
