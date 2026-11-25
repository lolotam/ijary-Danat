-- 104_property_paci_and_counts.sql
--
-- Three declared attributes on public.properties, entered on the Add/Edit
-- Property form and shown on the property detail page:
--
--   paci_no     — Kuwait civil-information building number (الرقم الآلي للمبنى)
--   floor_count — how many floors the property has (declared figure)
--   unit_count  — how many units the property has (declared figure)
--
-- unit_count is NOT the number of unit records. public.units already has a
-- property_id FK; the app derives a live count from that in the properties
-- table column and the detail Summary card. This column is a separate fact —
-- the declared unit total on the permit / PACI record — typed by the operator.
-- Drift from the derived count is expected; do not replace, reconcile, or
-- badge-compare them.
--
-- floor_count is likewise not a denormalisation of buildings.floors (which is
-- per-building). A property may hold several buildings; the property-level
-- figure is a separate declared count. Do not sum, sync, or cross-check them.
--
-- Design decisions (do not "tighten" later without a deliberate product change):
--
--   * paci_no is text, not numeric. It is an identifier, not a quantity:
--     leading zeros are significant and arithmetic on it is meaningless.
--   * All three columns are nullable with no default. Existing rows carry none
--     of these values; a NOT NULL column would force a fabricated default.
--   * No unique constraint and no index on any of them. The table is small
--     enough that an index earns nothing. Uniqueness on paci_no is wrong: a
--     "property" here may be a compound that spans more than one PACI-numbered
--     address, and a unique constraint would reject legitimate data.
--   * No format CHECK on paci_no. Kuwait PACI numbers are numeric today, but a
--     format constraint that turns out to be wrong blocks data entry on a live
--     system and needs another migration to relax. Free text, validated nowhere
--     — a deliberate choice, not an omission.
--   * integer (not smallint or numeric) for the two counts, matching
--     buildings.floors.
--   * No grant and no revoke: plain column additions inherit the table's
--     existing grants, and its three RLS policies apply unchanged. Adding
--     grants here would be out of scope — same note as migration 101 for
--     units.floor.
--
-- Non-negative CHECKs on the counts: a bare `>= 0` is correct even though the
-- columns are nullable. A CHECK evaluates to NULL for a NULL input, and a NULL
-- result does not violate the constraint, so nullable + `>= 0` needs no
-- `is null or` clause.
--
-- Idempotent: a second run changes nothing and raises nothing. Columns use
-- `add column if not exists`. Constraints are guarded with a `do $$ ... $$`
-- block that checks pg_constraint before `add constraint` — a bare
-- `add constraint` is not idempotent and would raise on re-run.

alter table public.properties
  add column if not exists paci_no text;

alter table public.properties
  add column if not exists floor_count integer;

alter table public.properties
  add column if not exists unit_count integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'properties_floor_count_nonnegative'
      and conrelid = 'public.properties'::regclass
  ) then
    alter table public.properties
      add constraint properties_floor_count_nonnegative
      check (floor_count >= 0);
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'properties_unit_count_nonnegative'
      and conrelid = 'public.properties'::regclass
  ) then
    alter table public.properties
      add constraint properties_unit_count_nonnegative
      check (unit_count >= 0);
  end if;
end $$;
