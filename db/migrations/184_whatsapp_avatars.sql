-- 184_whatsapp_avatars.sql
-- Adds avatar_url to WhatsApp chats and contacts. Evolution's findChats /
-- findContacts records carry the WhatsApp profile-picture CDN URL
-- (pps.whatsapp.net); the history sweep captures it so every chat thread and
-- contact row can show the person's picture. The URLs expire on WhatsApp's
-- side after a while — re-running Sync history refreshes them, and the UI
-- falls back to initials for a dead link. Idempotent.

alter table public.whatsapp_chats add column if not exists avatar_url text;
alter table public.whatsapp_contacts add column if not exists avatar_url text;
