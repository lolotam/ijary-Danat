-- 21_settings_integrations.sql
-- Settings > Lists integration fixes, company branding fields, and
-- automatic tenant-portal deactivation when a contract stops being active.
-- Idempotent.

-- 1. Expense categories: activation flag so the Settings > Lists page can
--    hide a category from the Add-expense dropdown without deleting it.
alter table public.expense_categories
  add column if not exists is_active boolean not null default true;

-- 2. Company branding: favicon URL next to the existing logo_url.
alter table public.companies
  add column if not exists favicon_url text;

-- 3. Reconcile the payment_methods option list with the payment_methods enum.
--    'credit_card' and 'myfatoorah' are not valid enum values (inserts using
--    them would fail); 'payment_link' was missing.
do $$
declare
  _list uuid;
begin
  select id into _list from public.option_lists where code = 'payment_methods';
  if _list is not null then
    delete from public.option_list_items
      where list_id = _list and value in ('credit_card', 'myfatoorah');
    insert into public.option_list_items (list_id, value, label_ar, label_en, sort_order, is_system)
      values (_list, 'payment_link', 'رابط دفع', 'Payment link', 5, true)
      on conflict (list_id, value) do nothing;
  end if;
end $$;

-- 4. Public branding bucket for logo / favicon uploads.
insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do update set public = true;

drop policy if exists branding_public_read on storage.objects;
create policy branding_public_read on storage.objects
  for select to public using (bucket_id = 'branding');

drop policy if exists branding_admin_write on storage.objects;
create policy branding_admin_write on storage.objects
  for all to authenticated
  using (bucket_id = 'branding' and public.has_role(auth.uid(), 'admin'))
  with check (bucket_id = 'branding' and public.has_role(auth.uid(), 'admin'));

-- 5. When a contract leaves the 'active' state (or an active contract is
--    deleted) and the tenant has no other active contract, deactivate that
--    tenant's portal login. Admins may still re-activate manually as an
--    exception; nothing here re-activates automatically.
create or replace function public.deactivate_portal_users_without_active_contract()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _tenant uuid := coalesce(old.tenant_id, new.tenant_id);
begin
  if _tenant is not null and not exists (
    select 1 from public.contracts c
    where c.tenant_id = _tenant and c.state = 'active'
  ) then
    update public.profiles
      set is_active = false
      where tenant_id = _tenant and is_active;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_contract_deactivate_portal on public.contracts;
create trigger trg_contract_deactivate_portal
  after update of state or delete on public.contracts
  for each row
  when (old.state = 'active')
  execute function public.deactivate_portal_users_without_active_contract();
