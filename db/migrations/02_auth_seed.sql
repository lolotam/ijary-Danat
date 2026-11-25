-- 02_auth_seed.sql
-- Trigger: auto-create a profile row on auth.users insert.
-- Seed: the single company row (edit values after running).
--
-- Bootstrapping the first admin is a manual step (see bottom of file).

------------------------------------------------------------
-- Trigger: on new auth.users -> create profile row
------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
begin
  v_username := coalesce(
    new.raw_user_meta_data->>'username',
    split_part(coalesce(new.email, ''), '@', 1)
  );

  -- Guarantee uniqueness so a collision never aborts user creation.
  -- Without this, signing up a user whose email prefix or username matches
  -- an existing profile violates profiles_username_key and the whole signup
  -- transaction rolls back with a 500.
  if v_username is not null and v_username <> '' then
    if exists (select 1 from public.profiles where username = v_username) then
      v_username := v_username || '_' || substr(new.id::text, 1, 8);
    end if;
  else
    v_username := substr(new.id::text, 1, 12);
  end if;

  insert into public.profiles (id, username, display_name, email, preferred_locale)
  values (
    new.id,
    v_username,
    coalesce(new.raw_user_meta_data->>'display_name', v_username),
    new.email,
    coalesce((new.raw_user_meta_data->>'preferred_locale')::public.locale_code, 'ar')
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

------------------------------------------------------------
-- Seed the single company (edit these values, then re-run)
------------------------------------------------------------

insert into public.companies (
  id, name_ar, name_en, email, phone, default_locale, currency, timezone,
  max_visible_unpaid_invoices
) values (
  gen_random_uuid(),
  'دانة المستقبل العقارية',
  'Danat Al Mustaqbal Real Estate',
  'info@example.com',
  '+965-0000-0000',
  'ar',
  'KWD',
  'Asia/Kuwait',
  6
)
on conflict do nothing;

------------------------------------------------------------
-- Bootstrapping the first admin (RUN MANUALLY, ONCE)
------------------------------------------------------------
-- 1. Create the user in Supabase Studio → Authentication → Users
--    (email + password; email confirmation may be disabled per PRD).
-- 2. Copy the user id and run:
--
--    insert into public.user_roles (user_id, role)
--    values ('<paste-uuid-here>', 'admin');
--
-- 3. Optionally attach that admin to the company:
--
--    update public.profiles
--    set company_id = (select id from public.companies limit 1)
--    where id = '<paste-uuid-here>';
