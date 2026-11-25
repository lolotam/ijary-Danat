-- ============================================================================
-- 206 — gmail_messages.gmail_id: العمود الذي يسمح لمزامنة Gmail أن تعرف ما
-- لديها أصلاً قبل أن تطلبه من جديد.
--
-- The sync job listed every message in its 30-day window and then issued one
-- `messages.get?format=full` per listed id — including the ~208 it had already
-- stored — every ten minutes. Those refetches were then thrown away, because
-- the upsert uses `ignoreDuplicates`, so the entire cost bought nothing.
--
-- Measured against the live mailbox on 2026-09-14: 99 full gets succeeded, and
-- a second batch immediately after was refused at get number 6. That puts the
-- real budget at ~105 `format=full` gets per minute per user — roughly 57 quota
-- units each, not the 5 the published table lists. A 208-message run crosses it
-- about 27 seconds in, which is exactly the duration every failed run recorded
-- before returning HTTP 403 `rateLimitExceeded`.
--
-- To skip a stored message the job has to recognise it, and it cannot:
-- `message_id` holds the RFC 822 Message-ID header (or a `gmail:<id>` fallback)
-- while the list endpoint returns Gmail's own id. This column exposes that id.
--
-- Generated rather than written by the application, so it cannot drift from
-- `raw_payload` and needs no backfill — every existing row acquires its value
-- when the column is added. Rows from other providers simply carry NULL.
-- ============================================================================

alter table public.gmail_messages
  add column if not exists gmail_id text
    generated always as (raw_payload ->> 'id') stored;

comment on column public.gmail_messages.gmail_id is
  'Gmail''s own immutable message id, projected from raw_payload. The sync job diffs the ids the list endpoint returns against this column so it only fetches messages it has never seen; message_id cannot serve because it holds the RFC 822 header instead. NULL for rows that did not come from Gmail.';

-- The sync's only query shape: "which of these ids do we already hold, for this
-- company?". Partial, because the NULLs are rows this job never looks at.
create index if not exists gmail_messages_company_gmail_id_idx
  on public.gmail_messages (company_id, gmail_id)
  where gmail_id is not null;
