-- 136_postora_api_key_env.sql
-- Points the postora provider_configs row at POSTORA_WHATSAPP_API_KEY instead
-- of POSTORA_API_KEY. The config stores the environment-variable NAME only
-- (never the secret) — that is how requiredEnv resolves credentials.
-- Idempotent: re-running is a no-op once the name already matches. Other keys
-- in the JSON object and is_enabled are left alone. Do not edit 134 in place;
-- it is already applied in production.

update public.provider_configs
   set config = jsonb_set(config, '{api_key_env}', '"POSTORA_WHATSAPP_API_KEY"'::jsonb, true),
       updated_at = now()
 where provider = 'postora'
   and (config->>'api_key_env') is distinct from 'POSTORA_WHATSAPP_API_KEY';
