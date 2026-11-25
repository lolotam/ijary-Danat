-- 102_gmail_messages_is_read_backfill.sql
--
-- Gmail sync used to hardcode is_read = false on every import
-- (src/fns/gmailSyncJob.ts). Gmail's UNREAD label was already present in
-- raw_payload->'labelIds' (format=full) but never consulted, so already-read
-- history inflated the inbox badge as a total and re-climbed after every tick.
--
-- This backfill corrects ONLY the phantom set:
--   is_read = false AND Gmail does NOT have UNREAD
--   → mark read (imported wrong; Gmail considers them read).
--
-- Deliberate local marks MUST NOT be touched:
--   is_read = true AND Gmail still has UNREAD
--   → staff marked read in-app. The app never writes back to Gmail (that would
--     need the restricted gmail.modify scope, which migration 62 deliberately
--     avoids). Overwriting those would undo user work and make the bug worse.
--
-- The update never sets is_read = false. It only clears phantoms.
-- Idempotent by construction: a re-run matches zero rows (already is_read = true).
--
-- jsonb `?` operator: "does the text exist as a top-level key or array
-- element?" labelIds is stored as a JSON array of strings
-- (["UNREAD","INBOX",...]), so raw_payload->'labelIds' ? 'UNREAD' is true when
-- UNREAD is an element — same shape and operator as migration 100's SENT
-- backfill. No grants, revokes, columns, or indexes.

update public.gmail_messages
   set is_read = true,
       updated_at = now()
 where is_read = false
   and not (raw_payload->'labelIds' ? 'UNREAD');
