-- ---------------------------------------------------------------------------
-- 92 - notification types for invoice write-off and dispute events
-- ---------------------------------------------------------------------------
--
-- SEPARATE FILE ON PURPOSE. `notification_types` is a real Postgres enum
-- (07_phase5_notifications_reports.sql:8). `alter type ... add value` may run
-- inside a transaction block, but the new value CANNOT BE USED in that same
-- transaction. Migrations are applied with --single-transaction, so seeding a
-- notification_templates row that references one of these in the same file
-- fails with "unsafe use of new value of enum type". Migration 93 uses them.
--
-- Each gets its own type rather than overloading an existing one: the
-- notification pool's type filter is what makes the log usable, and filing a
-- write-off admin email under "Refund recorded" would quietly break it.

alter type public.notification_types add value if not exists 'invoice_written_off';
alter type public.notification_types add value if not exists 'invoice_disputed';
