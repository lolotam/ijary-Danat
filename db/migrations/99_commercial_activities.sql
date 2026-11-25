-- 99_commercial_activities.sql
--
-- Commercial activity on contracts — the kind of shop a unit hosts (bakery,
-- grocery, salon, …). The vocabulary is owned by the operator at Settings →
-- Lists, so they can add, rename and deactivate activities without a
-- deployment. After migration 61 those seeded rows are deletable too, so the
-- starter set below really is a starting point rather than a fixture.
--
-- The column is free text rather than a foreign key to option_list_items, which
-- is the established pattern here (`tenants.category` and friends do the same).
-- The trade is deliberate: deleting an activity from the catalogue leaves any
-- contract still carrying its value, which reads as a stale label rather than
-- failing the delete or silently rewriting business records.
--
-- No grant or revoke: a plain column addition inherits the table's existing
-- grants (established elsewhere). Changing them here would be out of scope.

alter table public.contracts
  add column if not exists commercial_activity text;

insert into public.option_lists (code, name_ar, name_en, description_ar, description_en, is_system)
values (
  'commercial_activities',
  'الأنشطة التجارية',
  'Commercial activities',
  'أنواع النشاط التجاري التي تُختار على العقود',
  'Commercial activity types selectable on contracts',
  true
)
on conflict (code) do nothing;

select public._seed_option_items('commercial_activities', $j$[
  {"value": "bakery",      "label_ar": "مخبز",        "label_en": "Bakery",      "sort_order": 1},
  {"value": "grocery",     "label_ar": "بقالة",       "label_en": "Grocery",     "sort_order": 2},
  {"value": "fish_shop",   "label_ar": "محل أسماك",   "label_en": "Fish shop",   "sort_order": 3},
  {"value": "mobile_shop", "label_ar": "محل هواتف",   "label_en": "Mobile shop", "sort_order": 4},
  {"value": "salon",       "label_ar": "صالون",       "label_en": "Salon",       "sort_order": 5},
  {"value": "pharmacy",    "label_ar": "صيدلية",      "label_en": "Pharmacy",    "sort_order": 6},
  {"value": "restaurant",  "label_ar": "مطعم",        "label_en": "Restaurant",  "sort_order": 7}
]$j$);
