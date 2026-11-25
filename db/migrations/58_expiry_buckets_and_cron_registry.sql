-- 58_expiry_buckets_and_cron_registry.sql
--
-- T14b: eight mutually exclusive contract-expiry buckets, and a cron registry.

-- ---------------------------------------------------------------------------
-- 1. Expiry buckets
-- ---------------------------------------------------------------------------

-- The previous definition (34_contract_expiry_delivery_retries.sql — 07, 31 and
-- 33 are superseded) had a real overlap:
--
--   the 4/3/2/1-MONTH buckets exclude each other, but the separate `7d` arm is
--   `end_date between as_of and as_of + 7`, which is entirely inside the 1-month
--   bucket. A contract expiring in three days therefore fired TWICE, and one of
--   the two messages read "in 1 month(s)".
--
-- Adding six more thresholds to that `values` list would have multiplied the
-- problem, so this is a rewrite rather than an extension.
--
-- Exclusivity is now STRUCTURAL rather than incidental: a single `case` over
-- (end_date - as_of) returns exactly one value, so a contract cannot be in two
-- buckets no matter what thresholds are added later. A set of range predicates
-- that merely happens not to overlap is what drifted the first time.
--
-- Days throughout. Mixing month arithmetic with day arithmetic is what allowed
-- the two arms to overlap.

-- `create or replace function` CANNOT change an OUT parameter's name or type,
-- and this changes the row type. That exact mistake is why re-applying
-- migrations 07/31/33 to a migrated database fails, and it is documented in
-- CLAUDE.md. Drop first.
drop function if exists public.identify_contract_expiry_reminders(date);

create function public.identify_contract_expiry_reminders(p_as_of date default null)
returns table(
  contract_id uuid,
  tenant_id uuid,
  days_until int,
  milestone text,
  template_type text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_as_of date := coalesce(p_as_of, current_date);
begin
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'notifications.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  select b.contract_id, b.tenant_id, b.days_until, b.milestone, 'contract_expiry'::text
  from (
    select
      c.id as contract_id,
      c.tenant_id,
      (c.end_date - v_as_of)::int as days_until,
      case
        when (c.end_date - v_as_of) < 0   then null
        when (c.end_date - v_as_of) <= 1  then '1d'
        when (c.end_date - v_as_of) <= 7  then '7d'
        when (c.end_date - v_as_of) <= 30 then '30d'
        when (c.end_date - v_as_of) <= 60 then '60d'
        when (c.end_date - v_as_of) <= 90 then '90d'
        when (c.end_date - v_as_of) <= 120 then '120d'
        when (c.end_date - v_as_of) <= 150 then '150d'
        when (c.end_date - v_as_of) <= 180 then '180d'
        else null
      end as milestone
    from public.contracts c
    join public.tenants t on t.id = c.tenant_id
    where c.state = 'active'
  ) b
  where b.milestone is not null
  order by b.days_until, b.contract_id;
end;
$$;

revoke all on function public.identify_contract_expiry_reminders(date) from public;
grant execute on function public.identify_contract_expiry_reminders(date)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Contract-expiry templates: two live defects
-- ---------------------------------------------------------------------------

-- Defect 1: migration 07 seeded the bodies with {{months_until_expiry}}, but
-- contractExpiryJob.ts puts `months_until` in the payload — so the placeholder
-- never resolved and every message shipped with the literal token. The wording
-- now derives from the bucket, using `milestone`, which the job does provide.
--
-- Defect 2: migration 38 added provider_template_name / provider_param_keys and
-- the WhatsApp sender refuses to send without them, but NO migration ever
-- seeded them for these templates — so the WhatsApp leg of contract expiry has
-- been silently dead since 38. Seeded here.
--
-- The Meta template still has to exist under this name in the WhatsApp Business
-- account; this makes the mapping correct, it cannot approve a template.
update public.notification_templates
   set body_ar = 'السيد/ة {{tenant_name}}، ينتهي عقد الوحدة {{unit}} خلال {{days_until}} يوم. {{company_name}}',
       body_en = 'Dear {{tenant_name}}, the contract for {{unit}} expires in {{days_until}} day(s). {{company_name}}',
       provider_template_name = coalesce(
         nullif(provider_template_name, 'META_TEMPLATE_NAME_REQUIRED'),
         'contract_expiry_notice'
       ),
       provider_param_keys = case
         when cardinality(provider_param_keys) = 0
           then array['tenant_name', 'unit', 'days_until', 'company_name']
         else provider_param_keys
       end
 where code in ('contract-expiry-ar', 'contract-expiry-en');

-- ---------------------------------------------------------------------------
-- 3. Cron registry
-- ---------------------------------------------------------------------------

-- There was no cron-run table anywhere. The only observability was per-job
-- write_audit, and not every job writes one — so "did the nightly job run?" was
-- unanswerable from inside the app.
--
-- Modelled on public.report_schedules (07_phase5:89-102), plus the row-level
-- pause switch that table lacks.
create table if not exists public.cron_jobs (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name_ar text not null,
  name_en text not null,
  description_ar text,
  description_en text,
  is_active boolean not null default true,
  last_run_at timestamptz,
  last_status text check (last_status in ('success', 'error', 'skipped')),
  last_duration_ms integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.cron_jobs enable row level security;

drop policy if exists cron_jobs_staff_read on public.cron_jobs;
create policy cron_jobs_staff_read on public.cron_jobs for select to authenticated
  using (public.is_staff(auth.uid()));
-- Pausing a job changes what the system does unattended, so it is admin-only
-- rather than merely staff.
drop policy if exists cron_jobs_admin_update on public.cron_jobs;
create policy cron_jobs_admin_update on public.cron_jobs for update to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));
drop policy if exists cron_jobs_service_role_all on public.cron_jobs;
create policy cron_jobs_service_role_all on public.cron_jobs for all to service_role
  using (true) with check (true);

drop trigger if exists cron_jobs_set_updated_at on public.cron_jobs;
create trigger cron_jobs_set_updated_at before update on public.cron_jobs
  for each row execute function public.tg_set_updated_at();

-- The seven keys registered in src/fns/cronJobs.ts. Keep in step with that map.
insert into public.cron_jobs (key, name_ar, name_en, description_ar, description_en)
values
  ('overdue', 'تحديث المتأخرات', 'Evaluate overdue',
   'يحوّل الفواتير المستحقة إلى متأخرة بعد فترة السماح.',
   'Flips due invoices to overdue once the grace period has passed.'),
  ('overdue-reminders', 'تذكيرات المتأخرات', 'Overdue reminders',
   'يرسل تذكيرات للمستأجرين أصحاب الفواتير المتأخرة.',
   'Sends reminders to tenants with overdue invoices.'),
  ('contract-expiry', 'تنبيهات انتهاء العقود', 'Contract expiry',
   'ينبّه قبل انتهاء العقد على ثماني مراحل متتابعة.',
   'Warns before a contract ends, across eight successive thresholds.'),
  ('scheduled-reports', 'التقارير المجدولة', 'Scheduled reports',
   'يرسل التقارير الدورية إلى المستلمين المحددين.',
   'Emails the recurring reports to their configured recipients.'),
  ('notification-drain', 'إرسال الإشعارات', 'Notification drain',
   'يفرّغ طابور الإشعارات المعلّقة.',
   'Drains the queued notification pool.'),
  ('gmail-sync', 'مزامنة البريد', 'Gmail sync',
   'يسحب رسائل صندوق البريد المتصل إلى صندوق الوارد.',
   'Pulls the connected mailbox into the unified inbox.'),
  ('salaries', 'رواتب الشهر', 'Monthly salaries',
   'ينشئ سجل راتب لكل موظف على رأس العمل.',
   'Creates one salary row per active employee.')
on conflict (key) do update
  set name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      description_ar = excluded.description_ar,
      description_en = excluded.description_en;

-- ---------------------------------------------------------------------------
-- 4. Recording a run
-- ---------------------------------------------------------------------------

-- Called by respondToCronRequest after every tick. `security definer` because
-- the cron path runs as service_role but an admin "run now" runs as the admin,
-- and neither should need direct write access to the registry.
create or replace function public.record_cron_run(
  _key text,
  _status text,
  _duration_ms integer default null,
  _error text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.cron_jobs
     set last_run_at = now(),
         last_status = _status,
         last_duration_ms = _duration_ms,
         last_error = _error
   where key = _key;
$$;

revoke all on function public.record_cron_run(text, text, integer, text) from public;
grant execute on function public.record_cron_run(text, text, integer, text)
  to authenticated, service_role;
