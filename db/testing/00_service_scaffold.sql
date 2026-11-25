-- 00_service_scaffold.sql — TEST/TOOLING ONLY. NEVER APPLIED TO PRODUCTION.
--
-- This file is deliberately OUTSIDE db/migrations/ so that neither the
-- production deploy nor any migration runner can pick it up.
--
-- Why it exists
-- -------------
-- In a real Supabase stack the `auth` and `storage` schemas are owned by the
-- GoTrue and Storage *services*, which run their own migrations at boot. The
-- `supabase/postgres` Docker image ships only the historical baseline of those
-- schemas, so it lags whatever the running services have since added.
--
-- db/migrations/ assumes the modern shape. Concretely, eight migrations do
--     insert into storage.buckets (id, name, public) ...
-- but the image's storage.buckets has no `public` column — so applying
-- db/migrations/ to a bare image aborts at 05_phase3_invoices_payments.sql.
-- (That is also why `bun run gen:types` fails today.)
--
-- This scaffold closes exactly that gap and nothing more: it states, in one
-- place, what the application migrations require the Supabase services to have
-- provided. Add to it only when a migration starts depending on another
-- service-owned column, and say which migration forced the addition.
--
-- Idempotent.

------------------------------------------------------------
-- storage.buckets — columns added by the Storage service after the image's
-- baseline. Only `public` is referenced by db/migrations/ (grep: eight
-- `insert into storage.buckets (id, name, public)` sites). The rest are
-- included because Storage always creates them together and their absence
-- would be a confusing partial mock.
------------------------------------------------------------
alter table storage.buckets
  add column if not exists public boolean not null default false;
alter table storage.buckets
  add column if not exists avif_autodetection boolean not null default false;
alter table storage.buckets
  add column if not exists file_size_limit bigint;
alter table storage.buckets
  add column if not exists allowed_mime_types text[];
alter table storage.buckets
  add column if not exists owner_id text;

------------------------------------------------------------
-- storage.objects — not currently referenced by db/migrations/ beyond
-- bucket_id/name/owner (all present in the baseline), but the storage RLS
-- policies in 04/05/08 call storage.foldername(name), which the image does
-- provide. path_tokens is added so a test can assert on folder shape the same
-- way production does.
------------------------------------------------------------
alter table storage.objects
  add column if not exists path_tokens text[]
  generated always as (string_to_array(name, '/')) stored;
alter table storage.objects
  add column if not exists version text;
alter table storage.objects
  add column if not exists owner_id text;

------------------------------------------------------------
-- auth.users — `banned_until` is GoTrue's own kill switch, added to the
-- service well after this image's baseline. Forced by migration 142, which
-- bans every already-deactivated account so that `profiles.is_active` cannot
-- be bypassed by calling GoTrue's password grant directly.
--
-- Verified present on production (`auth.users.banned_until timestamptz`)
-- before it was relied on. Only this one column is added: nothing in
-- db/migrations/ touches the rest of GoTrue's post-baseline shape, and a
-- broader mock would assert more about the service than the app depends on.
------------------------------------------------------------
alter table auth.users
  add column if not exists banned_until timestamptz;
