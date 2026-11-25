-- 138_gmail_failed_recipients.sql
--
-- Persist Gmail's X-Failed-Recipients on the list row so the inbox can
-- flag a delivery failure without selecting raw_payload (which is the
-- whole format=full MIME tree and is omitted from GMAIL_LIST_COLUMNS
-- on purpose). Native Mailer-Daemon mail is still detected from
-- from_address; this column is what makes a header-only / forwarded
-- DSN visible in the list.
--
-- Nullable, no backfill: existing rows stay null. The list still
-- matches mailer-daemon@googlemail.com / @google.com from from_address.
-- The next sync writes the header for new messages. ignoreDuplicates
-- means already-stored DSNs are not rewritten.

alter table public.gmail_messages
  add column if not exists failed_recipients text;

comment on column public.gmail_messages.failed_recipients is
  'X-Failed-Recipients header, copied at sync so the inbox list can detect a DSN without loading raw_payload.';
