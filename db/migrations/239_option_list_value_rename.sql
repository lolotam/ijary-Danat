-- 239_option_list_value_rename.sql
--
-- On 2026-09-26 an admin edited the unit_types item value Roof_Apartment →
-- managemental-services. units.type stores the value as free text (103) with
-- no FK, so 6 units kept the old string. This migration adds an atomic rename
-- that cascades to every column that stores a list value, and repairs the data.

-- يعيد الأعمدة التي تخزن قيم قائمة منسدلة معينة.
-- One home for the list→column map so the count and the rename cannot disagree.
--
-- Map rows verified against option_lists seeds: unit_types / property_types
-- (13, free text since 103), unit_floors (101), commercial_activities (99),
-- gmail_categories (62 — GmailMessageSheet stores item.value in
-- gmail_messages.category), kuwait_banks (154 — DepositFormDialog stores
-- item.value via mapCatalogueOptions in deposits.bank_name).
-- resend_senders is deliberately NOT mapped (past sends must not be rewritten).
create or replace function public.option_list_value_references(p_list_code text)
returns table(table_name text, column_name text)
language sql immutable
set search_path = public
as $fn$
  select v.table_name, v.column_name
  from (values
    ('unit_types',            'units',      'type'),
    ('property_types',        'properties', 'type'),
    ('unit_floors',           'units',      'floor'),
    ('commercial_activities', 'contracts',  'commercial_activity'),
    ('gmail_categories',      'gmail_messages', 'category'),
    ('kuwait_banks',          'deposits',   'bank_name')
  ) as v(list_code, table_name, column_name)
  where v.list_code = p_list_code;
$fn$;

-- يحدد ما إذا كانت القيمة مربوطة بقواعد النظام فلا يجوز إعادة تسميتها.
-- Literals mirror UNIT_FLOOR_TYPE_BINDING in src/lib/unitFloorTypeBinding.ts; a TS test keeps them in lockstep.
create or replace function public.option_list_value_is_code_bound(p_list_code text, p_value text)
returns boolean
language sql immutable
set search_path = public
as $fn$
  select (p_list_code = 'unit_floors' and p_value in ('first','basement','roof','ground'))
      or (p_list_code = 'unit_types' and p_value in ('commercial_unit_1st_floor','commercial_unit_basment','managemental-services','shop_G_Floor'));
$fn$;

-- يعد السجلات التي تستخدم قيمة عنصر القائمة، لعرضها قبل إعادة التسمية.
create or replace function public.count_option_list_value_usage(p_item_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public
as $fn$
declare
  v_item public.option_list_items%rowtype;
  v_code text;
  v_ref record;
  v_n integer;
  v_counts jsonb := '{}'::jsonb;
begin
  if not public.has_permission(auth.uid(), 'settings.lists') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  select * into v_item from public.option_list_items where id = p_item_id;
  if not found then raise exception 'Option list item not found' using errcode = 'P0002'; end if;
  select code into v_code from public.option_lists where id = v_item.list_id;
  for v_ref in select * from public.option_list_value_references(v_code) loop
    execute format('select count(*) from public.%I where %I = $1', v_ref.table_name, v_ref.column_name)
      into v_n using v_item.value;
    v_counts := v_counts || jsonb_build_object(v_ref.table_name || '.' || v_ref.column_name, v_n);
  end loop;
  return v_counts;
end;
$fn$;

-- يعيد تسمية قيمة عنصر القائمة ويحدّث كل السجلات التي تخزنها في معاملة واحدة.
-- Enum-backed lists are rejected: their values are Postgres enum members.
--
-- Rejected codes = keys of ENUM_BACKED_OPTION_LISTS
-- (src/lib/enumBackedOptionLists.ts: unit_statuses, contract_types,
-- contract_states, payment_methods, tenant_lifecycles) + tenant_categories
-- (backs the tenants.category enum, migration 04:118) + manual_payment_reasons
-- (invoices.manual_payment_reason also stores payment-method values since
-- migration 159, so a string cascade could rewrite the wrong rows — renames
-- are refused instead). ListItemsPanel badges contract_statuses and
-- email_categories too, but neither has an option_lists seed anywhere in
-- db/migrations, so no such list can ever hold items and they are omitted.
create or replace function public.rename_option_list_value(p_item_id uuid, p_new_value text)
returns jsonb
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_item public.option_list_items%rowtype;
  v_code text;
  v_new text := btrim(coalesce(p_new_value, ''));
  v_ref record;
  v_n integer;
  v_counts jsonb := '{}'::jsonb;
begin
  if not public.has_permission(auth.uid(), 'settings.lists') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  if v_new = '' then raise exception 'Value is required' using errcode = '22023'; end if;
  select * into v_item from public.option_list_items where id = p_item_id for update;
  if not found then raise exception 'Option list item not found' using errcode = 'P0002'; end if;
  select code into v_code from public.option_lists where id = v_item.list_id;
  if v_code in ('unit_statuses','contract_types','contract_states','payment_methods',
                'tenant_lifecycles','tenant_categories',
                'manual_payment_reasons') then
    raise exception 'Values of this list cannot be renamed' using errcode = '22023';
  end if;
  if public.option_list_value_is_code_bound(v_code, v_item.value) then
    raise exception 'This value is bound to system rules and cannot be renamed' using errcode = '22023';
  end if;
  if v_item.value = v_new then return jsonb_build_object('updated', v_counts); end if;
  if exists (select 1 from public.option_list_items
             where list_id = v_item.list_id and value = v_new) then
    raise exception 'Value already exists in this list' using errcode = '23505';
  end if;
  for v_ref in select * from public.option_list_value_references(v_code) loop
    execute format('update public.%I set %I = $1 where %I = $2',
                   v_ref.table_name, v_ref.column_name, v_ref.column_name)
      using v_new, v_item.value;
    get diagnostics v_n = row_count;
    v_counts := v_counts || jsonb_build_object(v_ref.table_name || '.' || v_ref.column_name, v_n);
  end loop;
  perform set_config('app.option_value_rename', 'on', true);
  update public.option_list_items set value = v_new, updated_at = now() where id = p_item_id;
  perform public.write_audit(
    'option_list_item.rename_value', 'option_list_item', p_item_id,
    jsonb_build_object('value', v_item.value, 'list', v_code),
    jsonb_build_object('value', v_new, 'list', v_code, 'updated', v_counts));
  return jsonb_build_object('updated', v_counts);
end;
$fn$;

-- يمنع تغيير قيمة عنصر قائمة مباشرة دون المرور بدالة إعادة التسمية.
-- Old browser bundles (and useUpdateOptionListItem) can still PATCH `value`
-- through the RLS write policy; that write would skip the cascade and recreate
-- the 2026-09-26 orphaning. Only rename_option_list_value sets the GUC.
create or replace function public.option_list_items_guard_value()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if new.value is distinct from old.value
     and coalesce(current_setting('app.option_value_rename', true), '') <> 'on' then
    raise exception 'Change a list value through rename_option_list_value'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists option_list_items_guard_value on public.option_list_items;
create trigger option_list_items_guard_value
  before update of value on public.option_list_items
  for each row execute function public.option_list_items_guard_value();

revoke all on function public.option_list_value_references(text) from public, anon;
revoke all on function public.option_list_value_is_code_bound(text, text) from public, anon;
revoke all on function public.count_option_list_value_usage(uuid) from public, anon;
revoke all on function public.rename_option_list_value(uuid, text) from public, anon;
grant execute on function public.option_list_value_references(text) to authenticated, service_role;
grant execute on function public.option_list_value_is_code_bound(text, text) to authenticated, service_role;
grant execute on function public.count_option_list_value_usage(uuid) to authenticated, service_role;
grant execute on function public.rename_option_list_value(uuid, text) to authenticated, service_role;

-- Data repair. Prod already renamed the item; a fresh database (seed 148) still
-- has Roof_Apartment, so rename it there too — both end in the same state.
-- One DO block = one statement = one transaction, so the transaction-local
-- GUC is still set when the guarded update runs. The migration runner and the
-- prod psql apply both run in autocommit (debate R2 #1).
do $repair$
begin
  perform set_config('app.option_value_rename', 'on', true);

  update public.option_list_items i
     set value = 'managemental-services', label_ar = 'خدمات إدارية',
         label_en = 'Managemental Services', updated_at = now()
    from public.option_lists l
   where l.id = i.list_id and l.code = 'unit_types' and i.value = 'Roof_Apartment'
     and not exists (select 1 from public.option_list_items x
                     where x.list_id = i.list_id and x.value = 'managemental-services');

  update public.units set type = 'managemental-services'
   where type = 'Roof_Apartment'
     and exists (select 1 from public.option_list_items i
                 join public.option_lists l on l.id = i.list_id
                 where l.code = 'unit_types' and i.value = 'managemental-services');
end
$repair$;
