-- 307 (T063): the relay's atomic claim — public.relay_claim_jobs().
--
-- The relay publishes job_requests rows to BullMQ. PostgREST cannot run
-- `for update skip locked` across a request, so the claim happens inside one
-- SQL statement: a row belongs to exactly one round, and two relays never
-- claim the same row (contracts/jobs.md section 2, research.md R6).
--
-- A crash between the claim and `queue.add` leaves the row `published`. The
-- sweep re-claims rows published more than five minutes ago, and BullMQ
-- ignores the duplicate job id, so the job still runs exactly once.
--
-- Only the worker (service_role) may call it: a company must never publish
-- another company's work.
--
-- Guarded by src/db/outbox/relayClaim.sqltest.ts.

------------------------------------------------------------
-- The sweep looks for rows published more than five minutes ago;
-- without this index the relay's once-a-second claim scans the
-- whole outbox.
------------------------------------------------------------

create index job_requests_published_sweep
  on public.job_requests (published_at)
  where status = 'published';

------------------------------------------------------------
-- relay_claim_jobs()
------------------------------------------------------------

/**
 * يحجز حتى `_limit` صفاً من `job_requests` للنشر في BullMQ ويعيد (المعرّف، الشركة، النوع).
 *
 * Security invoker: the caller needs UPDATE on job_requests across companies,
 * which only service_role has (CLAUDE.md allow-list). One statement picks the
 * rows with `for update skip locked` and marks them published, so a row is
 * never claimed twice and a crash between the claim and the queue leaves a
 * row the five-minute sweep picks up again.
 */
create or replace function public.relay_claim_jobs(_limit integer default 100)
returns table (id uuid, company_id uuid, kind text)
language sql
security invoker
set search_path = public
as $$
  with claimed as (
    select j.id, j.company_id, j.kind
      from public.job_requests j
     where j.status = 'pending'
        or (j.status = 'published' and j.published_at < now() - interval '5 minutes')
     order by j.created_at
     limit _limit
     for update skip locked
  )
  update public.job_requests j
     set status = 'published',
         published_at = now()
    from claimed c
   where j.id = c.id
  returning j.id, j.company_id, j.kind;
$$;

-- The relay is the only caller: a company must not publish another company's work.
revoke all on function public.relay_claim_jobs(integer)
  from public, anon, authenticated, company_service;
grant execute on function public.relay_claim_jobs(integer) to service_role;
