-- 66_find_phone_conflicts.sql
--
-- Guards the mobile-number fields added to the user forms.
--
-- Sign-in by mobile (src/fns/signInWithIdentifier.ts) resolves an identifier by
-- comparing the LAST 8 DIGITS — the Kuwaiti subscriber number — across
-- profiles.phone and, via profiles.tenant_id, tenants.mobile. It then refuses
-- when more than one profile matches, because picking one would mean checking a
-- password against an account the person may not own.
--
-- So a number saved on one account can silently disable mobile login for
-- another. This function is how the save path refuses that, and it mirrors
-- migration 65's digits-only projection exactly. Any looser comparison would
-- admit values login cannot resolve; any stricter one would reject values that
-- are fine.
--
-- Two conflict kinds are reported:
--
--   'profile' — another profile already resolves from these digits. This is a
--               live collision: mobile login is broken for both today.
--   'tenant'  — a tenant carries this mobile but has no portal account yet. Not
--               a collision now, but a tenant's mobile is the number most likely
--               to be typed onto a managerial account by mistake, and the
--               collision would surface much later, when that portal login is
--               created. Reported so it can be refused at the point of entry.
--
-- The tenant branch is skipped whenever the tenant already has any profile: the
-- profile branch has that case. If tenant T already has a portal profile, a
-- second account reusing the number is a real ambiguity and the profile branch
-- still flags it.
--
-- Two exclusions, for two different moments:
--
--   _exclude_profile covers editing an existing account (updateAppUser): the
--   profile being edited is real, so it is excluded from the profile branch.
--
--   _exclude_tenant covers creating one (createAppUser): at that point the
--   profile does not exist yet, so there is nothing for _exclude_profile to
--   exclude. Without _exclude_tenant the single most ordinary case — giving a
--   tenant's portal login that tenant's own mobile number — would be refused
--   as a conflict with itself, because the tenant branch would still fire.
--
-- SECURITY DEFINER and service_role-only EXECUTE, matching migration 65: this
-- maps phone numbers onto account names, which no signed-in tenant and no
-- visitor has any business doing.

-- Migration 66 has not shipped past the disposable test database, so the old
-- two-argument signature is dropped here rather than superseded by a new
-- migration number, to avoid leaving both versions installed on any database
-- that already applied it.
drop function if exists public.find_phone_conflicts(text, uuid);

create or replace function public.find_phone_conflicts(_digits text, _exclude_profile uuid, _exclude_tenant uuid)
returns table (kind text, id uuid, label text)
language sql
security definer
set search_path = public
stable
as $$
  select
    'profile'::text,
    p.id,
    coalesce(p.display_name, p.username::text, p.email::text)
  from public.profiles p
  left join public.tenants t on t.id = p.tenant_id
  where
    (_exclude_profile is null or p.id <> _exclude_profile)
    and (
      (
        p.phone is not null
        and length(regexp_replace(p.phone, '\D', '', 'g')) >= 8
        and right(regexp_replace(p.phone, '\D', '', 'g'), 8) = right(_digits, 8)
      )
      or (
        t.mobile is not null
        and length(regexp_replace(t.mobile, '\D', '', 'g')) >= 8
        and right(regexp_replace(t.mobile, '\D', '', 'g'), 8) = right(_digits, 8)
      )
    )

  union all

  select
    'tenant'::text,
    t.id,
    t.name
  from public.tenants t
  where
    t.mobile is not null
    and length(regexp_replace(t.mobile, '\D', '', 'g')) >= 8
    and right(regexp_replace(t.mobile, '\D', '', 'g'), 8) = right(_digits, 8)
    and not exists (select 1 from public.profiles p where p.tenant_id = t.id)
    and (_exclude_tenant is null or t.id <> _exclude_tenant)

  -- The caller only ever names the first conflict; a bounded result keeps a
  -- badly-typed digit string from scanning out a whole table into the response.
  limit 10;
$$;

revoke all on function public.find_phone_conflicts(text, uuid, uuid) from public;
revoke all on function public.find_phone_conflicts(text, uuid, uuid) from anon;
revoke all on function public.find_phone_conflicts(text, uuid, uuid) from authenticated;
grant execute on function public.find_phone_conflicts(text, uuid, uuid) to service_role;
