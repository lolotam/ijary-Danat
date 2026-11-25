-- 157_email_webhook_events_result_comment.sql
--
-- Corrects the `result` column comment written by migration 156, which listed
-- two values the handler never writes (`transient_bounce`, `replay`) and omitted
-- two it does (`unparsable_payload`, `already_terminal`).
--
-- 156 is already applied to production, and editing an applied migration in
-- place does not reach a migrated database — the comment would stay wrong
-- everywhere it matters. Hence a new file rather than a fix to the old one.
--
-- `transient_bounce` is now genuinely written (it was the one value in the
-- original list worth having): filed as plain `ignored_event_type`, a soft
-- bounce was indistinguishable from an `email.opened`, so the archive could not
-- answer the one diagnostic question it exists for.

comment on column public.email_webhook_events.result is
  'What the handler did. Verified: applied, already_terminal, transient_bounce, ignored_event_type, unparsable_payload, unmatched. Rejected: unverified.';
