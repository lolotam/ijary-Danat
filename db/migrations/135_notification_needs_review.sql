-- 135_notification_needs_review.sql
-- Adds the 'needs_review' notification state and an error_code column so the
-- drain job can park an indeterminate Postora send instead of retrying it.
-- Schema-only: enum ADD VALUE + column add. No DML uses the new label here —
-- Postgres forbids that in the same transaction as the ALTER TYPE (same split
-- as 31/32). Idempotent.

------------------------------------------------------------
-- error_code: typed partner-API error code (nullable, free-text failure_reason
-- already exists). The drain job reads this to decide needs_review vs. retry.
------------------------------------------------------------

alter table public.notifications
  add column if not exists error_code text;

------------------------------------------------------------
-- needs_review state: a human must decide (indeterminate send, etc.)
------------------------------------------------------------

do $$ begin
  alter type public.notification_states add value if not exists 'needs_review';
exception
  when duplicate_object then null;
  when others then
    begin
      alter type public.notification_states add value 'needs_review';
    exception when duplicate_object then null;
    end;
end $$;
