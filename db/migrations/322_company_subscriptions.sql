-- 322_company_subscriptions.sql (T116)
--
-- يسجّل اشتراكات الشركات يدوياً لدى المنصة: الخطة والسعر وتاريخ البدء والتجديد
-- والحالة، مع إبقاء كل التجديدات سجلاً تراكمياً لا يُعدَّل. `companies.status`
-- موجود أصلاً في الهجرة 254 ولا يتغيّر هنا: تأخر الاشتراك يُشتقّ من التاريخ ولا
-- يوقّف الشركة تلقائياً (FR-043) — الإيقاف قرار المشرف العام وحده.
--
-- Per spec.md User Story 6, data-model.md `company_subscriptions`, and
-- research.md R18: the current subscription is the row with the latest
-- `period_start`. Overdue is derived from `renewal_date < today` with no later
-- row, and never writes to `companies.status`.
--
-- Staff may read ONLY their own company's current row, which is what the
-- renewal banner needs (FR-042); the whole history is visible to `service_role`
-- alone. The read is gated by a `security definer` helper so the policy does not
-- recurse into its own table when it looks for the current row.
--
-- Rollback:
--   drop trigger if exists company_subscriptions_immutable_delete on public.company_subscriptions;
--   drop trigger if exists company_subscriptions_immutable_update on public.company_subscriptions;
--   drop function if exists public.tg_company_subscriptions_immutable();
--   drop function if exists public.current_company_subscription_id();
--   drop table if exists public.company_subscriptions;

------------------------------------------------------------
-- 1. company_subscriptions
------------------------------------------------------------

create table if not exists public.company_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default public.current_company_id()
                 references public.companies(id) on delete cascade,
  plan_name    text not null check (length(btrim(plan_name)) > 0),
  price        numeric(14,3) not null check (price >= 0),
  period_start date not null,
  renewal_date date not null,
  status       text not null default 'active'
                 check (status in ('trial', 'active', 'overdue', 'cancelled')),
  note         text,
  recorded_by  uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint company_subscriptions_period_order check (renewal_date >= period_start)
);

-- Composite key for the per-company foreign keys other tables may add later,
-- matching the integrity rule applied to every company-scoped table.
create unique index if not exists company_subscriptions_company_id_id_idx
  on public.company_subscriptions (company_id, id);

create index if not exists company_subscriptions_company_period_idx
  on public.company_subscriptions (company_id, period_start desc, created_at desc);

alter table public.company_subscriptions enable row level security;
alter table public.company_subscriptions force row level security;

revoke all on public.company_subscriptions from public, anon, authenticated, company_service, service_role;
grant select on public.company_subscriptions to authenticated, company_service;
grant all on public.company_subscriptions to service_role;

/**
 * يُعيد معرّف الاشتراك الحالي للشركة التي يستدعيها، أو null إن لم يكن هناك اشتراك.
 *
 * `security definer` is load-bearing: the SELECT policy below calls it while
 * evaluating a row of this same table. A plain invoker call would re-enter the
 * policy and recurse; as definer it reads the table with the migration role and
 * still resolves the company through `current_company_id()`.
 */
create or replace function public.current_company_subscription_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id
    from public.company_subscriptions s
   where s.company_id = (select public.current_company_id())
   order by s.period_start desc, s.created_at desc
   limit 1;
$$;

revoke all on function public.current_company_subscription_id() from public, anon;
grant execute on function public.current_company_subscription_id()
  to authenticated, company_service, service_role;

drop policy if exists company_subscriptions_select_current on public.company_subscriptions;
create policy company_subscriptions_select_current on public.company_subscriptions
  for select
  to authenticated, company_service
  using (
    company_id = (select public.current_company_id())
    and id = (select public.current_company_subscription_id())
    and (
      (select auth.role()) = 'company_service'
      or (select public.is_staff((select auth.uid())))
    )
  );

drop policy if exists company_subscriptions_service_role_all on public.company_subscriptions;
create policy company_subscriptions_service_role_all on public.company_subscriptions
  for all
  to service_role
  using (true)
  with check (true);

/**
 * يرفض تعديل أو حذف سطر اشتراك؛ التجديد صف جديد وليس تحديثاً للقديم.
 */
create or replace function public.tg_company_subscriptions_immutable()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'COMPANY_SUBSCRIPTION_IMMUTABLE: company_subscriptions rows cannot be %ed',
    lower(tg_op)
    using errcode = '42501';
end;
$$;

revoke execute on function public.tg_company_subscriptions_immutable() from public, anon;

drop trigger if exists company_subscriptions_immutable_update on public.company_subscriptions;
create trigger company_subscriptions_immutable_update
  before update on public.company_subscriptions
  for each row execute function public.tg_company_subscriptions_immutable();

drop trigger if exists company_subscriptions_immutable_delete on public.company_subscriptions;
create trigger company_subscriptions_immutable_delete
  before delete on public.company_subscriptions
  for each row execute function public.tg_company_subscriptions_immutable();
