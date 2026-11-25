-- 225_email_provider_primary_fallback.sql
--
-- يسمح بتفعيل مزوّدَي البريد (SMTP و Resend) معاً: أحدهما افتراضي والآخر احتياطي.
--
-- Until now the email group was mutually exclusive (migration 31's trigger,
-- last re-issued in 178): enabling one disabled the other, so an outage at the
-- one provider in use failed every email. The owner wants both on at once,
-- with one marked default and the other used only when the default refuses.
--
-- `is_primary` marks the default. Exactly one email row carries it, enforced
-- twice:
--   * tg_provider_primary_email demotes the other email row whenever one is
--     promoted, so the admin screen only ever writes `true` and a single
--     update is the whole switch;
--   * a partial unique index makes a second primary impossible even for a
--     writer that bypasses the trigger's assumptions.
-- Which row is the fallback is implicit: the enabled email row that is not
-- primary. There is no second flag to drift out of step with the first.
--
-- WhatsApp stays mutually exclusive; only the email branch is removed from
-- tg_provider_mutual_exclusivity (body copied from 178, the latest).
--
-- Idempotent.

alter table public.provider_configs
  add column if not exists is_primary boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'provider_configs_primary_is_email'
      and conrelid = 'public.provider_configs'::regclass
  ) then
    alter table public.provider_configs
      add constraint provider_configs_primary_is_email
      check (not is_primary or provider::text in ('smtp', 'resend'));
  end if;
end;
$$;

create or replace function public.tg_provider_mutual_exclusivity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Compare as text so this function can be created in the same transaction as
  -- ALTER TYPE ... ADD VALUE (new enum labels are unusable until commit).
  -- Email is deliberately absent since 225: smtp and resend may both be
  -- enabled, ordered by is_primary.
  if new.is_enabled is true
     and new.provider::text in ('whatsapp_cloud_api', 'twilio', 'postora', 'evolution_api') then
    update public.provider_configs
       set is_enabled = false, updated_at = now()
     where provider::text in ('whatsapp_cloud_api', 'twilio', 'postora', 'evolution_api')
       and provider is distinct from new.provider
       and is_enabled is true;
  end if;
  return new;
end;
$$;

create or replace function public.tg_provider_primary_email()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- BEFORE, like the exclusivity trigger: the other row is demoted before this
  -- one is written, so the unique index below never sees two primaries. The
  -- nested update writes `false`, which this branch ignores, so it cannot
  -- recurse.
  if new.is_primary is true then
    update public.provider_configs
       set is_primary = false, updated_at = now()
     where provider::text in ('smtp', 'resend')
       and provider is distinct from new.provider
       and is_primary is true;
  end if;
  return new;
end;
$$;

drop trigger if exists provider_primary_email on public.provider_configs;
create trigger provider_primary_email
  before insert or update of is_primary on public.provider_configs
  for each row
  execute function public.tg_provider_primary_email();

create unique index if not exists provider_configs_one_primary_email
  on public.provider_configs ((true))
  where is_primary;

-- Backfill: the email provider in use today becomes the default, so enabling
-- the second one later makes it the fallback and changes nothing about who
-- sends. With neither enabled, Resend — the provider dispatch preferred before
-- this migration. Skipped once any row is primary, so a re-run never overrides
-- the admin's choice.
update public.provider_configs
   set is_primary = true, updated_at = now()
 where not exists (select 1 from public.provider_configs where is_primary)
   and provider = (
     select provider
       from public.provider_configs
      where provider::text in ('smtp', 'resend')
      order by is_enabled desc, (provider::text = 'resend') desc
      limit 1
   );
