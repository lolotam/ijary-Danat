-- 318_company_secrets.sql (T139)
--
-- ينشئ جدول `company_secrets` لتخزين أسرار التكاملات المشفّرة لكل شركة
-- (AES-256-GCM عبر `src/lib/secrets.server.ts`)، مع عرض `company_secret_previews`
-- الذي يكشف آخر أربعة أحرف (`last4`) فقط للموظفين المخوّلين بصلاحية `settings.integrations`.
--
-- Per research.md R9 and data-model.md section 3:
--   - Secrets (ciphertext, iv, auth_tag, key_version) are stored as separate
--     columns matching `EncryptedSecret` in `src/lib/secrets.server.ts`.
--   - `authenticated` and `anon` have ZERO privileges on `public.company_secrets`
--     so encrypted blobs never reach the browser. Only `company_service` (under
--     company-scoped RLS) and `service_role` may access the base table.
--   - Screens read only `last4` via `public.company_secret_previews`, which
--     filters by `current_company_id()` and requires `settings.integrations`
--     for `authenticated` callers.
--
-- Rollback:
--   drop view if exists public.company_secret_previews;
--   drop table if exists public.company_secrets;

create table if not exists public.company_secrets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  owner_kind text not null
    check (owner_kind in ('gateway', 'whatsapp', 'email', 'gmail')),
  owner_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 120),
  ciphertext bytea not null,
  -- AES-256-GCM uses a 12-byte IV and a pinned 16-byte authentication tag
  -- (`IV_LENGTH` and `AUTH_TAG_LENGTH` in `src/lib/secrets.server.ts`).
  iv bytea not null check (octet_length(iv) = 12),
  auth_tag bytea not null check (octet_length(auth_tag) = 16),
  key_version int not null check (key_version >= 1),
  -- Empty string when the plaintext secret is 4 characters or fewer (`last4()`).
  last4 text not null default '' check (length(last4) <= 4),
  version int not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, id),
  unique (owner_kind, owner_id, name, version)
);

create index if not exists company_secrets_company_owner_idx
  on public.company_secrets (company_id, owner_kind, owner_id);

drop trigger if exists set_updated_at on public.company_secrets;
create trigger set_updated_at
  before update on public.company_secrets
  for each row execute function public.tg_set_updated_at();

alter table public.company_secrets enable row level security;
alter table public.company_secrets force row level security;

-- REVOKE before GRANT (migrations 162/163): Supabase default privileges hand
-- new public tables to anon, authenticated and company_service. Secrets must
-- never be readable by `authenticated` or `anon`.
revoke all on public.company_secrets from public, anon, authenticated, company_service;
grant select, insert, update, delete on public.company_secrets to company_service;
grant all on public.company_secrets to service_role;

drop policy if exists company_secrets_company_service_all on public.company_secrets;
create policy company_secrets_company_service_all
  on public.company_secrets
  for all
  to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

drop policy if exists company_secrets_service_role_all on public.company_secrets;
create policy company_secrets_service_role_all
  on public.company_secrets
  for all
  to service_role
  using (true)
  with check (true);

-- عرض آمن يعرض `last4` فقط دون أي بيانات مشفّرة.
-- Runs as the view owner (`security_invoker = false`) so `authenticated` staff
-- with `settings.integrations` can read masked previews without receiving any
-- SELECT privilege on `public.company_secrets` itself.
create or replace view public.company_secret_previews as
select
  s.id,
  s.company_id,
  s.owner_kind,
  s.owner_id,
  s.name,
  s.last4,
  s.version,
  s.updated_at
from public.company_secrets s
where s.company_id = (select public.current_company_id())
  and (
    current_user in ('service_role', 'company_service')
    or (select public.has_permission((select auth.uid()), 'settings.integrations'::text))
  );

revoke all on public.company_secret_previews from public, anon, authenticated, company_service;
grant select on public.company_secret_previews to authenticated, company_service;
grant all on public.company_secret_previews to service_role;
