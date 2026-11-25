-- ---------------------------------------------------------------------------
-- 252 - notification type for WhatsApp QR session disconnect alerts
-- ---------------------------------------------------------------------------
--
-- SEPARATE FILE ON PURPOSE. `notification_types` is a real Postgres enum
-- (07_phase5_notifications_reports.sql:8). `alter type ... add value` may run
-- inside a transaction block, but the new value CANNOT BE USED in that same
-- transaction. Migrations are applied with --single-transaction, so seeding a
-- notification_templates row that references `whatsapp_session_alert` in the
-- same file fails with "unsafe use of new value of enum type". Migration 253
-- uses it.
--
-- Dedicated type rather than overloading `manual_message`: the notification
-- pool's type filter is what makes the log usable (same rule as migration 92).

alter type public.notification_types add value if not exists 'whatsapp_session_alert';
