-- 38_provider_template_mapping.sql
-- Durable mapping from a local notification template code to the provider-side
-- template identifiers that Meta / Twilio actually approved.
--
-- Why this exists: WhatsApp business-initiated messages must use a template that
-- the provider approved. The approved name lives in the provider's namespace and
-- is decided by their review — it cannot be derived from our local `code`. The
-- previous implementation guessed it (`receipt-ar` -> `receipt_ar`), which sends
-- an unapproved name and is rejected at the API boundary.
--
-- These are public identifiers (template names, Content SIDs), not secrets, so
-- they belong in the database rather than in environment variables. One env var
-- per template would not scale and could not be edited by an admin.
--
-- NOTE: the `provider_configs_secret_references_only` constraint applies to
-- `provider_configs`, not to this table. It is untouched.
--
-- Idempotent.

------------------------------------------------------------
-- Mapping columns
------------------------------------------------------------

alter table public.notification_templates
  -- Meta Cloud API: the exact approved template name, recorded after approval.
  add column if not exists provider_template_name text,
  -- Meta language code, only when it differs from our `locale` ('ar' / 'en').
  -- Example: Meta may approve a template as 'ar_AE' or 'en_US'.
  add column if not exists provider_language_code text,
  -- Ordered payload keys feeding the template body parameters {{1}}, {{2}}, ...
  -- Order is significant: index 0 becomes {{1}}.
  add column if not exists provider_param_keys text[] not null default '{}'::text[],
  -- Twilio: the approved Content SID (HX...).
  add column if not exists twilio_content_sid text,
  -- Ordered payload keys feeding Twilio ContentVariables "1", "2", ...
  add column if not exists twilio_variable_keys text[] not null default '{}'::text[],
  -- Whether this template may be delivered as a free-form (non-template) message.
  -- Only ever true for messages sent inside an open customer-service window.
  add column if not exists allow_freeform boolean not null default false;

comment on column public.notification_templates.provider_template_name is
  'Exact Meta-approved WhatsApp template name. NULL or a *_REQUIRED placeholder means "not yet approved" and dispatch refuses to send.';
comment on column public.notification_templates.provider_param_keys is
  'Ordered notification payload keys mapped to Meta body parameters; index 0 -> {{1}}.';
comment on column public.notification_templates.twilio_content_sid is
  'Twilio approved Content SID (HX...). NULL or a *_REQUIRED placeholder means "not yet approved" and dispatch refuses to send.';
comment on column public.notification_templates.twilio_variable_keys is
  'Ordered notification payload keys mapped to Twilio ContentVariables; index 0 -> "1".';

------------------------------------------------------------
-- Placeholder guard
------------------------------------------------------------

-- Documentation and setup tables use sentinels such as META_TEMPLATE_NAME_REQUIRED
-- so an operator can see which values are still outstanding. If such a sentinel is
-- ever pasted into a live row it must NOT be treated as a real approved identifier.
-- Dispatch enforces this in code (see isMappedIdentifier in
-- src/lib/providers/whatsappTemplateBinding.ts); this constraint stops the two
-- documented sentinels from being stored at all, so the two layers cannot drift.

do $$ begin
  alter table public.notification_templates
    add constraint notification_templates_no_placeholder_identifiers
    check (
      coalesce(provider_template_name, '') <> 'META_TEMPLATE_NAME_REQUIRED'
      and coalesce(twilio_content_sid, '') <> 'TWILIO_CONTENT_SID_REQUIRED'
    ) not valid;
exception when duplicate_object then null; end $$;

------------------------------------------------------------
-- Obsolete Cloud API config key
------------------------------------------------------------

-- `template_namespace_ref` (WHATSAPP_TEMPLATE_NAMESPACE) was seeded in migration 07.
-- The namespace was required by the deprecated On-Premises API; the Cloud API
-- /messages endpoint identifies templates by name + language only and never reads
-- it. Removing it keeps the required-configuration surface honest.

update public.provider_configs
set config = config - 'template_namespace_ref'
where provider = 'whatsapp_cloud_api'
  and config ? 'template_namespace_ref';
