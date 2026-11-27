-- 331_custom_domains.sql (T191)
--
-- يضيف إلى `company_domains` عمودَي تدفّق النطاق المخصّص: سجلات إثبات الملكية
-- التي يعيدها المزوّد، ووقت آخر قراءة لحالة النطاق.
--
-- Per data-model.md `company_domains` and research.md R5 (Cloudflare for SaaS
-- custom hostnames):
--   - Migration 254 already created the table with `kind`, `verification_status`
--     and `provider_ref`, which is exactly what the host resolver reads; what
--     was missing were the two columns only the custom-domain flow needs.
--   - `verification_records` holds the ownership-check records (the TXT or HTTP
--     challenge) that the domain owner has to publish in DNS. Without them the
--     super admin cannot tell the company what to add, so the ownership check
--     (FR-076) could never be finished.
--   - `last_checked_at` records when the status was last read from the provider,
--     so a stale status is never shown as a fresh one.
--   - No new policy: the table has had forced RLS and a
--     `company_id = (select public.current_company_id())` policy since migration
--     254, so the two new columns inherit the same isolation.
--
-- Rollback:
--   alter table public.company_domains drop column if exists verification_records;
--   alter table public.company_domains drop column if exists last_checked_at;

alter table public.company_domains
  add column if not exists verification_records jsonb,
  add column if not exists last_checked_at timestamptz;

comment on column public.company_domains.verification_records is
  'سجلات إثبات الملكية التي يعيدها المزوّد بصيغة JSON (تحدّ TXT أو HTTP وهدف CNAME)';

comment on column public.company_domains.last_checked_at is
  'آخر مرة قُرئت فيها حالة النطاق من المزوّد';
