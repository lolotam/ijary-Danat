-- 154_kuwait_banks_catalogue.sql
--
-- The bank list the deposit form's dropdown reads.
--
-- An option list, not a new table: Settings -> Lists already edits these in both
-- languages, toggles them inactive and orders them. `deposits.bank_name` stays
-- free text, so the form uses the `mapCatalogueOptions` / `useCatalogueLabel`
-- pair (the migration 99/101/103 pattern) rather than `useListDrivenOptions`,
-- which filters against a Postgres enum's values and would return nothing for a
-- catalogue with no enum behind it.

------------------------------------------------------------
-- 1. The Kuwaiti bank catalogue
------------------------------------------------------------

-- An option list, not a new table: Settings -> Lists already edits these in both
-- languages, toggles them inactive, and orders them. `deposits.bank_name` is
-- free text, so the form uses the `mapCatalogueOptions` / `useCatalogueLabel`
-- pair (the migration 99/101/103 pattern) rather than `useListDrivenOptions`,
-- which filters against a Postgres enum's values and would return nothing here.

insert into public.option_lists (code, name_ar, name_en, description_ar, description_en, is_system)
values (
  'kuwait_banks',
  'البنوك الكويتية',
  'Kuwaiti banks',
  'البنوك المتاحة عند تسجيل إيداع بنكي',
  'Banks selectable when recording a bank deposit',
  true
)
on conflict (code) do nothing;

select public._seed_option_items('kuwait_banks', $j$[
  {"value": "National Bank of Kuwait",      "label_ar": "بنك الكويت الوطني",   "label_en": "National Bank of Kuwait",      "sort_order": 10},
  {"value": "Kuwait Finance House",         "label_ar": "بيت التمويل الكويتي", "label_en": "Kuwait Finance House",         "sort_order": 20},
  {"value": "Gulf Bank",                    "label_ar": "بنك الخليج",          "label_en": "Gulf Bank",                    "sort_order": 30},
  {"value": "Burgan Bank",                  "label_ar": "بنك برقان",           "label_en": "Burgan Bank",                  "sort_order": 40},
  {"value": "Commercial Bank of Kuwait",    "label_ar": "البنك التجاري الكويتي","label_en": "Commercial Bank of Kuwait",   "sort_order": 50},
  {"value": "Al Ahli Bank of Kuwait",       "label_ar": "البنك الأهلي الكويتي", "label_en": "Al Ahli Bank of Kuwait",      "sort_order": 60},
  {"value": "Boubyan Bank",                 "label_ar": "بنك بوبيان",          "label_en": "Boubyan Bank",                 "sort_order": 70},
  {"value": "Warba Bank",                   "label_ar": "بنك وربة",            "label_en": "Warba Bank",                   "sort_order": 80},
  {"value": "Kuwait International Bank",    "label_ar": "بنك الكويت الدولي",   "label_en": "Kuwait International Bank",    "sort_order": 90},
  {"value": "Industrial Bank of Kuwait",    "label_ar": "بنك الكويت الصناعي",  "label_en": "Industrial Bank of Kuwait",    "sort_order": 100},
  {"value": "Ahli United Bank",             "label_ar": "البنك الأهلي المتحد", "label_en": "Ahli United Bank",             "sort_order": 110}
]$j$::jsonb);

-- Ahli United Bank Kuwait was absorbed into Kuwait Finance House, so it is not a
-- bank anyone should pick today. Seeded anyway, inactive, so a historical
-- deposit naming it still resolves to a label instead of printing the raw
-- string. Only the first application deactivates it — an owner who reactivates
-- it from Settings is not overruled on the next run.
update public.option_list_items i
   set is_active = false
  from public.option_lists l
 where l.id = i.list_id
   and l.code = 'kuwait_banks'
   and i.value = 'Ahli United Bank'
   and i.created_at = i.updated_at;
