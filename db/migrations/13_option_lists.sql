-- 13_option_lists.sql
-- Catalog-driven dropdown values, editable from the Settings > Lists page.
-- Idempotent. Seed rows use ON CONFLICT so re-running preserves user edits.

create table if not exists public.option_lists (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name_ar        text not null,
  name_en        text not null,
  description_ar text,
  description_en text,
  is_system      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.option_list_items (
  id             uuid primary key default gen_random_uuid(),
  list_id        uuid not null references public.option_lists(id) on delete cascade,
  value          text not null,
  label_ar       text not null,
  label_en       text not null,
  sort_order     integer not null default 0,
  is_active      boolean not null default true,
  is_system      boolean not null default false,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (list_id, value)
);

create index if not exists option_list_items_list_idx on public.option_list_items (list_id, sort_order);

grant select, insert, update, delete on public.option_lists to authenticated;
grant select, insert, update, delete on public.option_list_items to authenticated;
grant all on public.option_lists to service_role;
grant all on public.option_list_items to service_role;

alter table public.option_lists enable row level security;
alter table public.option_list_items enable row level security;

drop policy if exists option_lists_select on public.option_lists;
create policy option_lists_select on public.option_lists
  for select to authenticated using (true);

drop policy if exists option_lists_write on public.option_lists;
create policy option_lists_write on public.option_lists
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

drop policy if exists option_list_items_select on public.option_list_items;
create policy option_list_items_select on public.option_list_items
  for select to authenticated using (true);

drop policy if exists option_list_items_write on public.option_list_items;
create policy option_list_items_write on public.option_list_items
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- Seed the lists mirrored from PRD dropdowns. Values match existing enums so
-- app code can keep using enum types while the label text stays editable.
insert into public.option_lists (code, name_ar, name_en, is_system) values
  ('tenant_categories',   'تصنيفات المستأجرين',  'Tenant categories',   true),
  ('tenant_lifecycles',   'حالات دورة المستأجر',  'Tenant lifecycles',   true),
  ('contract_types',      'أنواع العقود',         'Contract types',      true),
  ('contract_states',     'حالات العقود',         'Contract states',     true),
  ('property_types',      'أنواع العقارات',       'Property types',      true),
  ('unit_types',          'أنواع الوحدات',        'Unit types',          true),
  ('unit_statuses',       'حالات الوحدات',        'Unit statuses',       true),
  ('expense_categories',  'فئات المصروفات',       'Expense categories',  true),
  ('payment_methods',     'طرق الدفع',            'Payment methods',     true)
on conflict (code) do nothing;

-- Helper: bulk-seed enum-driven items for a given list.
create or replace function public._seed_option_items(
  _code text,
  _items jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  _list_id uuid;
  _item jsonb;
begin
  select id into _list_id from public.option_lists where code = _code;
  if _list_id is null then return; end if;
  for _item in select * from jsonb_array_elements(_items) loop
    insert into public.option_list_items (list_id, value, label_ar, label_en, sort_order, is_system)
    values (
      _list_id,
      _item->>'value',
      _item->>'label_ar',
      _item->>'label_en',
      coalesce((_item->>'sort_order')::int, 0),
      true
    )
    on conflict (list_id, value) do nothing;
  end loop;
end;
$$;

select public._seed_option_items('tenant_categories', $j$[
  {"value":"vip","label_ar":"كبار العملاء","label_en":"VIP","sort_order":10},
  {"value":"standard","label_ar":"عادي","label_en":"Standard","sort_order":20},
  {"value":"uncommitted","label_ar":"غير ملتزم","label_en":"Uncommitted","sort_order":30},
  {"value":"chronically_distressed","label_ar":"متعثر مزمن","label_en":"Chronically distressed","sort_order":40},
  {"value":"custom","label_ar":"مخصص","label_en":"Custom","sort_order":50}
]$j$::jsonb);

select public._seed_option_items('tenant_lifecycles', $j$[
  {"value":"active","label_ar":"نشط","label_en":"Active","sort_order":10},
  {"value":"inactive","label_ar":"غير نشط","label_en":"Inactive","sort_order":20},
  {"value":"contract_ended","label_ar":"منتهي العقد","label_en":"Contract ended","sort_order":30},
  {"value":"blocked","label_ar":"محظور","label_en":"Blocked","sort_order":40}
]$j$::jsonb);

select public._seed_option_items('contract_types', $j$[
  {"value":"lease","label_ar":"إيجار","label_en":"Lease","sort_order":10},
  {"value":"investment","label_ar":"استثمار","label_en":"Investment","sort_order":20}
]$j$::jsonb);

select public._seed_option_items('contract_states', $j$[
  {"value":"draft","label_ar":"مسودة","label_en":"Draft","sort_order":10},
  {"value":"active","label_ar":"نشط","label_en":"Active","sort_order":20},
  {"value":"frozen","label_ar":"مجمّد","label_en":"Frozen","sort_order":30},
  {"value":"suspended","label_ar":"موقوف","label_en":"Suspended","sort_order":40},
  {"value":"expired","label_ar":"منتهي","label_en":"Expired","sort_order":50},
  {"value":"renewed","label_ar":"مجدَّد","label_en":"Renewed","sort_order":60},
  {"value":"terminated","label_ar":"مفسوخ","label_en":"Terminated","sort_order":70}
]$j$::jsonb);

select public._seed_option_items('property_types', $j$[
  {"value":"compound","label_ar":"مجمّع","label_en":"Compound","sort_order":10},
  {"value":"building_complex","label_ar":"مجمع مبانٍ","label_en":"Building complex","sort_order":20},
  {"value":"tower","label_ar":"برج","label_en":"Tower","sort_order":30},
  {"value":"villa_compound","label_ar":"مجمع فلل","label_en":"Villa compound","sort_order":40},
  {"value":"other","label_ar":"أخرى","label_en":"Other","sort_order":90}
]$j$::jsonb);

select public._seed_option_items('unit_types', $j$[
  {"value":"apartment","label_ar":"شقة","label_en":"Apartment","sort_order":10},
  {"value":"shop","label_ar":"محل","label_en":"Shop","sort_order":20},
  {"value":"office","label_ar":"مكتب","label_en":"Office","sort_order":30},
  {"value":"commercial","label_ar":"تجاري","label_en":"Commercial","sort_order":40},
  {"value":"warehouse","label_ar":"مستودع","label_en":"Warehouse","sort_order":50},
  {"value":"villa","label_ar":"فيلا","label_en":"Villa","sort_order":60},
  {"value":"other","label_ar":"أخرى","label_en":"Other","sort_order":90}
]$j$::jsonb);

select public._seed_option_items('unit_statuses', $j$[
  {"value":"available","label_ar":"متاحة","label_en":"Available","sort_order":10},
  {"value":"reserved","label_ar":"محجوزة","label_en":"Reserved","sort_order":20},
  {"value":"occupied","label_ar":"مؤجرة","label_en":"Occupied","sort_order":30},
  {"value":"vacant","label_ar":"شاغرة","label_en":"Vacant","sort_order":40},
  {"value":"under_maintenance","label_ar":"تحت الصيانة","label_en":"Under maintenance","sort_order":50},
  {"value":"archived","label_ar":"مؤرشفة","label_en":"Archived","sort_order":60}
]$j$::jsonb);

select public._seed_option_items('payment_methods', $j$[
  {"value":"cash","label_ar":"نقدًا","label_en":"Cash","sort_order":10},
  {"value":"bank_transfer","label_ar":"تحويل بنكي","label_en":"Bank transfer","sort_order":20},
  {"value":"cheque","label_ar":"شيك","label_en":"Cheque","sort_order":30},
  {"value":"knet","label_ar":"كي نت","label_en":"KNET","sort_order":40},
  {"value":"credit_card","label_ar":"بطاقة ائتمان","label_en":"Credit card","sort_order":50},
  {"value":"myfatoorah","label_ar":"ماي فاتورة","label_en":"MyFatoorah","sort_order":60}
]$j$::jsonb);

select public._seed_option_items('expense_categories', $j$[
  {"value":"maintenance","label_ar":"صيانة","label_en":"Maintenance","sort_order":10},
  {"value":"utilities","label_ar":"مرافق","label_en":"Utilities","sort_order":20},
  {"value":"cleaning","label_ar":"نظافة","label_en":"Cleaning","sort_order":30},
  {"value":"security","label_ar":"أمن","label_en":"Security","sort_order":40},
  {"value":"government_fees","label_ar":"رسوم حكومية","label_en":"Government fees","sort_order":50},
  {"value":"other","label_ar":"أخرى","label_en":"Other","sort_order":90}
]$j$::jsonb);
