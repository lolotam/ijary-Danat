-- 337_import_batches.sql (T069a)
--
-- ينشئ جدول `import_batches` لتمرحيل صفوف الاستيراد الجماعي المصادَق عليها مؤقتاً
-- قبل معالجتها في العامل الخلفي (`import.run`)، ثم حذفها عند الانتهاء أو الرفض.
--
-- Per contracts/jobs.md section 1 (file contents never go into the queue
-- payload) and research.md R6: `bulkImport` stages validated rows here and
-- enqueues `{ uploadId }` on `import.run`; the worker reads the batch via
-- `companyClient(companyId)` and deletes the row once finished.
--
-- Rollback:
--   drop table if exists public.import_batches;

create table if not exists public.import_batches (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default public.current_company_id()
    references public.companies(id) on delete cascade,
  entity       text not null,
  rows         jsonb not null,
  row_numbers  jsonb,
  requested_by uuid not null,
  created_at   timestamptz not null default now()
);

create index if not exists import_batches_company_created_idx
  on public.import_batches (company_id, created_at);

alter table public.import_batches enable row level security;
alter table public.import_batches force row level security;

-- Only server code touches this table: `bulkImport` stages through
-- `companyClient` and the worker claims through it. Signed-in browsers get no
-- grant at all, so staff cannot read another staff member's staged rows.
revoke all on public.import_batches
  from public, anon, authenticated, company_service, service_role;
grant select, insert, delete on public.import_batches to company_service;
grant all on public.import_batches to service_role;

drop policy if exists import_batches_company_service_all on public.import_batches;
create policy import_batches_company_service_all
  on public.import_batches
  for all
  to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

drop policy if exists import_batches_service_role_all on public.import_batches;
create policy import_batches_service_role_all
  on public.import_batches
  for all
  to service_role
  using (true)
  with check (true);
