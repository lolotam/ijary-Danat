-- 230_admin_feature_permissions.sql
--
-- Moves seven admin-only features onto grantable permission codes, and wires
-- the four landing_page.* codes that 19_landing_page.sql seeded but nothing
-- ever checked.
--
--   settings.integrations  Gmail / Evolution connections + WhatsApp history & avatar sync, notification providers
--   settings.lists         option lists (dropdown values)
--   settings.backup        create / list / download / delete backups, auto-backup switches
--   workflows.manage       pause, edit, add and remove workflows (cron_jobs)
--   electricity.tariffs    electricity tariff table
--   expenses.categories    expense categories
--   inbox.manage           delete Gmail messages
--   landing_page.read / .update                  landing page editor
--   landing_page.leasing_read / .leasing_update  leasing leads in the inbox
--
-- Special codes on a module prefix, not PERMISSION_MODULES entries — same
-- reasoning as 83_closeout_permissions.sql: a module would invent meaningless
-- .create/.delete/.export rows. src/lib/permissions.ts MUST list the same
-- codes; usePermissions() silently drops a grant whose code is SQL-only, which
-- is exactly why landing_page.* never worked. src/db/permissionCatalog.sqltest.ts
-- now pins the two lists together.
--
-- Deliberately NOT covered:
--   * backup RESTORE stays has_role(admin). A restore rewrites user_roles and
--     role_permissions, so the permission to restore is the permission to make
--     yourself admin.
--   * Users, roles and erase-all-data stay admin-only for the same reason.
--
-- Behaviour change: the landing tables and leasing_inquiries were writable by
-- every staff role (is_staff). They now need landing_page.update /
-- landing_page.leasing_*. Production had no non-admin staff when this shipped,
-- so nobody lost access; a future accountant or collector needs the box ticked.
--
-- Admin keeps everything through has_permission's admin short-circuit; the
-- role_permissions rows below are for the roles matrix to read correctly.

------------------------------------------------------------
-- Permission catalog
------------------------------------------------------------

insert into public.permissions (code, module, action, is_system)
values
  ('settings.integrations', 'settings',    'integrations', true),
  ('settings.lists',        'settings',    'lists',        true),
  ('settings.backup',       'settings',    'backup',       true),
  ('workflows.manage',      'workflows',   'manage',       true),
  ('electricity.tariffs',   'electricity', 'tariffs',      true),
  ('expenses.categories',   'expenses',    'categories',   true),
  ('inbox.manage',          'inbox',       'manage',       true)
on conflict (code) do nothing;

insert into public.role_permissions (role, permission_code)
select 'admin'::public.app_role, p.code
from public.permissions p
where p.code in (
  'settings.integrations',
  'settings.lists',
  'settings.backup',
  'workflows.manage',
  'electricity.tariffs',
  'expenses.categories',
  'inbox.manage'
)
on conflict (role, permission_code) do nothing;

------------------------------------------------------------
-- settings.integrations
------------------------------------------------------------

-- Column grants from 53 / 179 still hide refresh_token, webhook secrets and the
-- QR payload; only the row filter changes here.
drop policy if exists "Allow admins to view gmail connections" on public.gmail_connections;
create policy "Allow admins to view gmail connections" on public.gmail_connections
  for select to authenticated
  using (public.has_permission(auth.uid(), 'settings.integrations'));

drop policy if exists "Allow admins to disconnect gmail" on public.gmail_connections;
create policy "Allow admins to disconnect gmail" on public.gmail_connections
  for delete to authenticated
  using (public.has_permission(auth.uid(), 'settings.integrations'));

drop policy if exists "Allow admins to view evolution connection" on public.evolution_connections;
create policy "Allow admins to view evolution connection" on public.evolution_connections
  for select to authenticated
  using (public.has_permission(auth.uid(), 'settings.integrations'));

-- provider_configs holds env-var NAMES, never values (CHECK in 07).
drop policy if exists provider_configs_admin_all on public.provider_configs;
create policy provider_configs_admin_all on public.provider_configs
  for all to authenticated
  using (public.has_permission(auth.uid(), 'settings.integrations'))
  with check (public.has_permission(auth.uid(), 'settings.integrations'));

------------------------------------------------------------
-- settings.lists
------------------------------------------------------------

drop policy if exists option_lists_write on public.option_lists;
create policy option_lists_write on public.option_lists
  for all to authenticated
  using (public.has_permission(auth.uid(), 'settings.lists'))
  with check (public.has_permission(auth.uid(), 'settings.lists'));

drop policy if exists option_list_items_write on public.option_list_items;
create policy option_list_items_write on public.option_list_items
  for all to authenticated
  using (public.has_permission(auth.uid(), 'settings.lists'))
  with check (public.has_permission(auth.uid(), 'settings.lists'));

------------------------------------------------------------
-- expenses.categories
------------------------------------------------------------

drop policy if exists expense_categories_admin_write on public.expense_categories;
create policy expense_categories_admin_write on public.expense_categories
  for all to authenticated
  using (public.has_permission(auth.uid(), 'expenses.categories'))
  with check (public.has_permission(auth.uid(), 'expenses.categories'));

------------------------------------------------------------
-- electricity.tariffs
------------------------------------------------------------

drop policy if exists electricity_tariffs_admin_write on public.electricity_tariffs;
create policy electricity_tariffs_admin_write on public.electricity_tariffs
  for all to authenticated
  using (public.has_permission(auth.uid(), 'electricity.tariffs'))
  with check (public.has_permission(auth.uid(), 'electricity.tariffs'));

------------------------------------------------------------
-- workflows.manage
------------------------------------------------------------

drop policy if exists cron_jobs_admin_update on public.cron_jobs;
create policy cron_jobs_admin_update on public.cron_jobs
  for update to authenticated
  using (public.has_permission(auth.uid(), 'workflows.manage'))
  with check (public.has_permission(auth.uid(), 'workflows.manage'));

------------------------------------------------------------
-- settings.backup
------------------------------------------------------------

drop policy if exists backups_select_admin on public.backups;
create policy backups_select_admin on public.backups
  for select to authenticated
  using (public.has_permission(auth.uid(), 'settings.backup'));

/**
 * يحمي إعدادات النسخ الاحتياطي من التعديل بواسطة من لا يملك صلاحية النسخ الاحتياطي.
 *
 * Same body as 146 with the role check swapped for settings.backup. A null
 * `auth.uid()` is still let through: that is the service-key path, and the
 * server functions behind it gate on the permission themselves.
 */
create or replace function public.companies_backup_settings_protect()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if (new.backup_daily_enabled is distinct from old.backup_daily_enabled) or
     (new.backup_weekly_enabled is distinct from old.backup_weekly_enabled) then
    if auth.uid() is not null
       and not public.has_permission(auth.uid(), 'settings.backup') then
      raise exception 'Forbidden: missing permission settings.backup';
    end if;
  end if;
  return new;
end;
$fn$;

revoke execute on function public.companies_backup_settings_protect() from public, anon, authenticated;

------------------------------------------------------------
-- inbox.manage
------------------------------------------------------------

drop policy if exists "Allow admins to delete gmail messages" on public.gmail_messages;
create policy "Allow admins to delete gmail messages" on public.gmail_messages
  for delete to authenticated
  using (public.has_permission(auth.uid(), 'inbox.manage'));

------------------------------------------------------------
-- landing_page.read / landing_page.update
------------------------------------------------------------

-- Public reads keep their published/active branch untouched; only the
-- signed-in preview-of-drafts branch moves from is_staff to landing_page.read.
drop policy if exists "Allow public read of landing_media" on public.landing_media;
create policy "Allow public read of landing_media" on public.landing_media
  for select to public
  using (is_active = true
         or (auth.uid() is not null and public.has_permission(auth.uid(), 'landing_page.read')));

drop policy if exists "Allow staff write of landing_media" on public.landing_media;
create policy "Allow staff write of landing_media" on public.landing_media
  for all to authenticated
  using (public.has_permission(auth.uid(), 'landing_page.update'))
  with check (public.has_permission(auth.uid(), 'landing_page.update'));

drop policy if exists "Allow public read of landing_page_settings" on public.landing_page_settings;
create policy "Allow public read of landing_page_settings" on public.landing_page_settings
  for select to public
  using (is_published = true
         or (auth.uid() is not null and public.has_permission(auth.uid(), 'landing_page.read')));

drop policy if exists "Allow staff write of landing_page_settings" on public.landing_page_settings;
create policy "Allow staff write of landing_page_settings" on public.landing_page_settings
  for all to authenticated
  using (public.has_permission(auth.uid(), 'landing_page.update'))
  with check (public.has_permission(auth.uid(), 'landing_page.update'));

drop policy if exists "Allow staff write of landing_page_sections" on public.landing_page_sections;
create policy "Allow staff write of landing_page_sections" on public.landing_page_sections
  for all to authenticated
  using (public.has_permission(auth.uid(), 'landing_page.update'))
  with check (public.has_permission(auth.uid(), 'landing_page.update'));

drop policy if exists "Allow public read of commercial_brands" on public.commercial_brands;
create policy "Allow public read of commercial_brands" on public.commercial_brands
  for select to public
  using (is_active = true
         or (auth.uid() is not null and public.has_permission(auth.uid(), 'landing_page.read')));

drop policy if exists "Allow staff write of commercial_brands" on public.commercial_brands;
create policy "Allow staff write of commercial_brands" on public.commercial_brands
  for all to authenticated
  using (public.has_permission(auth.uid(), 'landing_page.update'))
  with check (public.has_permission(auth.uid(), 'landing_page.update'));

drop policy if exists "Allow public read of landing_carousel_slides" on public.landing_carousel_slides;
create policy "Allow public read of landing_carousel_slides" on public.landing_carousel_slides
  for select to public
  using (is_active = true
         or (auth.uid() is not null and public.has_permission(auth.uid(), 'landing_page.read')));

drop policy if exists "Allow staff write of landing_carousel_slides" on public.landing_carousel_slides;
create policy "Allow staff write of landing_carousel_slides" on public.landing_carousel_slides
  for all to authenticated
  using (public.has_permission(auth.uid(), 'landing_page.update'))
  with check (public.has_permission(auth.uid(), 'landing_page.update'));

-- Storage policies were wiped once by a server move (74 restored them); keep
-- this one in step with 74 if that file is ever re-run.
drop policy if exists landing_admin_write on storage.objects;
create policy landing_admin_write on storage.objects
  for all to authenticated
  using (bucket_id = 'landing' and public.has_permission(auth.uid(), 'landing_page.update'))
  with check (bucket_id = 'landing' and public.has_permission(auth.uid(), 'landing_page.update'));

------------------------------------------------------------
-- landing_page.leasing_read / landing_page.leasing_update
------------------------------------------------------------

-- Public INSERT (the website form) is untouched.
drop policy if exists "Allow staff read of leasing_inquiries" on public.leasing_inquiries;
create policy "Allow staff read of leasing_inquiries" on public.leasing_inquiries
  for select to authenticated
  using (public.has_permission(auth.uid(), 'landing_page.leasing_read'));

drop policy if exists "Allow staff write of leasing_inquiries" on public.leasing_inquiries;
create policy "Allow staff write of leasing_inquiries" on public.leasing_inquiries
  for update to authenticated
  using (public.has_permission(auth.uid(), 'landing_page.leasing_update'))
  with check (public.has_permission(auth.uid(), 'landing_page.leasing_update'));

drop policy if exists "Allow admins to delete leasing_inquiries" on public.leasing_inquiries;
create policy "Allow admins to delete leasing_inquiries" on public.leasing_inquiries
  for delete to authenticated
  using (public.has_permission(auth.uid(), 'landing_page.leasing_update'));

-- Shop ↔ contract links (162) are edited from the same landing-page shops
-- dialog, so they follow the same two codes.
drop policy if exists "Allow public read of commercial_brand_contracts"
  on public.commercial_brand_contracts;
create policy "Allow public read of commercial_brand_contracts"
  on public.commercial_brand_contracts
  for select to public using (
    exists (
      select 1 from public.commercial_brands b
       where b.id = commercial_brand_contracts.brand_id
         and (b.is_active = true
              or (auth.uid() is not null
                  and public.has_permission(auth.uid(), 'landing_page.read')))
    )
  );

drop policy if exists "Allow staff write of commercial_brand_contracts"
  on public.commercial_brand_contracts;
create policy "Allow staff write of commercial_brand_contracts"
  on public.commercial_brand_contracts
  for all to authenticated
  using (public.has_permission(auth.uid(), 'landing_page.update'))
  with check (public.has_permission(auth.uid(), 'landing_page.update'));

/**
 * يستبدل مجموعة العقود المرتبطة بمحل تجاري دفعة واحدة.
 *
 * Same body as 162 with the is_staff guard swapped for landing_page.update.
 * SECURITY DEFINER bypasses the write policy above, so this guard is the only
 * one on this path.
 */
create or replace function public.save_brand_contracts(
  p_brand_id uuid,
  p_contract_ids uuid[]
)
returns setof public.commercial_brand_contracts
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'landing_page.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if not exists (select 1 from public.commercial_brands b where b.id = p_brand_id) then
    raise exception 'Brand not found';
  end if;

  delete from public.commercial_brand_contracts cbc
   where cbc.brand_id = p_brand_id
     and not (cbc.contract_id = any(coalesce(p_contract_ids, '{}'::uuid[])));

  insert into public.commercial_brand_contracts (brand_id, contract_id)
  select p_brand_id, unnest(coalesce(p_contract_ids, '{}'::uuid[]))
  on conflict do nothing;

  return query
    select cbc.* from public.commercial_brand_contracts cbc
     where cbc.brand_id = p_brand_id
     order by cbc.contract_id;
end;
$$;

revoke execute on function public.save_brand_contracts(uuid, uuid[]) from public, anon;
grant execute on function public.save_brand_contracts(uuid, uuid[]) to authenticated, service_role;
