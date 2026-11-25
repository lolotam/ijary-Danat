-- 134_postora_provider_config.sql
-- Seeds the disabled postora provider_configs row and re-issues the mutual-
-- exclusivity trigger so 'postora' participates in the WhatsApp-provider
-- toggle. Runs in its own migration because the INSERT and the trigger body
-- both *use* the 'postora' label, which Postgres forbids in the same
-- transaction as the ALTER TYPE that adds it (see 133). Idempotent.

------------------------------------------------------------
-- provider_configs seed (disabled — nothing routes here until cutover)
------------------------------------------------------------

insert into public.provider_configs (provider, is_enabled, config)
values (
  'postora',
  false,
  jsonb_build_object(
    'api_base',           'https://api.postora.cloud/functions/v1/partner-api',
    'api_key_env',        'POSTORA_API_KEY',
    'webhook_secret_env', 'POSTORA_WEBHOOK_SECRET'
  )
)
on conflict (provider) do nothing;

------------------------------------------------------------
-- Mutual exclusivity: 'postora' joins the WhatsApp group
-- The trigger enumerates providers literally (::text casts stay — the comment
-- in 31 explains they exist so the function can be created alongside an ALTER
-- TYPE). Without 'postora' in BOTH in-lists, enabling postora would leave
-- whatsapp_cloud_api enabled and two providers would race on the same send.
------------------------------------------------------------

create or replace function public.tg_provider_mutual_exclusivity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Compare as text so this function can be created in the same transaction as
  -- ALTER TYPE ... ADD VALUE (new enum labels are unusable until commit).
  if new.is_enabled is true then
    if new.provider::text in ('smtp', 'resend') then
      update public.provider_configs
         set is_enabled = false, updated_at = now()
       where provider::text in ('smtp', 'resend')
         and provider is distinct from new.provider
         and is_enabled is true;
    elsif new.provider::text in ('whatsapp_cloud_api', 'twilio', 'postora') then
      update public.provider_configs
         set is_enabled = false, updated_at = now()
       where provider::text in ('whatsapp_cloud_api', 'twilio', 'postora')
         and provider is distinct from new.provider
         and is_enabled is true;
    end if;
  end if;
  return new;
end;
$$;
