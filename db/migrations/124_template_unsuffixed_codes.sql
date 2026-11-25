-- ---------------------------------------------------------------------------
-- 124 — unsuffixed template codes (phase 1 of 2)
-- ---------------------------------------------------------------------------
--
-- Additive only. Afterwards BOTH `receipt-ar` and `receipt` resolve, so the
-- running (old) bundle and the incoming (new) bundle are simultaneously correct.
--
-- Why two phases: every sender also writes `notifications.template_code`, an FK
-- onto this table. Renaming in one step would make the old bundle's INSERT fail
-- for the minutes before the container swaps, silently dropping notifications —
-- receipts included.
--
-- Everything below is keyed on an EXPLICIT stem list, never a '-(ar|en)$' regex:
-- the schema has never reserved those suffixes, so an admin-created
-- `lease-renewal-ar` is legitimate and must not be touched.

begin;

create temporary table legacy_stem(stem text primary key) on commit drop;
insert into legacy_stem(stem) values
  ('due-reminder'), ('overdue-reminder'), ('receipt'), ('contract-expiry'),
  ('invoice-document'), ('deposit-confirmation'), ('user-credentials'),
  ('payment-admin-alert'), ('contact-inquiry'), ('maintenance-request'),
  ('refund-recorded'), ('contract-created'), ('contract-ended'),
  ('contract-closeout'), ('contract-restored'), ('invoice-written-off'),
  ('invoice-disputed');

do $$
declare
  problem text;
begin
  -- Both siblings must exist. An inner join would pass vacuously on a missing
  -- one, and phase 2 would then delete a row whose alias was never created.
  select string_agg(s.stem, ', ') into problem
    from legacy_stem s
   where (select count(*) from public.notification_templates t
           where t.code in (s.stem || '-ar', s.stem || '-en')) <> 2;
  if problem is not null then
    raise exception 'Incomplete AR/EN pair for: %', problem;
  end if;

  -- Every field that survives the merge must already agree, or the collapse
  -- picks a silent winner. The four content columns are included because they
  -- are what is actually collapsed.
  select string_agg(s.stem, ', ') into problem
    from legacy_stem s
    join public.notification_templates a on a.code = s.stem || '-ar'
    join public.notification_templates b on b.code = s.stem || '-en'
   where a.type is distinct from b.type
      or a.channel is distinct from b.channel
      or a.is_active is distinct from b.is_active
      or a.allow_freeform is distinct from b.allow_freeform
      or a.subject_ar is distinct from b.subject_ar
      or a.subject_en is distinct from b.subject_en
      or a.body_ar is distinct from b.body_ar
      or a.body_en is distinct from b.body_en
      or a.provider_template_name is distinct from b.provider_template_name
      or a.provider_language_code is distinct from b.provider_language_code
      or a.provider_param_keys is distinct from b.provider_param_keys
      or a.twilio_content_sid is distinct from b.twilio_content_sid
      or a.twilio_variable_keys is distinct from b.twilio_variable_keys;
  if problem is not null then
    raise exception 'AR/EN pair disagrees on a retained field for: %', problem;
  end if;

  -- A pre-existing row already holding the target code is preserved by
  -- `on conflict do nothing`, so it must be identical on EVERY retained field —
  -- not just type/channel/body. Otherwise the new app silently loads a row with
  -- different subjects, is_active, or provider binding.
  select string_agg(s.stem, ', ') into problem
    from legacy_stem s
    join public.notification_templates x on x.code = s.stem
    join public.notification_templates a on a.code = s.stem || '-ar'
   where x.type is distinct from a.type
      or x.channel is distinct from a.channel
      or x.is_active is distinct from a.is_active
      or x.allow_freeform is distinct from a.allow_freeform
      or x.subject_ar is distinct from a.subject_ar
      or x.subject_en is distinct from a.subject_en
      or x.body_ar is distinct from a.body_ar
      or x.body_en is distinct from a.body_en
      or x.provider_template_name is distinct from a.provider_template_name
      or x.provider_language_code is distinct from a.provider_language_code
      or x.provider_param_keys is distinct from a.provider_param_keys
      or x.twilio_content_sid is distinct from a.twilio_content_sid
      or x.twilio_variable_keys is distinct from a.twilio_variable_keys;
  if problem is not null then
    raise exception 'Target code already exists with different content for: %', problem;
  end if;
end $$;

-- Two rows per type become one, so uniqueness can no longer include locale.
alter table public.notification_templates
  drop constraint if exists notification_templates_type_channel_locale_key;

-- `locale` is NOT NULL with no default. The new bundle stops sending it and
-- could not CREATE a template between its deploy and migration 125.
alter table public.notification_templates
  alter column locale set default 'ar';

insert into public.notification_templates (
  code, type, channel, locale, is_active, allow_freeform,
  subject_ar, subject_en, body_ar, body_en,
  provider_template_name, provider_language_code, provider_param_keys,
  twilio_content_sid, twilio_variable_keys
)
select
  s.stem, a.type, a.channel, a.locale, a.is_active, a.allow_freeform,
  a.subject_ar, a.subject_en, a.body_ar, a.body_en,
  a.provider_template_name, a.provider_language_code, a.provider_param_keys,
  a.twilio_content_sid, a.twilio_variable_keys
  from legacy_stem s
  join public.notification_templates a on a.code = s.stem || '-ar'
on conflict (code) do nothing;

commit;
