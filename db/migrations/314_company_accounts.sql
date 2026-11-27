-- 314_company_accounts.sql (T082)
--
-- يضيف جدول `password_reset_tokens` لرموز إعادة تعيين كلمة المرور أحادية
-- الاستخدام، ووسم `must_change_password` على `profiles` (بحث R3).
--
-- Password reset is an application flow (research.md R3): GoTrue's own recovery
-- mail would go to the synthetic `<uuid>@auth.ijary.invalid` address, so the
-- platform emails a single-use token of its own and the password is set through
-- the GoTrue admin API. This migration stores ONLY a hash of that token — never
-- the token itself — with an expiry and `used_at` for single use. The composite
-- foreign key pins each token to a profile of the SAME company, so a token
-- minted for one company can never name a user of another.
--
-- Staff and renters have no privilege on the table at all. Access goes only
-- through `company_service`, i.e. the server function T085 will write. That
-- function also owns consumption (compare the hash, require `used_at is null`
-- and `expires_at > now()`, then set `used_at`): R3 calls for a single-use
-- token TABLE, not an atomic SQL consume function, so none is added here.
--
-- The `token_hash` index is unique on the hash ALONE, deliberately not per
-- company: the hash is a 256-bit random digest, so a repeat can only be a
-- replayed token (a global unique is replay protection, not a business key),
-- and T085's lookup is `where token_hash = ...`, which a leading-company_id
-- index would not serve.
--
-- Guarded by src/db/companyAccounts.sqltest.ts and the isolation matrix.
--
-- Rollback:
--   alter table public.profiles drop column if exists must_change_password;
--   drop table if exists public.password_reset_tokens;

create table if not exists public.password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null,
  -- Only a digest of the emailed token is ever stored; the plaintext leaves
  -- the system in the email and is never persisted (security rules).
  token_hash text not null check (length(token_hash) between 1 and 200),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  -- profiles (company_id, id) is unique (migration 255), so a pair mixing two
  -- companies can never satisfy this foreign key.
  foreign key (company_id, user_id)
    references public.profiles (company_id, id) on delete cascade
);

create unique index if not exists password_reset_tokens_token_hash
  on public.password_reset_tokens (token_hash);

alter table public.password_reset_tokens enable row level security;
alter table public.password_reset_tokens force row level security;

-- REVOKE before GRANT (migrations 162/163): Supabase default privileges hand
-- every new public table to anon, authenticated and company_service. Reset
-- tokens must be unreachable for signed-in users of any role; only server code
-- (company_service) and the platform (service_role) touch them.
revoke all on public.password_reset_tokens from public, anon, authenticated, company_service;
grant select, insert, update, delete on public.password_reset_tokens to company_service;
grant all on public.password_reset_tokens to service_role;

drop policy if exists password_reset_tokens_company_service_all on public.password_reset_tokens;
create policy password_reset_tokens_company_service_all
  on public.password_reset_tokens
  for all
  to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

drop policy if exists password_reset_tokens_service_role_all on public.password_reset_tokens;
create policy password_reset_tokens_service_role_all
  on public.password_reset_tokens
  for all
  to service_role
  using (true)
  with check (true);

-- The first admin signs in with a temporary password and must change it at
-- first sign-in (FR-032); this flag is what the sign-in path checks.
alter table public.profiles
  add column if not exists must_change_password boolean not null default false;
