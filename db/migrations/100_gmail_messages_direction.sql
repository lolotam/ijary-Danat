-- 100_gmail_messages_direction.sql
--
-- Split the admin Inbox Gmail tab into Received / Sent. The sync already pulls
-- both folders (list query is `q=newer_than:<window>` with no label filter), so
-- every row already carries the answer in raw_payload->'labelIds'. This column
-- makes that filterable without re-parsing JSON on every list query.
--
-- Classification rule — SENT wins when both labels are present:
--   A message the account sent is a *sent* message even if a copy also lands
--   in INBOX (Gmail does that when the account mails an address that delivers
--   back to itself). Roughly a fifth of live rows carry both labels; without
--   a deterministic rule those would flip tabs depending on array order.
--
-- The column is deliberately nullable (no NOT NULL). An insert from an older
-- code path mid-deploy would fail on a hard constraint, and the read path
-- treats null as 'received' so pre-backfill or mid-deploy rows still appear
-- under Received.
--
-- Free text + CHECK rather than a new enum — same pattern as payments.status
-- and concessions.status. No grants or revokes: a plain column addition
-- inherits the table's existing grants (established in migration 50).

alter table public.gmail_messages
  add column if not exists direction text
    check (direction in ('received', 'sent'));

-- jsonb `?` operator: "does the text exist as a top-level key or array
-- element?" labelIds is stored as a JSON array of strings
-- (["SENT","INBOX",...]), so `raw_payload->'labelIds' ? 'SENT'` is true when
-- SENT is an element. That is shorter and index-friendly compared to
-- jsonb_array_elements_text; both are equivalent for this shape.
update public.gmail_messages
   set direction = case
         when raw_payload->'labelIds' ? 'SENT' then 'sent'
         else 'received'
       end
 where direction is null;

create index if not exists gmail_messages_direction_idx
  on public.gmail_messages (company_id, direction, received_at desc);
