-- ============================================================================
-- 208 — gmail_id يقتصر على الصفوف التي تحمل حمولة كاملة، لا كل صف فيه معرّف.
--
-- Migration 206 projected `gmail_id` from `raw_payload ->> 'id'` for every row,
-- so the sync job could skip messages it had already stored. Review finding on
-- PR #208: that is one row too many.
--
-- `recordLocalSentMessage` (src/fns/gmailSend.ts) writes a **thin** row the
-- moment a message is sent from the app — `{ id, threadId, snippet, source:
-- 'gmailSend' }` and nothing else. It carries the Gmail id, so 206's expression
-- populated `gmail_id`, so the sync would treat that message as already held
-- and never fetch its real `format=full` body. The consequences are not
-- hypothetical: three separate readers need the MIME tree that only the full
-- payload carries —
--
--   * GmailMessageSheet renders `raw_payload.payload`
--   * gmailAttachment resolves attachment parts from it
--   * buildReplyHeaders reads Message-ID / References out of it, and without
--     them a reply silently starts a new thread
--
-- So an attachment sent through the compose dialog would never appear, and
-- replies to app-sent mail would lose their threading, permanently.
--
-- `raw_payload ? 'payload'` is the right discriminator rather than
-- `source = 'gmailSend'`: it is already the contract those three readers rely
-- on, and it excludes *any* thin writer rather than the one we happen to know
-- about. A `format=full` response always carries `payload`.
--
-- A generated column's expression cannot be altered in place, so the column is
-- dropped and re-added. The data is derived, so nothing is lost; the index is
-- dropped with the column and re-created below.
-- ============================================================================

drop index if exists public.gmail_messages_company_gmail_id_idx;

alter table public.gmail_messages
  drop column if exists gmail_id;

alter table public.gmail_messages
  add column gmail_id text
    generated always as (
      case when raw_payload ? 'payload' then raw_payload ->> 'id' end
    ) stored;

comment on column public.gmail_messages.gmail_id is
  'Gmail''s own immutable message id, projected from raw_payload — but only for rows that carry a full format=full payload. The sync job diffs the ids the list endpoint returns against this column so it fetches only messages whose full body it does not yet hold; message_id cannot serve, because it holds the RFC 822 header instead. NULL for rows from other providers and for the thin placeholder rows gmailSend writes when a message leaves the app, so the sync still fetches their real payload.';

create index if not exists gmail_messages_company_gmail_id_idx
  on public.gmail_messages (company_id, gmail_id)
  where gmail_id is not null;
