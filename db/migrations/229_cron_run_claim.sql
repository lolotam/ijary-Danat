-- 229_cron_run_claim.sql
--
-- يحجز تشغيل مهمة مجدولة في قاعدة البيانات، فلا يبدأ الطلب المكرر نفسه مرتين.
--
-- The process-local lock in cronJobs.ts (added 2026-09-02) only refuses a
-- duplicate that arrives WHILE the first run is still in flight. The unknown
-- second caller keeps firing ~0.5–0.8 s after the first; the nightly jobs now
-- finish faster than that, so the duplicate starts a second, complete run.
-- Production audit_logs (checked 2026-09-24) show `job.contract_expiry` and
-- `job.notification_drain` each recorded twice on most nights from 09-10 on,
-- e.g. contract-expiry at 01:20:02.039 and 01:20:02.841 on 09-23. Those runs
-- queued nothing twice, but a duplicate weekly admin report did go out on
-- 2026-09-01.
--
-- `claim_cron_run` atomically stamps `cron_jobs.last_claimed_at` and answers
-- true only when no claim was made in the last `p_window_seconds`. The UPDATE
-- takes a row lock, so two concurrent callers serialize on it and exactly one
-- sees the stale timestamp. The window must stay below the shortest real
-- interval between ticks (payment-reconcile runs every 10 minutes); 60 s is
-- far above the observed duplicate gap and far below that interval.
--
-- A key with no registry row is NOT refused: the registry is advisory for
-- scheduling, and a job missing its row must not silently stop running.
--
-- service_role only — the cron route calls it through supabaseAdmin. The
-- admin "Run now" path does not claim: a deliberate manual run must not be
-- refused because the nightly tick ran a minute ago.

alter table public.cron_jobs add column if not exists last_claimed_at timestamptz;

comment on column public.cron_jobs.last_claimed_at is
  'When the cron route last claimed this job (migration 229). Written only by claim_cron_run.';

create or replace function public.claim_cron_run(p_key text, p_window_seconds integer default 60)
returns boolean
language sql
volatile
security definer
set search_path = public
as $$
  with claimed as (
    update public.cron_jobs
       set last_claimed_at = now()
     where key = p_key
       and (
         last_claimed_at is null
         or last_claimed_at < now() - make_interval(secs => p_window_seconds)
       )
    returning 1
  )
  select exists (select 1 from claimed)
      or not exists (select 1 from public.cron_jobs where key = p_key);
$$;

revoke execute on function public.claim_cron_run(text, integer) from public, anon, authenticated;
grant execute on function public.claim_cron_run(text, integer) to service_role;
