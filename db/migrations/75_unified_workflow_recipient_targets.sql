-- ---------------------------------------------------------------------------
-- 75 — recipient_targets on the workflow registry
-- ---------------------------------------------------------------------------
--
-- Each cron_jobs row can now declare who it emails. The default matches today's
-- getAdminNotificationEmails() behaviour (company email ∪ admin profiles).
-- Per-key seeds below freeze day-one behaviour so every later change is a
-- deliberate admin action.
--
-- Idempotent: applied by hand to the live database, where a retried run must
-- not fail on duplicate_object.

alter table public.cron_jobs
  add column if not exists recipient_targets text[] not null
    default array['admin','company']::text[];

alter table public.cron_jobs
  drop constraint if exists cron_jobs_recipient_targets_check;
alter table public.cron_jobs
  add constraint cron_jobs_recipient_targets_check
  check (recipient_targets <@ array['admin','company','tenant']::text[]
         and cardinality(recipient_targets) > 0);

comment on column public.cron_jobs.recipient_targets is
  'Who this workflow may notify: admin (profile emails), company (companies.email), tenant (end-user blocks).';

-- Seeds: exactly the targets each sender reaches today.
update public.cron_jobs
  set recipient_targets = array['admin','company','tenant']::text[]
  where key in (
    'payment-succeeded',
    'user-credentials-tenant',
    'contract-expiry'
  );

-- overdue-reminders enqueues only `audience: "tenant"` rows (tenant email and
-- WhatsApp) — it never calls the admin resolver. Seeding admin/company here
-- would leave the row carrying targets the sender cannot act on, which the UI
-- would then render as selected-but-disabled pills.
update public.cron_jobs
  set recipient_targets = array['tenant']::text[]
  where key = 'overdue-reminders';

update public.cron_jobs
  set recipient_targets = array['admin','company']::text[]
  where key in (
    'deposit-confirmed',
    'contact-inquiry-received',
    'maintenance-request-created',
    'refund-recorded',
    'contract-created',
    'contract-ended',
    'user-credentials-managerial',
    'overdue',
    'scheduled-reports',
    'notification-drain',
    'gmail-sync',
    'salaries'
  );
