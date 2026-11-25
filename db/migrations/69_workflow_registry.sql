-- ---------------------------------------------------------------------------
-- 69 — one registry for scheduled jobs and event-triggered workflows
-- ---------------------------------------------------------------------------
--
-- The table keeps the name `cron_jobs` deliberately. Renaming it to `workflows`
-- would churn three RLS policies, record_cron_run, the updated_at trigger,
-- useCronJobs, database.types.ts and expiryBuckets.sqltest.ts for no functional
-- gain, on a table production already depends on. The UI says "Workflows"; the
-- table keeps its name.
--
-- Event rows are NOT dispatchable by the cron endpoint. respondToCronRequest
-- validates with isCronJobName, which tests membership of the hardcoded JOBS
-- map in src/fns/cronJobs.ts, and no event key appears there. Registering these
-- rows therefore cannot widen that endpoint's surface — cronJobs.test.ts pins
-- it.

alter table public.cron_jobs
  add column if not exists kind text not null default 'scheduled';

-- A separate, dropped-and-recreated constraint so a re-run over a database that
-- already has the column still ends up constrained.
alter table public.cron_jobs drop constraint if exists cron_jobs_kind_check;
alter table public.cron_jobs
  add constraint cron_jobs_kind_check check (kind in ('scheduled', 'event'));

comment on column public.cron_jobs.kind is
  'scheduled = dispatched by the cron endpoint; event = fired by an application trigger.';

-- The four event-driven senders. Descriptions state the trigger, not a
-- schedule, because that is the only thing an admin can act on here.
--
-- `do update` deliberately does NOT touch is_active: replaying this migration
-- must never silently re-enable a workflow an admin switched off.
insert into public.cron_jobs (key, kind, name_ar, name_en, description_ar, description_en)
values
  ('user-credentials-managerial', 'event',
   'بيانات دخول حساب إداري', 'Managerial account credentials',
   'يرسل بيانات الدخول عند إنشاء حساب مستخدم إداري، مع نسخة إلى مستلمي الإدارة.',
   'Emails login details when a managerial user account is created, with a copy to the admin recipients.'),
  ('user-credentials-tenant', 'event',
   'بيانات دخول بوابة المستأجر', 'Tenant portal credentials',
   'يرسل بيانات دخول البوابة بالبريد وواتساب عند إنشاء حساب بوابة للمستأجر.',
   'Emails and WhatsApps portal login details when a tenant portal account is created.'),
  ('deposit-confirmed', 'event',
   'تأكيد الإيداع', 'Deposit confirmed',
   'يرسل إلى مستلمي الإدارة عند تأكيد الإيداع، مع إرفاق مستنده.',
   'Emails the admin recipients when a deposit is confirmed, attaching its document.'),
  ('payment-succeeded', 'event',
   'نجاح الدفع', 'Payment succeeded',
   'يرسل الإيصال للمستأجر وتنبيهاً لمستلمي الإدارة عند نجاح الدفع.',
   'Emails the receipt to the tenant and an alert to the admin recipients when a payment succeeds.')
on conflict (key) do update
  set kind = excluded.kind,
      name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      description_ar = excluded.description_ar,
      description_en = excluded.description_en;
