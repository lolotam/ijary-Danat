-- 47_company_bank_logo_and_info_notification.sql
-- Two independent schema changes that back the "Company Information PDF" feature:
--   1. public.companies.bank_logo_url — optional URL to the company's bank logo,
--      surfaced on the settings page and rendered on the company-info letterhead.
--   2. notification_types enum gains 'company_info' so the manual-message
--      templates section can offer a "Send Company Information" template that
--      attaches the generated company-info PDF.
-- Idempotent.

------------------------------------------------------------
-- 1. companies.bank_logo_url
------------------------------------------------------------
alter table public.companies
  add column if not exists bank_logo_url text;

------------------------------------------------------------
-- 2. notification_types enum extension
-- New enum labels cannot be USED in DML/casts until the transaction commits,
-- so any seed row that references 'company_info' must live in a LATER
-- migration than this one. Mirrors the pattern in migration 31 (whose seeds
-- landed separately in 32).
--
-- No seed migration ships with this change by design: the two
-- "Send Company Information" templates (company-info-ar / company-info-en)
-- are created by an admin through Settings → Notifications → Templates.
------------------------------------------------------------
do $$ begin
  alter type public.notification_types add value if not exists 'company_info';
exception
  when duplicate_object then null;
  when others then
    begin
      alter type public.notification_types add value 'company_info';
    exception when duplicate_object then null;
    end;
end $$;
