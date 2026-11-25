-- 65_find_profiles_by_phone_digits.sql
--
-- Supports signing in with a mobile number (src/fns/signInWithIdentifier.ts).
--
-- `profiles.phone` is free text and holds the same mobile in whatever shape
-- whoever typed it preferred: '51234567', '+965 5123 4567', '00965-51234567'.
-- An equality match would therefore fail for most people while looking like a
-- finished feature, so the comparison happens over a digits-only projection of
-- both sides, on the last 8 digits — the Kuwaiti subscriber number.
--
-- SECURITY DEFINER because the caller is a server function acting for someone
-- who is not signed in yet, so no RLS-visible identity exists. That is safe
-- here only because of what the function does *not* do: it never takes a
-- password, and it is never reachable from the browser. The server function
-- requires a password in the same call, so a bare number can never be exchanged
-- for an account's email address.
--
-- EXECUTE is granted to service_role alone, deliberately. `authenticated` and
-- `anon` are left out: a signed-in tenant has no business mapping arbitrary
-- phone numbers onto email addresses, and neither has a visitor.

-- Two columns are searched, and the second is the one that matters.
--
-- `profiles.phone` is the obvious place to look and is empty for every account
-- on this deployment — 0 of 5 profiles have one. Tenant mobile numbers live on
-- `tenants.mobile`, reached through `profiles.tenant_id`, because that is where
-- the tenant record captured them. Searching profiles alone would have matched
-- nobody: the feature would have looked finished and worked for no one.
--
-- `profiles.phone` is kept in the search anyway. It is the right home for a
-- managerial user's number, who has no tenant row to fall back on.
create or replace function public.find_profiles_by_phone_digits(_digits text)
returns table (id uuid, email text)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, p.email::text
  from public.profiles p
  left join public.tenants t on t.id = p.tenant_id
  where
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
  -- Two rows is enough for the caller to know the match is ambiguous and refuse;
  -- there is no reason to return more.
  limit 2;
$$;

revoke all on function public.find_profiles_by_phone_digits(text) from public;
revoke all on function public.find_profiles_by_phone_digits(text) from anon;
revoke all on function public.find_profiles_by_phone_digits(text) from authenticated;
grant execute on function public.find_profiles_by_phone_digits(text) to service_role;
