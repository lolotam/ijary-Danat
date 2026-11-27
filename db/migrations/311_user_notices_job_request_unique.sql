-- 311 (T071): one notice per job request.
--
-- The worker upserts the notice of a finished job with onConflict
-- job_request_id, so the column needs a unique index it can name. A plain
-- unique index is what ON CONFLICT can use without repeating the index
-- predicate; the notices that name no job request stay free, because Postgres
-- treats nulls as distinct.
--
-- Guarded by src/db/outbox/enqueueJob.sqltest.ts.

create unique index user_notices_job_request_id
  on public.user_notices (job_request_id);
