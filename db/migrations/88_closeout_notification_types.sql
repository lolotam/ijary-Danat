-- ---------------------------------------------------------------------------
-- 88 - notification types for contract close-out and restore
-- ---------------------------------------------------------------------------
--
-- SEPARATE FILE ON PURPOSE. `notification_types` is a real Postgres enum
-- (07_phase5_notifications_reports.sql:8). `alter type ... add value` may run
-- inside a transaction block, but the new value CANNOT BE USED in that same
-- transaction. Migrations are applied with --single-transaction, so seeding a
-- notification_templates row that references one of these in the same file
-- fails with "unsafe use of new value of enum type". Migration 89 uses them.
--
-- Each gets its own type rather than overloading an existing one: the
-- notification pool's type filter is what makes the log usable, and filing a
-- close-out admin email under "Contract ended" would quietly break it.

alter type public.notification_types add value if not exists 'contract_closeout';
alter type public.notification_types add value if not exists 'contract_restored';
