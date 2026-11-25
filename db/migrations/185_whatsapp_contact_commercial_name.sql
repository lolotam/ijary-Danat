-- 185_whatsapp_contact_commercial_name.sql
-- Adds the commercial (business/project) name to WhatsApp contacts. Tenants
-- here are businesses — the person's name and the shop's name are different
-- facts, and the admin needs both on the contact card and in the contacts
-- table. Idempotent.

alter table public.whatsapp_contacts add column if not exists commercial_name text;
