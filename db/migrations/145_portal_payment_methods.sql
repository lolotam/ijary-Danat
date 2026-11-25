-- 145_portal_payment_methods.sql
--
-- KNET is the base payment method of the tenant portal and is not configurable:
-- it is the rail every Kuwaiti tenant can use, and `paymentHandoffFor`
-- (src/lib/paymentHandoff.ts) can never mark it unavailable on any device. Apple
-- Pay and Google Pay are additions on top of it, and these two switches decide
-- whether the portal offers them at all.
--
-- Why that asymmetry is encoded as two booleans rather than a list of enabled
-- methods: a list makes "no method at all" representable, and every consumer
-- then has to defend against an empty payment menu. With KNET structurally
-- always present, that state cannot be written down, so nothing has to handle
-- it. The same reasoning put `announcement_enabled` here in migration 122
-- instead of in a table of its own.
--
-- Both default to TRUE deliberately. Production shows all three methods today,
-- and a push to `main` auto-deploys, so the existing companies row must land
-- with today's exact behaviour and change nothing for tenants until an admin
-- turns a switch off.
--
-- Idempotent: add column if not exists, no drops.

alter table public.companies
  add column if not exists portal_apple_pay_enabled boolean not null default true,
  add column if not exists portal_google_pay_enabled boolean not null default true;

comment on column public.companies.portal_apple_pay_enabled is
  'Offers Apple Pay in the tenant portal alongside KNET. On by default to
   preserve the behaviour that shipped before this column existed. Devices that
   cannot run Apple Pay still filter it out client-side regardless of this flag.';

comment on column public.companies.portal_google_pay_enabled is
  'Offers Google Pay in the tenant portal alongside KNET. On by default to
   preserve the behaviour that shipped before this column existed.';
