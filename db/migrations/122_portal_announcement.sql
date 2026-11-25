-- 122_portal_announcement.sql
--
-- A single scrolling announcement line in the tenant portal header, controlled
-- from admin settings. It lives on `companies` rather than in a new table
-- because there is exactly one active announcement at a time and the portal
-- already loads the company row on every page (useCompany) — a new table would
-- add a query and an RLS policy to carry one string.
--
-- Idempotent: add column if not exists, no drops.

alter table public.companies
  add column if not exists announcement_ar text,
  add column if not exists announcement_en text,
  add column if not exists announcement_enabled boolean not null default false;

comment on column public.companies.announcement_enabled is
  'Master switch for the portal header banner. Off by default so the columns can
   be populated before the banner goes live.';
