-- 273_company_notifications_columns.sql
-- T030 (part 1): Company isolation columns, composite FKs, per-company uniques,
-- and company-led indexes for notifications, templates, providers, reports,
-- cron_jobs, and backups.
-- Idempotent.

------------------------------------------------------------
-- 1. notification_templates
------------------------------------------------------------

alter table public.notifications
  drop constraint if exists notifications_template_code_fkey;

alter table public.notification_templates
  add column if not exists company_id uuid references public.companies(id);

update public.notification_templates
   set company_id = public._legacy_single_company_id()
 where company_id is null;

alter table public.notification_templates
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'notification_templates_company_id_id_key'
       and conrelid = 'public.notification_templates'::regclass
  ) then
    alter table public.notification_templates
      add constraint notification_templates_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.notification_templates
  drop constraint if exists notification_templates_code_key;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'notification_templates_company_id_code_key'
       and conrelid = 'public.notification_templates'::regclass
  ) then
    alter table public.notification_templates
      add constraint notification_templates_company_id_code_key unique (company_id, code);
  end if;
end $$;

------------------------------------------------------------
-- 2. report_schedules
------------------------------------------------------------

alter table public.report_schedules
  add column if not exists company_id uuid references public.companies(id);

update public.report_schedules
   set company_id = public._legacy_single_company_id()
 where company_id is null;

alter table public.report_schedules
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'report_schedules_company_id_id_key'
       and conrelid = 'public.report_schedules'::regclass
  ) then
    alter table public.report_schedules
      add constraint report_schedules_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.report_schedules
  drop constraint if exists report_schedules_code_key;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'report_schedules_company_id_code_key'
       and conrelid = 'public.report_schedules'::regclass
  ) then
    alter table public.report_schedules
      add constraint report_schedules_company_id_code_key unique (company_id, code);
  end if;
end $$;

------------------------------------------------------------
-- 3. generated_reports
------------------------------------------------------------

alter table public.generated_reports
  add column if not exists company_id uuid references public.companies(id);

update public.generated_reports gr
   set company_id = rs.company_id
  from public.report_schedules rs
 where rs.id = gr.schedule_id
   and gr.company_id is null;

update public.generated_reports
   set company_id = public._legacy_single_company_id()
 where company_id is null;

alter table public.generated_reports
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'generated_reports_company_id_id_key'
       and conrelid = 'public.generated_reports'::regclass
  ) then
    alter table public.generated_reports
      add constraint generated_reports_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.generated_reports
  drop constraint if exists generated_reports_schedule_id_fkey,
  drop constraint if exists generated_reports_company_schedule_fkey;

alter table public.generated_reports
  add constraint generated_reports_company_schedule_fkey
  foreign key (company_id, schedule_id)
  references public.report_schedules(company_id, id)
  on delete set null (schedule_id);

drop index if exists public.generated_reports_created_at_idx;
drop index if exists public.generated_reports_schedule_id_idx;
create index if not exists generated_reports_company_created_at_idx
  on public.generated_reports (company_id, created_at desc);
create index if not exists generated_reports_company_schedule_idx
  on public.generated_reports (company_id, schedule_id);

/**
 * يستمد `company_id` للتقرير المُنشأ من جدولة التقرير المرتبطة به عند الإدراج إن غاب.
 */
create or replace function public.tg_generated_reports_inherit_company()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.company_id is null and new.schedule_id is not null then
    select rs.company_id into new.company_id
      from public.report_schedules rs
     where rs.id = new.schedule_id;
  end if;
  return new;
end;
$$;

drop trigger if exists generated_reports_inherit_company on public.generated_reports;
create trigger generated_reports_inherit_company
  before insert on public.generated_reports
  for each row execute function public.tg_generated_reports_inherit_company();

------------------------------------------------------------
-- 4. notifications
------------------------------------------------------------

alter table public.notifications
  add column if not exists company_id uuid references public.companies(id);

update public.notifications n
   set company_id = t.company_id
  from public.tenants t
 where t.id = n.tenant_id
   and n.company_id is null;

update public.notifications n
   set company_id = c.company_id
  from public.contracts c
 where c.id = n.contract_id
   and n.company_id is null;

update public.notifications n
   set company_id = i.company_id
  from public.invoices i
 where i.id = n.invoice_id
   and n.company_id is null;

update public.notifications n
   set company_id = rs.company_id
  from public.report_schedules rs
 where rs.id = n.report_schedule_id
   and n.company_id is null;

update public.notifications
   set company_id = public._legacy_single_company_id()
 where company_id is null;

alter table public.notifications
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'notifications_company_id_id_key'
       and conrelid = 'public.notifications'::regclass
  ) then
    alter table public.notifications
      add constraint notifications_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.notifications
  drop constraint if exists notifications_tenant_id_fkey,
  drop constraint if exists notifications_company_tenant_fkey,
  drop constraint if exists notifications_contract_id_fkey,
  drop constraint if exists notifications_company_contract_fkey,
  drop constraint if exists notifications_invoice_id_fkey,
  drop constraint if exists notifications_company_invoice_fkey,
  drop constraint if exists notifications_report_schedule_id_fkey,
  drop constraint if exists notifications_company_report_schedule_fkey,
  drop constraint if exists notifications_company_template_code_fkey;

alter table public.notifications
  add constraint notifications_company_tenant_fkey
    foreign key (company_id, tenant_id)
    references public.tenants(company_id, id)
    on delete set null (tenant_id),
  add constraint notifications_company_contract_fkey
    foreign key (company_id, contract_id)
    references public.contracts(company_id, id)
    on delete set null (contract_id),
  add constraint notifications_company_invoice_fkey
    foreign key (company_id, invoice_id)
    references public.invoices(company_id, id)
    on delete set null (invoice_id),
  add constraint notifications_company_report_schedule_fkey
    foreign key (company_id, report_schedule_id)
    references public.report_schedules(company_id, id)
    on delete set null (report_schedule_id),
  add constraint notifications_company_template_code_fkey
    foreign key (company_id, template_code)
    references public.notification_templates(company_id, code)
    on update cascade;

drop index if exists public.notifications_contract_expiry_delivery_idx;
create unique index if not exists notifications_contract_expiry_delivery_idx
  on public.notifications (company_id, delivery_key)
  where type = 'contract_expiry'::public.notification_types
    and state = any (array['queued'::public.notification_states, 'sent'::public.notification_states])
    and delivery_key is not null;

drop index if exists public.notifications_payment_delivery_idx;
create unique index if not exists notifications_payment_delivery_idx
  on public.notifications (company_id, delivery_key)
  where type = any (array['payment_admin_alert'::public.notification_types, 'receipt'::public.notification_types])
    and state = any (array[
      'queued'::public.notification_states,
      'sent'::public.notification_states,
      'failed'::public.notification_states,
      'needs_review'::public.notification_states,
      'skipped'::public.notification_states
    ])
    and delivery_key is not null;

drop index if exists public.notifications_audience_idx;
drop index if exists public.notifications_created_at_idx;
drop index if exists public.notifications_recipient_address_idx;
drop index if exists public.notifications_scheduled_at_idx;
drop index if exists public.notifications_state_idx;
drop index if exists public.notifications_tenant_id_idx;
drop index if exists public.notifications_type_idx;

create index if not exists notifications_company_created_at_idx
  on public.notifications (company_id, created_at desc);
create index if not exists notifications_company_state_idx
  on public.notifications (company_id, state);
create index if not exists notifications_company_scheduled_at_idx
  on public.notifications (company_id, scheduled_at);
create index if not exists notifications_company_tenant_idx
  on public.notifications (company_id, tenant_id);
create index if not exists notifications_company_type_idx
  on public.notifications (company_id, type);
create index if not exists notifications_company_audience_idx
  on public.notifications (company_id, audience);
create index if not exists notifications_company_recipient_address_idx
  on public.notifications (company_id, recipient_address);

------------------------------------------------------------
-- 5. provider_configs
------------------------------------------------------------

alter table public.provider_configs
  add column if not exists company_id uuid references public.companies(id);

update public.provider_configs
   set company_id = public._legacy_single_company_id()
 where company_id is null;

alter table public.provider_configs
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'provider_configs_company_id_id_key'
       and conrelid = 'public.provider_configs'::regclass
  ) then
    alter table public.provider_configs
      add constraint provider_configs_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.provider_configs
  drop constraint if exists provider_configs_provider_key;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'provider_configs_company_provider_key'
       and conrelid = 'public.provider_configs'::regclass
  ) then
    alter table public.provider_configs
      add constraint provider_configs_company_provider_key unique (company_id, provider);
  end if;
end $$;

drop index if exists public.provider_configs_one_primary_email;
create unique index if not exists provider_configs_one_primary_email
  on public.provider_configs (company_id)
  where is_primary;

/**
 * يضمن حصرية مزوّد واتساب واحد مفعّل داخل الشركة نفسها دون التأثير على الشركات الأخرى.
 */
create or replace function public.tg_provider_mutual_exclusivity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_enabled is true
     and new.provider::text in ('whatsapp_cloud_api', 'twilio', 'postora', 'evolution_api') then
    update public.provider_configs
       set is_enabled = false, updated_at = now()
     where company_id = new.company_id
       and provider::text in ('whatsapp_cloud_api', 'twilio', 'postora', 'evolution_api')
       and provider is distinct from new.provider
       and is_enabled is true;
  end if;
  return new;
end;
$$;

/**
 * يضمن وجود مزوّد بريد افتراضي واحد فقط داخل الشركة نفسها عند الترقية إلى primary.
 */
create or replace function public.tg_provider_primary_email()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_primary is true then
    update public.provider_configs
       set is_primary = false, updated_at = now()
     where company_id = new.company_id
       and provider::text in ('smtp', 'resend')
       and provider is distinct from new.provider
       and is_primary is true;
  end if;
  return new;
end;
$$;

------------------------------------------------------------
-- 6. cron_jobs
------------------------------------------------------------

alter table public.cron_jobs
  add column if not exists company_id uuid references public.companies(id);

update public.cron_jobs
   set company_id = public._legacy_single_company_id()
 where company_id is null;

alter table public.cron_jobs
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'cron_jobs_company_id_id_key'
       and conrelid = 'public.cron_jobs'::regclass
  ) then
    alter table public.cron_jobs
      add constraint cron_jobs_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.cron_jobs
  drop constraint if exists cron_jobs_key_key;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'cron_jobs_company_id_key_key'
       and conrelid = 'public.cron_jobs'::regclass
  ) then
    alter table public.cron_jobs
      add constraint cron_jobs_company_id_key_key unique (company_id, key);
  end if;
end $$;

------------------------------------------------------------
-- 7. backups
------------------------------------------------------------

alter table public.backups
  add column if not exists company_id uuid references public.companies(id);

update public.backups
   set company_id = public._legacy_single_company_id()
 where company_id is null;

alter table public.backups
  alter column company_id set not null,
  alter column company_id set default public.current_company_id();

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'backups_company_id_id_key'
       and conrelid = 'public.backups'::regclass
  ) then
    alter table public.backups
      add constraint backups_company_id_id_key unique (company_id, id);
  end if;
end $$;

alter table public.backups
  drop constraint if exists backups_storage_path_key;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'backups_company_storage_path_key'
       and conrelid = 'public.backups'::regclass
  ) then
    alter table public.backups
      add constraint backups_company_storage_path_key unique (company_id, storage_path);
  end if;
end $$;

drop index if exists public.backups_kind_period_key_idx;
create unique index if not exists backups_company_kind_period_key_idx
  on public.backups (company_id, kind, period_key)
  where period_key is not null;

------------------------------------------------------------
-- 8. Deferred composite FK from email_webhook_events (263) -> notifications
------------------------------------------------------------

alter table public.email_webhook_events
  drop constraint if exists email_webhook_events_notification_id_fkey,
  drop constraint if exists email_webhook_events_company_notification_fkey;

alter table public.email_webhook_events
  add constraint email_webhook_events_company_notification_fkey
  foreign key (company_id, notification_id)
  references public.notifications(company_id, id)
  on delete set null (notification_id);
