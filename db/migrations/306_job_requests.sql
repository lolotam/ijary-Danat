-- 306 (T059): the background-work outbox — job_requests, user_notices, enqueue_job().
--
-- Every deferred piece of work is a job_requests row inserted in the same
-- transaction as the change that caused it; the worker relays pending rows to
-- BullMQ with jobId = row id (contracts/jobs.md sections 1-2, research.md R6).
--
-- Only server code (company_service) and SQL functions running as their owner
-- may call enqueue_job(); the worker (service_role) writes rows directly.
-- A signed-in user has no privilege on job_requests or on enqueue_job(), so a
-- renter cannot queue work such as `company.restore`.
--
-- Guarded by src/db/outbox/enqueueJob.sqltest.ts.

------------------------------------------------------------
-- 1. job_requests
------------------------------------------------------------

create table public.job_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null
    check (kind ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  -- Payloads carry ids only; the text length bounds them regardless of TOAST compression.
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 16384),
  dedupe_key text check (dedupe_key is null or length(dedupe_key) between 1 and 200),
  requested_by uuid,
  status text not null default 'pending'
    check (status in ('pending', 'published', 'running', 'succeeded', 'failed', 'skipped')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  finished_at timestamptz,
  unique (company_id, id),
  -- A requester must be a member of the job's company.
  foreign key (company_id, requested_by)
    references public.profiles (company_id, id) on delete set null (requested_by)
);

create unique index job_requests_dedupe_key
  on public.job_requests (company_id, kind, dedupe_key)
  where dedupe_key is not null;

create index job_requests_pending
  on public.job_requests (status, created_at)
  where status = 'pending';

create index job_requests_company_status
  on public.job_requests (company_id, status, created_at desc);

alter table public.job_requests enable row level security;
alter table public.job_requests force row level security;

-- Default privileges (Supabase and 254) grant every new table to anon, authenticated
-- and company_service. Outbox rows are never deleted by company code, so a pending
-- money event cannot vanish before the relay sees it.
revoke all on public.job_requests from public, anon, authenticated, company_service;
grant select, insert, update on public.job_requests to company_service;
grant all on public.job_requests to service_role;

create policy job_requests_company_service_all
  on public.job_requests
  for all
  to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

-- The relay and scheduler run as service_role across companies (CLAUDE.md allow-list).
create policy job_requests_service_role_all
  on public.job_requests
  for all
  to service_role
  using (true)
  with check (true);

------------------------------------------------------------
-- 2. user_notices
------------------------------------------------------------

create table public.user_notices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null,
  job_request_id uuid,
  kind text not null,
  title_key text not null,
  body jsonb not null default '{}'::jsonb,
  level text not null check (level in ('success', 'error')),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (company_id, user_id)
    references public.profiles (company_id, id) on delete cascade,
  foreign key (company_id, job_request_id)
    references public.job_requests (company_id, id) on delete set null (job_request_id)
);

create index user_notices_user_unread
  on public.user_notices (user_id, created_at desc)
  where read_at is null;

alter table public.user_notices enable row level security;
alter table public.user_notices force row level security;

revoke all on public.user_notices from public, anon, authenticated;
-- A user may only mark a notice read; every other column is written by handlers.
grant select on public.user_notices to authenticated;
grant update (read_at) on public.user_notices to authenticated;
grant select, insert, update, delete on public.user_notices to company_service;
grant all on public.user_notices to service_role;

create policy user_notices_select_own
  on public.user_notices
  for select
  to authenticated
  using (
    company_id = (select public.current_company_id())
    and user_id = (select auth.uid())
  );

create policy user_notices_update_own
  on public.user_notices
  for update
  to authenticated
  using (
    company_id = (select public.current_company_id())
    and user_id = (select auth.uid())
  )
  with check (
    company_id = (select public.current_company_id())
    and user_id = (select auth.uid())
  );

create policy user_notices_company_service_all
  on public.user_notices
  for all
  to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy user_notices_service_role_all
  on public.user_notices
  for all
  to service_role
  using (true)
  with check (true);

-- Notices reach the screen through Realtime, which applies the policies above (research.md R19).
do $$
begin
  -- A FOR ALL TABLES publication already carries the table and rejects ADD TABLE.
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables
  ) then
    alter publication supabase_realtime add table public.user_notices;
  end if;
end;
$$;

------------------------------------------------------------
-- 3. enqueue_job()
------------------------------------------------------------

/**
 * يسجّل طلب مهمة خلفية للشركة الحالية داخل المعاملة الجارية ويعيد معرّفه، أو معرّف الطلب
 * الموجود إن تكرر مفتاح منع التكرار للنوع نفسه.
 *
 * Security invoker: company_service writes through its own policy, and SQL
 * functions that emit money events run as their owner. A rolled-back caller
 * leaves no row, so no event escapes a failed change (FR-018).
 *
 * The requester: company_service carries no `sub`, so server code names the
 * staff member in `_requested_by`; every other caller gets the JWT `sub` and the
 * argument is ignored. The composite FK to profiles rejects a requester from
 * another company.
 */
create or replace function public.enqueue_job(
  _kind text,
  _payload jsonb default '{}'::jsonb,
  _dedupe_key text default null,
  _requested_by uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_requested_by uuid;
  v_job_id uuid;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  -- current_user, not request_api_role(): that helper calls auth.role(), and
  -- company_service has no usage on schema auth. Owner-run functions see their owner here.
  if current_user = 'company_service' then
    v_requested_by := _requested_by;
  else
    -- Read `sub` directly for the same reason auth.uid() is avoided.
    v_requested_by := nullif(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', ''
    )::uuid;
  end if;

  insert into public.job_requests (company_id, kind, payload, dedupe_key, requested_by)
  values (v_company_id, _kind, coalesce(_payload, '{}'::jsonb), _dedupe_key, v_requested_by)
  on conflict (company_id, kind, dedupe_key) where dedupe_key is not null
  do nothing
  returning id into v_job_id;

  if v_job_id is null then
    select j.id into v_job_id
      from public.job_requests j
     where j.company_id = v_company_id
       and j.kind = _kind
       and j.dedupe_key = _dedupe_key;
  end if;

  return v_job_id;
end;
$$;

-- service_role has no company context, so it would always hit COMPANY_REQUIRED;
-- the relay and fan-out write job_requests directly instead.
revoke all on function public.enqueue_job(text, jsonb, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.enqueue_job(text, jsonb, text, uuid) to company_service;
