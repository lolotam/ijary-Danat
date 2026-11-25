do $$
begin
  create type public.expense_classes as enum ('contractual_monthly', 'contractual_annual', 'regular_recurring', 'sudden_one_time');
exception when duplicate_object then null;
end $$;

create sequence if not exists public.expense_code_seq start 1;
create sequence if not exists public.deposit_code_seq start 1;

create or replace function public.next_expense_code()
returns text language sql volatile set search_path = public
as $$ select 'EXP-' || lpad(nextval('public.expense_code_seq')::text, 6, '0') $$;

create or replace function public.next_deposit_code()
returns text language sql volatile set search_path = public
as $$ select 'DEP-' || lpad(nextval('public.deposit_code_seq')::text, 6, '0') $$;

create table if not exists public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name_ar text not null,
  name_en text,
  is_system boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

insert into public.expense_categories (code, name_ar, name_en, is_system, sort_order)
values
  ('security', 'الأمن والحراسة', 'Security', true, 10),
  ('cleaning', 'النظافة', 'Cleaning', true, 20),
  ('maintenance', 'الصيانة', 'Maintenance', true, 30),
  ('fire_services', 'خدمات الحريق', 'Fire services', true, 40),
  ('lifts', 'المصاعد', 'Lifts', true, 50),
  ('utilities', 'الخدمات والمرافق', 'Utilities', true, 60),
  ('admin', 'المصروفات الإدارية', 'Administration', true, 70),
  ('other', 'أخرى', 'Other', true, 80)
on conflict (code) do update set name_ar = excluded.name_ar, name_en = excluded.name_en,
  is_system = true, sort_order = excluded.sort_order;

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  code text unique not null default public.next_expense_code(),
  company_id uuid references public.companies(id) on delete set null,
  class public.expense_classes not null default 'regular_recurring',
  category_id uuid references public.expense_categories(id) on delete set null,
  payee text,
  amount numeric(14,3) not null check (amount >= 0),
  currency text not null default 'KWD',
  property_id uuid references public.properties(id) on delete set null,
  building_id uuid references public.buildings(id) on delete set null,
  unit_id uuid references public.units(id) on delete set null,
  cost_center text,
  start_date date,
  end_date date,
  recurrence text check (recurrence is null or recurrence in ('monthly', 'quarterly', 'annual', 'one_time')),
  expense_date date not null default current_date,
  status text not null default 'approved' check (status in ('pending', 'approved', 'cancelled')),
  attachment_path text,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_date is null or end_date is null or end_date >= start_date)
);

create table if not exists public.deposits (
  id uuid primary key default gen_random_uuid(),
  code text unique not null default public.next_deposit_code(),
  company_id uuid references public.companies(id) on delete set null,
  deposit_date date not null,
  bank_name text not null,
  amount numeric(14,3) not null check (amount > 0),
  currency text not null default 'KWD',
  note text,
  attachment_path text,
  status text not null default 'confirmed' check (status in ('pending', 'confirmed', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists expenses_company_id_idx on public.expenses (company_id);
create index if not exists expenses_category_id_idx on public.expenses (category_id);
create index if not exists expenses_property_id_idx on public.expenses (property_id);
create index if not exists expenses_expense_date_idx on public.expenses (expense_date desc);
create index if not exists expenses_status_idx on public.expenses (status);
create index if not exists deposits_company_id_idx on public.deposits (company_id);
create index if not exists deposits_deposit_date_idx on public.deposits (deposit_date desc);
create index if not exists deposits_status_idx on public.deposits (status);

drop trigger if exists set_updated_at on public.expenses;
create trigger set_updated_at before update on public.expenses for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.deposits;
create trigger set_updated_at before update on public.deposits for each row execute function public.tg_set_updated_at();

grant usage, select on sequence public.expense_code_seq to authenticated, service_role;
grant usage, select on sequence public.deposit_code_seq to authenticated, service_role;
grant select, insert, update, delete on public.expense_categories to authenticated;
grant all on public.expense_categories to service_role;
grant select, insert, update, delete on public.expenses to authenticated;
grant all on public.expenses to service_role;
grant select, insert, update, delete on public.deposits to authenticated;
grant all on public.deposits to service_role;

alter table public.expense_categories enable row level security;
alter table public.expenses enable row level security;
alter table public.deposits enable row level security;

drop policy if exists expense_categories_staff_read on public.expense_categories;
create policy expense_categories_staff_read on public.expense_categories for select to authenticated using (public.is_staff(auth.uid()));
drop policy if exists expense_categories_admin_write on public.expense_categories;
create policy expense_categories_admin_write on public.expense_categories for all to authenticated
using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
drop policy if exists expense_categories_service_role_all on public.expense_categories;
create policy expense_categories_service_role_all on public.expense_categories for all to service_role using (true) with check (true);

drop policy if exists expenses_staff_read on public.expenses;
create policy expenses_staff_read on public.expenses for select to authenticated using (public.is_staff(auth.uid()));
drop policy if exists expenses_insert_permitted on public.expenses;
create policy expenses_insert_permitted on public.expenses for insert to authenticated with check (public.has_permission(auth.uid(), 'expenses.create'));
drop policy if exists expenses_update_permitted on public.expenses;
create policy expenses_update_permitted on public.expenses for update to authenticated
using (public.has_permission(auth.uid(), 'expenses.update')) with check (public.has_permission(auth.uid(), 'expenses.update'));
drop policy if exists expenses_delete_permitted on public.expenses;
create policy expenses_delete_permitted on public.expenses for delete to authenticated using (public.has_permission(auth.uid(), 'expenses.delete'));
drop policy if exists expenses_service_role_all on public.expenses;
create policy expenses_service_role_all on public.expenses for all to service_role using (true) with check (true);

drop policy if exists deposits_staff_read on public.deposits;
create policy deposits_staff_read on public.deposits for select to authenticated using (public.is_staff(auth.uid()));
drop policy if exists deposits_insert_permitted on public.deposits;
create policy deposits_insert_permitted on public.deposits for insert to authenticated with check (public.has_permission(auth.uid(), 'deposits.create'));
drop policy if exists deposits_update_permitted on public.deposits;
create policy deposits_update_permitted on public.deposits for update to authenticated
using (public.has_permission(auth.uid(), 'deposits.update')) with check (public.has_permission(auth.uid(), 'deposits.update'));
drop policy if exists deposits_delete_permitted on public.deposits;
create policy deposits_delete_permitted on public.deposits for delete to authenticated using (public.has_permission(auth.uid(), 'deposits.delete'));
drop policy if exists deposits_service_role_all on public.deposits;
create policy deposits_service_role_all on public.deposits for all to service_role using (true) with check (true);

insert into storage.buckets (id, name, public)
values ('expense-attachments', 'expense-attachments', false), ('deposit-attachments', 'deposit-attachments', false)
on conflict (id) do update set public = false;

drop policy if exists expense_attachments_select_staff on storage.objects;
create policy expense_attachments_select_staff on storage.objects for select to authenticated
using (bucket_id = 'expense-attachments' and public.is_staff(auth.uid()));
drop policy if exists expense_attachments_insert_permitted on storage.objects;
create policy expense_attachments_insert_permitted on storage.objects for insert to authenticated
with check (bucket_id = 'expense-attachments' and public.has_permission(auth.uid(), 'expenses.create'));
drop policy if exists expense_attachments_update_permitted on storage.objects;
create policy expense_attachments_update_permitted on storage.objects for update to authenticated
using (bucket_id = 'expense-attachments' and public.has_permission(auth.uid(), 'expenses.update'))
with check (bucket_id = 'expense-attachments' and public.has_permission(auth.uid(), 'expenses.update'));
drop policy if exists expense_attachments_delete_permitted on storage.objects;
create policy expense_attachments_delete_permitted on storage.objects for delete to authenticated
using (bucket_id = 'expense-attachments' and public.has_permission(auth.uid(), 'expenses.delete'));

drop policy if exists deposit_attachments_select_staff on storage.objects;
create policy deposit_attachments_select_staff on storage.objects for select to authenticated
using (bucket_id = 'deposit-attachments' and public.is_staff(auth.uid()));
drop policy if exists deposit_attachments_insert_permitted on storage.objects;
create policy deposit_attachments_insert_permitted on storage.objects for insert to authenticated
with check (bucket_id = 'deposit-attachments' and public.has_permission(auth.uid(), 'deposits.create'));
drop policy if exists deposit_attachments_update_permitted on storage.objects;
create policy deposit_attachments_update_permitted on storage.objects for update to authenticated
using (bucket_id = 'deposit-attachments' and public.has_permission(auth.uid(), 'deposits.update'))
with check (bucket_id = 'deposit-attachments' and public.has_permission(auth.uid(), 'deposits.update'));
drop policy if exists deposit_attachments_delete_permitted on storage.objects;
create policy deposit_attachments_delete_permitted on storage.objects for delete to authenticated
using (bucket_id = 'deposit-attachments' and public.has_permission(auth.uid(), 'deposits.delete'));

create or replace function public.bulk_import_phase6(p_entity text, p_rows jsonb, p_created_by uuid default null)
returns integer language plpgsql security definer set search_path = public, auth, pg_temp
as $$
declare v_count integer;
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Rows must be a JSON array'; end if;
  if p_entity = 'expenses' then
    insert into public.expenses (code, company_id, class, category_id, payee, amount, currency, property_id,
      building_id, unit_id, cost_center, start_date, end_date, recurrence, expense_date, status, note, created_by)
    select coalesce(nullif(r.code, ''), public.next_expense_code()), r.company_id,
      coalesce(r.class, 'regular_recurring')::public.expense_classes, r.category_id, nullif(r.payee, ''),
      r.amount, coalesce(nullif(r.currency, ''), 'KWD'), r.property_id, r.building_id, r.unit_id,
      nullif(r.cost_center, ''), r.start_date, r.end_date, nullif(r.recurrence, ''), r.expense_date,
      coalesce(nullif(r.status, ''), 'approved'), nullif(r.note, ''), p_created_by
    from jsonb_to_recordset(p_rows) as r(code text, company_id uuid, class text, category_id uuid,
      payee text, amount numeric, currency text, property_id uuid, building_id uuid, unit_id uuid,
      cost_center text, start_date date, end_date date, recurrence text, expense_date date, status text, note text);
  elsif p_entity = 'deposits' then
    insert into public.deposits (code, company_id, deposit_date, bank_name, amount, currency, note, status, created_by)
    select coalesce(nullif(r.code, ''), public.next_deposit_code()), r.company_id, r.deposit_date, r.bank_name,
      r.amount, coalesce(nullif(r.currency, ''), 'KWD'), nullif(r.note, ''),
      coalesce(nullif(r.status, ''), 'confirmed'), p_created_by
    from jsonb_to_recordset(p_rows) as r(code text, company_id uuid, deposit_date date, bank_name text,
      amount numeric, currency text, note text, status text);
  elsif p_entity = 'tenants' then
    insert into public.tenants (code, company_id, name, category, lifecycle, nationality, preferred_language,
      mobile, whatsapp, email, commercial_name, authorized_manager, owner_name, notes,
      tenant_portal_enabled, reminders_enabled, receipt_visible_to_tenant)
    select coalesce(nullif(r.code, ''), public.next_tenant_code()), r.company_id, r.name,
      coalesce(nullif(r.category, ''), 'standard')::public.tenant_categories,
      coalesce(nullif(r.lifecycle, ''), 'active')::public.tenant_lifecycle, nullif(r.nationality, ''),
      coalesce(nullif(r.preferred_language, ''), 'ar')::public.locale_code, nullif(r.mobile, ''),
      nullif(r.whatsapp, ''), nullif(r.email, '')::citext, nullif(r.commercial_name, ''),
      nullif(r.authorized_manager, ''), nullif(r.owner_name, ''), nullif(r.notes, ''),
      coalesce(r.tenant_portal_enabled, false), coalesce(r.reminders_enabled, true),
      coalesce(r.receipt_visible_to_tenant, true)
    from jsonb_to_recordset(p_rows) as r(code text, company_id uuid, name text, category text,
      lifecycle text, nationality text, preferred_language text, mobile text, whatsapp text, email text,
      commercial_name text, authorized_manager text, owner_name text, notes text,
      tenant_portal_enabled boolean, reminders_enabled boolean, receipt_visible_to_tenant boolean);
  elsif p_entity = 'units' then
    insert into public.units (code, property_id, building_id, name, type, area, status,
      electricity_meter_ownership, default_rent, description_ar, description_en)
    select coalesce(nullif(r.code, ''), public.next_unit_code()), r.property_id, r.building_id, r.name,
      coalesce(nullif(r.type, ''), 'apartment')::public.unit_types, r.area,
      coalesce(nullif(r.status, ''), 'available')::public.unit_status,
      coalesce(nullif(r.electricity_meter_ownership, ''), 'company_owned')::public.electricity_meter_ownership,
      r.default_rent, nullif(r.description_ar, ''), nullif(r.description_en, '')
    from jsonb_to_recordset(p_rows) as r(code text, property_id uuid, building_id uuid, name text,
      type text, area numeric, status text, electricity_meter_ownership text, default_rent numeric,
      description_ar text, description_en text);
  else
    raise exception 'Unsupported import entity: %', p_entity;
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.bulk_import_phase6(text, jsonb, uuid) from public, authenticated;
grant execute on function public.bulk_import_phase6(text, jsonb, uuid) to service_role;

create or replace function public.get_budget_summary(
  p_from date, p_to date, p_property_id uuid default null, p_building_id uuid default null
)
returns jsonb language plpgsql stable security definer set search_path = public, auth, pg_temp
as $$
declare
  v_collections numeric(14,3);
  v_deposits numeric(14,3);
  v_expenses numeric(14,3);
  v_categories jsonb;
  v_months jsonb;
begin
  if p_to < p_from then raise exception 'Invalid date range'; end if;
  if auth.role() = 'authenticated' and not public.has_permission(auth.uid(), 'reports.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  select coalesce(sum(p.amount), 0) into v_collections
  from public.payments p left join public.units u on u.id = p.unit_id
  where p.status = 'confirmed' and p.reversed_by_payment_id is null and p.payment_date between p_from and p_to
    and (p_property_id is null or u.property_id = p_property_id)
    and (p_building_id is null or u.building_id = p_building_id);
  select coalesce(sum(d.amount), 0) into v_deposits from public.deposits d
  where d.status = 'confirmed' and d.deposit_date between p_from and p_to;
  select coalesce(sum(e.amount), 0) into v_expenses
  from public.expenses e left join public.units u on u.id = e.unit_id
  where e.status = 'approved' and e.expense_date between p_from and p_to
    and (p_property_id is null or e.property_id = p_property_id or u.property_id = p_property_id)
    and (p_building_id is null or e.building_id = p_building_id or u.building_id = p_building_id);
  select coalesce(jsonb_agg(jsonb_build_object('category_id', x.category_id, 'code', x.code,
    'name_ar', x.name_ar, 'name_en', x.name_en, 'amount', x.amount) order by x.amount desc), '[]'::jsonb)
  into v_categories from (
    select e.category_id, coalesce(c.code, 'uncategorized') code,
      coalesce(c.name_ar, 'غير مصنف') name_ar, coalesce(c.name_en, 'Uncategorized') name_en,
      sum(e.amount)::numeric(14,3) amount
    from public.expenses e left join public.expense_categories c on c.id = e.category_id
    left join public.units u on u.id = e.unit_id
    where e.status = 'approved' and e.expense_date between p_from and p_to
      and (p_property_id is null or e.property_id = p_property_id or u.property_id = p_property_id)
      and (p_building_id is null or e.building_id = p_building_id or u.building_id = p_building_id)
    group by e.category_id, c.code, c.name_ar, c.name_en
  ) x;
  select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month_start, 'YYYY-MM'),
    'collections', coalesce(p.total, 0), 'expenses', coalesce(e.total, 0)) order by m.month_start), '[]'::jsonb)
  into v_months
  from generate_series(date_trunc('month', p_from)::date, date_trunc('month', p_to)::date, interval '1 month') m(month_start)
  left join lateral (
    select sum(pm.amount)::numeric(14,3) total from public.payments pm
    left join public.units u on u.id = pm.unit_id
    where pm.status = 'confirmed' and pm.reversed_by_payment_id is null
      and pm.payment_date >= m.month_start and pm.payment_date < m.month_start + interval '1 month'
      and pm.payment_date between p_from and p_to
      and (p_property_id is null or u.property_id = p_property_id)
      and (p_building_id is null or u.building_id = p_building_id)
  ) p on true
  left join lateral (
    select sum(ex.amount)::numeric(14,3) total from public.expenses ex
    left join public.units u on u.id = ex.unit_id
    where ex.status = 'approved'
      and ex.expense_date >= m.month_start and ex.expense_date < m.month_start + interval '1 month'
      and ex.expense_date between p_from and p_to
      and (p_property_id is null or ex.property_id = p_property_id or u.property_id = p_property_id)
      and (p_building_id is null or ex.building_id = p_building_id or u.building_id = p_building_id)
  ) e on true;
  return jsonb_build_object('collections', v_collections, 'deposits', v_deposits, 'expenses', v_expenses,
    'net', v_collections - v_expenses, 'categories', v_categories, 'months', v_months);
end;
$$;

revoke all on function public.get_budget_summary(date, date, uuid, uuid) from public;
grant execute on function public.get_budget_summary(date, date, uuid, uuid) to authenticated, service_role;

create or replace function public.get_deposit_total(
  p_from date default null,
  p_to date default null,
  p_bank text default null,
  p_status text default null,
  p_search text default null
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare v_total numeric(14,3);
begin
  if auth.role() = 'authenticated' and not public.has_permission(auth.uid(), 'deposits.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  select coalesce(sum(d.amount), 0) into v_total
  from public.deposits d
  where (p_from is null or d.deposit_date >= p_from)
    and (p_to is null or d.deposit_date <= p_to)
    and (p_bank is null or d.bank_name = p_bank)
    and (p_status is null or d.status = p_status)
    and (p_search is null or d.code ilike '%' || p_search || '%'
      or d.bank_name ilike '%' || p_search || '%' or coalesce(d.note, '') ilike '%' || p_search || '%');
  return v_total;
end;
$$;

revoke all on function public.get_deposit_total(date, date, text, text, text) from public;
grant execute on function public.get_deposit_total(date, date, text, text, text) to authenticated, service_role;
