-- 257_company_lists_columns.sql
-- T022 (columns, constraints, FKs, indexes): Lists group
--   option_lists, option_list_items, building_categories,
--   expense_categories, invoice_years, card_visibility.
-- Idempotent.

do $$
declare
  v_default_company_id uuid;
begin
  select id into v_default_company_id
    from public.companies
   order by created_at asc, id asc
   limit 1;

  ------------------------------------------------------------
  -- 1. option_lists
  ------------------------------------------------------------
  alter table public.option_lists
    add column if not exists company_id uuid references public.companies(id);

  if v_default_company_id is not null then
    update public.option_lists
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.option_lists
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.option_lists drop constraint if exists option_lists_company_id_id_key;
  alter table public.option_lists
    add constraint option_lists_company_id_id_key unique (company_id, id);

  alter table public.option_lists drop constraint if exists option_lists_code_key;
  alter table public.option_lists drop constraint if exists option_lists_company_code_key;
  alter table public.option_lists
    add constraint option_lists_company_code_key unique (company_id, code);

  create index if not exists option_lists_company_code_idx
    on public.option_lists (company_id, code);

  ------------------------------------------------------------
  -- 2. option_list_items
  ------------------------------------------------------------
  alter table public.option_list_items
    add column if not exists company_id uuid references public.companies(id);

  update public.option_list_items oli
     set company_id = ol.company_id
    from public.option_lists ol
   where ol.id = oli.list_id
     and oli.company_id is null;

  if v_default_company_id is not null then
    update public.option_list_items
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.option_list_items
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.option_list_items drop constraint if exists option_list_items_company_id_id_key;
  alter table public.option_list_items
    add constraint option_list_items_company_id_id_key unique (company_id, id);

  alter table public.option_list_items drop constraint if exists option_list_items_list_id_value_key;
  alter table public.option_list_items drop constraint if exists option_list_items_company_list_value_key;
  alter table public.option_list_items
    add constraint option_list_items_company_list_value_key unique (company_id, list_id, value);

  alter table public.option_list_items drop constraint if exists option_list_items_list_id_fkey;
  alter table public.option_list_items drop constraint if exists option_list_items_company_list_fkey;
  alter table public.option_list_items
    add constraint option_list_items_company_list_fkey
    foreign key (company_id, list_id)
    references public.option_lists(company_id, id) on delete cascade;

  create index if not exists option_list_items_company_list_idx
    on public.option_list_items (company_id, list_id, sort_order);

  ------------------------------------------------------------
  -- 3. building_categories
  ------------------------------------------------------------
  alter table public.building_categories
    add column if not exists company_id uuid references public.companies(id);

  if v_default_company_id is not null then
    update public.building_categories
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.building_categories
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.building_categories drop constraint if exists building_categories_company_id_id_key;
  alter table public.building_categories
    add constraint building_categories_company_id_id_key unique (company_id, id);

  alter table public.building_categories drop constraint if exists building_categories_code_key;
  alter table public.building_categories drop constraint if exists building_categories_company_code_key;
  alter table public.building_categories
    add constraint building_categories_company_code_key unique (company_id, code);

  create index if not exists building_categories_company_sort_idx
    on public.building_categories (company_id, sort_order);

  ------------------------------------------------------------
  -- 4. expense_categories
  ------------------------------------------------------------
  alter table public.expense_categories
    add column if not exists company_id uuid references public.companies(id);

  if v_default_company_id is not null then
    update public.expense_categories
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.expense_categories
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.expense_categories drop constraint if exists expense_categories_company_id_id_key;
  alter table public.expense_categories
    add constraint expense_categories_company_id_id_key unique (company_id, id);

  alter table public.expense_categories drop constraint if exists expense_categories_code_key;
  alter table public.expense_categories drop constraint if exists expense_categories_company_code_key;
  alter table public.expense_categories
    add constraint expense_categories_company_code_key unique (company_id, code);

  create index if not exists expense_categories_company_sort_idx
    on public.expense_categories (company_id, is_active, sort_order);

  ------------------------------------------------------------
  -- 5. invoice_years
  ------------------------------------------------------------
  alter table public.invoice_years
    add column if not exists company_id uuid references public.companies(id);

  if v_default_company_id is not null then
    update public.invoice_years
       set company_id = v_default_company_id
     where company_id is null;
  end if;

  alter table public.invoice_years
    alter column company_id set default public.current_company_id(),
    alter column company_id set not null;

  alter table public.invoice_years drop constraint if exists invoice_years_pkey;
  alter table public.invoice_years
    add constraint invoice_years_pkey primary key (company_id, year);

  ------------------------------------------------------------
  -- 6. card_visibility
  ------------------------------------------------------------
  alter table public.card_visibility drop constraint if exists card_visibility_company_id_fkey;
  alter table public.card_visibility
    add constraint card_visibility_company_id_fkey
    foreign key (company_id) references public.companies(id);

  alter table public.card_visibility
    alter column company_id set default public.current_company_id();
end $$;

/**
 * يستنتج `company_id` لعناصر القائمة من جدول `option_lists` عند غياب القيمة صراحة.
 */
create or replace function public.tg_option_list_items_fill_company_id()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.company_id is null then
    select ol.company_id into new.company_id
      from public.option_lists ol
     where ol.id = new.list_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_option_list_items_fill_company_id on public.option_list_items;
create trigger trg_option_list_items_fill_company_id
  before insert on public.option_list_items
  for each row execute function public.tg_option_list_items_fill_company_id();
