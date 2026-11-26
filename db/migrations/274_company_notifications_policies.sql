-- 274_company_notifications_policies.sql
-- T030 (part 2): Forced RLS and hoisted company-scoped policies for
-- `notification_templates`, `notifications`, `provider_configs`,
-- `report_schedules`, `generated_reports`, `cron_jobs`, and `backups`.
-- Idempotent.

------------------------------------------------------------
-- 1. notification_templates
------------------------------------------------------------

grant select, insert, update, delete on public.notification_templates to company_service;

alter table public.notification_templates enable row level security;
alter table public.notification_templates force row level security;

drop policy if exists notification_templates_staff_read on public.notification_templates;
drop policy if exists notification_templates_admin_write on public.notification_templates;
drop policy if exists notification_templates_company_service_all on public.notification_templates;

create policy notification_templates_staff_read on public.notification_templates
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy notification_templates_admin_write on public.notification_templates
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  );

create policy notification_templates_company_service_all on public.notification_templates
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 2. notifications
------------------------------------------------------------

grant select, insert, update, delete on public.notifications to company_service;

alter table public.notifications enable row level security;
alter table public.notifications force row level security;

drop policy if exists notifications_staff_read on public.notifications;
drop policy if exists notifications_admin_write on public.notifications;
drop policy if exists notifications_delete_perm on public.notifications;
drop policy if exists notifications_company_service_all on public.notifications;

create policy notifications_staff_read on public.notifications
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy notifications_admin_write on public.notifications
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  );

create policy notifications_delete_perm on public.notifications
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'notifications.delete'))
  );

create policy notifications_company_service_all on public.notifications
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 3. provider_configs
------------------------------------------------------------

grant select, insert, update, delete on public.provider_configs to company_service;

alter table public.provider_configs enable row level security;
alter table public.provider_configs force row level security;

drop policy if exists provider_configs_admin_all on public.provider_configs;
drop policy if exists provider_configs_company_service_all on public.provider_configs;

create policy provider_configs_admin_all on public.provider_configs
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'settings.integrations'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'settings.integrations'))
  );

create policy provider_configs_company_service_all on public.provider_configs
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 4. report_schedules
------------------------------------------------------------

grant select, insert, update, delete on public.report_schedules to company_service;

alter table public.report_schedules enable row level security;
alter table public.report_schedules force row level security;

drop policy if exists report_schedules_staff_read on public.report_schedules;
drop policy if exists report_schedules_admin_write on public.report_schedules;
drop policy if exists report_schedules_company_service_all on public.report_schedules;

create policy report_schedules_staff_read on public.report_schedules
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy report_schedules_admin_write on public.report_schedules
  for all to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_role((select auth.uid()), 'admin'::public.app_role))
  );

create policy report_schedules_company_service_all on public.report_schedules
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 5. generated_reports
------------------------------------------------------------

grant select, insert, update, delete on public.generated_reports to company_service;

alter table public.generated_reports enable row level security;
alter table public.generated_reports force row level security;

drop policy if exists generated_reports_staff_read on public.generated_reports;
drop policy if exists generated_reports_delete_permitted on public.generated_reports;
drop policy if exists generated_reports_company_service_all on public.generated_reports;

create policy generated_reports_staff_read on public.generated_reports
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy generated_reports_delete_permitted on public.generated_reports
  for delete to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'reports.delete'))
  );

create policy generated_reports_company_service_all on public.generated_reports
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 6. cron_jobs
------------------------------------------------------------

grant select, insert, update, delete on public.cron_jobs to company_service;

alter table public.cron_jobs enable row level security;
alter table public.cron_jobs force row level security;

drop policy if exists cron_jobs_staff_read on public.cron_jobs;
drop policy if exists cron_jobs_admin_update on public.cron_jobs;
drop policy if exists cron_jobs_company_service_all on public.cron_jobs;

create policy cron_jobs_staff_read on public.cron_jobs
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.is_staff((select auth.uid())))
  );

create policy cron_jobs_admin_update on public.cron_jobs
  for update to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'workflows.manage'))
  )
  with check (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'workflows.manage'))
  );

create policy cron_jobs_company_service_all on public.cron_jobs
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

------------------------------------------------------------
-- 7. backups
------------------------------------------------------------

grant select, insert, update, delete on public.backups to company_service;

alter table public.backups enable row level security;
alter table public.backups force row level security;

drop policy if exists backups_select_admin on public.backups;
drop policy if exists backups_company_service_all on public.backups;

create policy backups_select_admin on public.backups
  for select to authenticated
  using (
    company_id = (select public.current_company_id())
    and (select public.has_permission((select auth.uid()), 'settings.backup'))
  );

create policy backups_company_service_all on public.backups
  for all to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));
