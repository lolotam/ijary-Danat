-- 101_unit_floors.sql
--
-- Floor label on units — which level of the building a unit sits on (ground,
-- first, basement, roof, …). The vocabulary is owned by the operator at
-- Settings → Lists, so they can add, rename and deactivate floors without a
-- deployment. After migration 61 those seeded rows are deletable too, so the
-- starter set below really is a starting point rather than a fixture.
--
-- The column is free text rather than an enum or a foreign key to
-- option_list_items. `unit_types` and `unit_statuses` are enum-backed because
-- their values are load-bearing in SQL (filters, occupancy derivation, write
-- guards). Floor is only a label — free text lets the owner add "Second floor"
-- or "Mezzanine" in Settings → Lists without a migration, and matches how
-- `commercial_activities` (migration 99) and `gmail_messages.category` work.
--
-- The trade is deliberate: deleting a floor from the catalogue leaves any unit
-- still carrying its value, which reads as a stale label rather than failing
-- the delete or silently rewriting business records.
--
-- No grant or revoke: a plain column addition inherits the table's existing
-- grants (established elsewhere). Changing them here would be out of scope.

alter table public.units
  add column if not exists floor text;

insert into public.option_lists (code, name_ar, name_en, description_ar, description_en, is_system)
values (
  'unit_floors',
  'طوابق الوحدات',
  'Unit floors',
  'طوابق المبنى التي تُختار على الوحدات',
  'Building floors selectable on units',
  true
)
on conflict (code) do nothing;

select public._seed_option_items('unit_floors', $j$[
  {"value": "ground",   "label_ar": "الطابق الأرضي", "label_en": "Ground floor", "sort_order": 1},
  {"value": "first",    "label_ar": "الطابق الأول",  "label_en": "First floor",  "sort_order": 2},
  {"value": "basement", "label_ar": "القبو",         "label_en": "Basement", "sort_order": 3},
  {"value": "roof",     "label_ar": "السطح",         "label_en": "Roof",     "sort_order": 4}
]$j$);
