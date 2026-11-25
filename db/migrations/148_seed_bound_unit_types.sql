-- 148_seed_bound_unit_types.sql
--
-- Seeds the four `unit_types` catalogue values that `src/lib/unitFloorTypeBinding.ts`
-- maps the four seeded `unit_floors` onto.
--
-- WHY THIS EXISTS AT ALL
-- These four rows were typed into the live Settings -> Lists screen by the owner
-- and have never been in a migration. They therefore exist in production and
-- nowhere else: a database built by `bun run test:db` has none of them, so the
-- floor-to-type binding would point at values that do not exist, the locked Type
-- control would render empty, and the SQL suite would never notice because it
-- has no rows to contradict.
--
-- VALUES ARE COPIED EXACTLY, TYPO INCLUDED
-- `commercial_unit_basment` is misspelt and `Roof_Apartment` / `shop_G_Floor`
-- are mixed case. That is the owner's data, and `units.type` is free text
-- (migration 103) storing these strings on 142 live rows. "Correcting" a value
-- here would orphan every unit carrying it — the label is what the user reads,
-- and the label is fixable from Settings without a deploy. Do not tidy these.
--
-- `_seed_option_items` is idempotent (`on conflict (list_id, value) do nothing`),
-- so this is inert against production and creates the rows anywhere else. After
-- migration 61 seeded rows are deletable, so an owner who does not want one of
-- these is not fought by the migration re-applying it.

insert into public.option_lists (code, name_ar, name_en, description_ar, description_en, is_system)
values (
  'unit_types',
  'أنواع الوحدات',
  'Unit types',
  'أنواع الوحدات المتاحة عند إضافة وحدة',
  'Unit types selectable when adding a unit',
  true
)
on conflict (code) do nothing;

select public._seed_option_items('unit_types', $j$[
  {"value": "shop_G_Floor",              "label_ar": "محل دور أرضي",       "label_en": "Shop G Floor",              "sort_order": 1},
  {"value": "commercial_unit_1st_floor", "label_ar": "وحدة تجارية دور أول", "label_en": "Commercial Unit 1st Floor", "sort_order": 2},
  {"value": "commercial_unit_basment",   "label_ar": "وحدة تجارية قبو",     "label_en": "Commercial Unit Basment",   "sort_order": 3},
  {"value": "Roof_Apartment",            "label_ar": "شقة سطح",             "label_en": "Roof Apartment",            "sort_order": 4}
]$j$);
