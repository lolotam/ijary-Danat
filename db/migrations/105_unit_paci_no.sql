-- 105_unit_paci_no.sql
--
-- One declared attribute on public.units, entered on the unit Add/Edit form
-- and shown on the unit detail page and the units list:
--
--   paci_no — Kuwait civil-information unit number (الرقم الآلي للوحدة)
--
-- Direct, smaller analogue of migration 104 (property paci_no / floor_count /
-- unit_count): one column instead of three, and no CHECK constraints.
--
-- Design decisions (do not "tighten" later without a deliberate product change):
--
--   * paci_no is text, not numeric. It is an identifier, not a quantity:
--     leading zeros are significant and arithmetic on it is meaningless.
--   * Nullable with no default. public.units is currently empty, but a NOT NULL
--     column would still be wrong: not every unit has a civil number recorded.
--   * No unique constraint and no index. The table is tiny; uniqueness is not
--     guaranteed by the source data and a constraint would reject legitimate
--     rows.
--   * No format CHECK. A wrong format constraint blocks data entry on a live
--     system and needs another migration to relax. Free text, validated
--     nowhere — a deliberate choice, not an omission.
--   * No grant and no revoke: a plain column addition inherits the table's
--     existing grants and RLS policies. Same note migrations 101 and 104 make.
--
-- Idempotent: `add column if not exists`; a second run changes nothing.

alter table public.units
  add column if not exists paci_no text;
