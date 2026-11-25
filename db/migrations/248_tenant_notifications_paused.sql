-- 248_tenant_notifications_paused.sql
--
-- يضيف مفتاحاً لإيقاف كل إشعارات المستأجر
--
-- Owner decision 2026-10-20: one switch per tenant that stops every
-- notification bound to that tenant — automatic or manual — from reaching it
-- by email or WhatsApp.
--
-- The copies addressed to the admin or the company keep going. The flag
-- belongs to the tenant, not to the notification: an admin who asks for a
-- receipt copy still gets it, and the company inbox still sees what happened.
--
-- Writing the flag is already covered by the existing `tenants_update_permitted`
-- policy, so no policy change is needed here.

begin;

alter table public.tenants
  add column if not exists notifications_paused boolean not null default false;

comment on column public.tenants.notifications_paused is
  'يوقف كل الإشعارات الموجّهة للمستأجر (بريد وواتساب) عند true. Pauses every tenant-bound notification; admin and company copies are unaffected.';

commit;
