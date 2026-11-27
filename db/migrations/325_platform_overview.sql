-- 325_platform_overview.sql (T185)
--
-- دوال لوحة المشرف العام: إجماليات المنصة وحالة كل شركة (قصة المستخدم 12).
--
-- Per spec.md User Story 12, FR-073 and FR-074:
--   - `platform_overview_totals()`: عدد الشركات (نشطة وموقوفة)، وعدد الوحدات،
--     وعدد حسابات الموظفين، وعدد المستأجرين، والمبلغ المحصّل خلال الشهر
--     الحالي بتوقيت الكويت.
--   - `platform_company_health()`: سطر لكل شركة: حالة اتصال واتساب، وحالة بوابة
--     الدفع، وعدد المهام الخلفية الفاشلة وعدد الإشعارات الفاشلة خلال آخر
--     24 ساعة.
--
-- الدالتان `security definer` لأنهما تقرآن عبر كل الشركات، وكلتاهما ترفض كل
-- مستدعي لا تعرفه `public.is_platform_admin()`: قاعدة البيانات هي المرجع في
-- من يحق له الإشراف على المنصة، لا الشاشة. ولهذا السبب تُمنح `EXECUTE`
-- للمستخدم `authenticated` وحده — لا `anon` ولا `company_service` ولا
-- `service_role` — فليس هناك طريق إلى الرقمين إلا بحساب مشرف منصة حيّ.
--
-- The WhatsApp flag reads today's single Evolution session
-- (`evolution_connections`, migration 179) because the per-company
-- `whatsapp_connections` table arrives with US9 (T158). A company that
-- configured no WhatsApp number has no connection at all (`null`); a company
-- whose number the platform session is not paired with cannot send, so it is
-- `false`. The numbers are compared digit for digit: a connection the platform
-- cannot prove is the worse error to report.
--
-- Rollback:
--   drop function if exists public.platform_company_health();
--   drop function if exists public.platform_overview_totals();

------------------------------------------------------------
-- 1. platform_overview_totals()
------------------------------------------------------------

/**
 * يجمع إجماليات المنصة: الشركات والوحدات والحسابات والمبلغ المحصّل هذا الشهر.
 *
 * The money is counted the way the dashboards count it (`get_budget_summary`):
 * a confirmed payment that was never reversed. The month boundary is Kuwait
 * time, because the companies' day starts there (FR-075).
 */
create or replace function public.platform_overview_totals()
returns table (
  companies_total bigint,
  companies_active bigint,
  companies_suspended bigint,
  units_total bigint,
  staff_users_total bigint,
  renters_total bigint,
  collected_this_month numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month_start date := date_trunc('month', now() at time zone 'Asia/Kuwait')::date;
begin
  if not public.is_platform_admin() then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
    select
      count(*),
      count(*) filter (where c.status = 'active'),
      count(*) filter (where c.status = 'suspended'),
      (select count(*) from public.units u),
      -- Staff accounts are the profiles that hold a staff role. The renter role
      -- is not one: a renter account is bound to a tenant record, and roles
      -- live in `user_roles` only (CLAUDE.md).
      (
        select count(distinct p.id)
          from public.profiles p
          join public.user_roles ur on ur.user_id = p.id
         where p.company_id is not null
           and ur.role <> 'tenant'
      ),
      (select count(*) from public.tenants t),
      (
        select coalesce(sum(pay.amount), 0)
          from public.payments pay
         where pay.status = 'confirmed'
           and pay.reversed_by_payment_id is null
           and pay.payment_date >= v_month_start
           and pay.payment_date < (v_month_start + interval '1 month')::date
      )
    from public.companies c;
end;
$$;

------------------------------------------------------------
-- 2. platform_company_health()
------------------------------------------------------------

/**
 * يعرض حالة كل شركة: واتساب، وبوابة الدفع، والفشلات خلال آخر 24 ساعة.
 *
 * The flags say what the super admin can act on: `null` means "not set up",
 * `false` means "set up and broken", `true` means "working".
 */
create or replace function public.platform_company_health()
returns table (
  company_id uuid,
  slug text,
  name_ar text,
  name_en text,
  status text,
  whatsapp_ok boolean,
  gateway_ok boolean,
  jobs_failed_24h bigint,
  notifications_failed_24h bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
    select
      c.id,
      c.slug,
      c.name_ar,
      c.name_en,
      c.status,
      case
        when nullif(btrim(c.whatsapp), '') is null then null
        when e.last_connection_state = 'open'
          and regexp_replace(coalesce(e.connected_number, ''), '[^0-9]', '', 'g')
              = regexp_replace(btrim(c.whatsapp), '[^0-9]', '', 'g')
          then true
        else false
      end,
      case
        when exists (
          select 1 from public.gateway_connections g
           where g.company_id = c.id
             and g.is_active
        ) then true
        when exists (
          select 1 from public.gateway_connections g
           where g.company_id = c.id
             and not g.last_test_ok
        ) then false
        else null
      end,
      (
        select count(*)
          from public.job_requests j
         where j.company_id = c.id
           and j.status = 'failed'
           and j.finished_at >= now() - interval '24 hours'
      ),
      (
        select count(*)
          from public.notifications n
         where n.company_id = c.id
           and n.state = 'failed'
           and n.created_at >= now() - interval '24 hours'
      )
    from public.companies c
    left join public.evolution_connections e
      on e.company_id = c.id
     and e.id = 1;
end;
$$;

------------------------------------------------------------
-- 3. Grants
------------------------------------------------------------

-- The functions are the only way to read across companies, and they refuse
-- every caller the database does not recognise as a platform admin. The
-- `PUBLIC` grant that Supabase's default privileges add to new functions is
-- revoked first, so `anon` cannot even attempt the call.
revoke all on function public.platform_overview_totals() from public, anon, authenticated, company_service, service_role;
revoke all on function public.platform_company_health() from public, anon, authenticated, company_service, service_role;

grant execute on function public.platform_overview_totals() to authenticated;
grant execute on function public.platform_company_health() to authenticated;
