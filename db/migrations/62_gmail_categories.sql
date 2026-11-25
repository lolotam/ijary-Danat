-- 62_gmail_categories.sql
--
-- Categorising synced Gmail messages, per the owner's choice of app-local
-- categories over real Gmail labels.
--
-- Labels would have needed `gmail.modify` — a restricted Google scope and a
-- much larger consent screen — to write anything back. App-local categories
-- need no scope at all, and they reuse the catalogue machinery the owner
-- already manages at Settings → Lists, so the vocabulary is editable without a
-- deployment. After migration 61 those seeded rows are deletable too, so the
-- starter set below really is a starting point rather than a fixture.
--
-- The column is free text rather than a foreign key to option_list_items, which
-- is the established pattern here (`tenants.category` and friends do the same).
-- The trade is deliberate: deleting a category from the catalogue leaves any
-- message still carrying its value, which reads as a stale chip rather than
-- failing the delete or silently rewriting mail rows.

alter table public.gmail_messages
  add column if not exists category text;

-- Supports the tab's category filter; partial because most messages are
-- uncategorised and those are served by the existing received_at index.
create index if not exists gmail_messages_category_idx
  on public.gmail_messages (company_id, category)
  where category is not null;

insert into public.option_lists (code, name_ar, name_en, description_ar, description_en, is_system)
values (
  'gmail_categories',
  'تصنيفات البريد',
  'Email categories',
  'تصنيفات تُطبَّق على رسائل البريد في صندوق الوارد',
  'Categories applied to messages in the unified inbox',
  true
)
on conflict (code) do nothing;

select public._seed_option_items('gmail_categories', $j$[
  {"value": "inquiry",   "label_ar": "استفسار",        "label_en": "Inquiry",        "sort_order": 1},
  {"value": "complaint", "label_ar": "شكوى",           "label_en": "Complaint",      "sort_order": 2},
  {"value": "maintenance","label_ar": "صيانة",          "label_en": "Maintenance",    "sort_order": 3},
  {"value": "payment",   "label_ar": "دفعات",           "label_en": "Payment",        "sort_order": 4},
  {"value": "contract",  "label_ar": "عقود",            "label_en": "Contract",       "sort_order": 5},
  {"value": "supplier",  "label_ar": "موردون",          "label_en": "Supplier",       "sort_order": 6},
  {"value": "spam",      "label_ar": "غير مرغوب",       "label_en": "Spam",           "sort_order": 7},
  {"value": "other",     "label_ar": "أخرى",            "label_en": "Other",          "sort_order": 8}
]$j$);

-- Staff already hold UPDATE on gmail_messages (migration 50) for mark-read, and
-- that policy is row-level with no column list, so assigning a category needs no
-- new grant. Stated here so the absence of one is not read as an oversight.
