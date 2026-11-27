-- 329_platform_company_health_v2.sql (FR-074)
--
-- يحدّث دالة `platform_company_health()` لتُرجِع لكل شركة، إلى جانب الحالة
-- الصحية، المبلغ المحصّل خلال الشهر الحالي بتوقيت الكويت، واستهلاك الحدود مقابل
-- السقوف (الوحدات والموظفون وواتساب والتخزين)، وحالة الاشتراك وتاريخ تجديده.
--
-- Per spec.md FR-074:
--   - Preserves all existing columns and logic from `325_platform_overview.sql`
--     section 2 (including `e.company_id = c.id and e.id = 1`).
--   - Appends: `collected_this_month`, `units_used`, `units_max`, `staff_used`,
--     `staff_max`, `whatsapp_used`, `whatsapp_max`, `storage_bytes`,
--     `storage_max`, `subscription_status`, `subscription_renewal_date`.
--   - Keeps `security definer`, `set search_path = public`, the
--     `PLATFORM_ADMIN_REQUIRED` check first, and `EXECUTE` granted to
--     `authenticated` only.
--
-- Rollback:
--   drop function if exists public.platform_company_health();
--   -- Re-run section 2 + grant from 325_platform_overview.sql to restore v1.

drop function if exists public.platform_company_health();

/**
 * يعرض حالة كل شركة مع التحصيل الشهري واستهلاك الحدود وحالة الاشتراك.
 *
 * The month boundary uses `Asia/Kuwait` and the payment/staff predicates match
 * `platform_overview_totals()`, so per-company numbers reconcile with the
 * platform totals strip.
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
  notifications_failed_24h bigint,
  collected_this_month numeric,
  units_used bigint,
  units_max int,
  staff_used bigint,
  staff_max int,
  whatsapp_used int,
  whatsapp_max int,
  storage_bytes bigint,
  storage_max bigint,
  subscription_status text,
  subscription_renewal_date date
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
      ),
      (
        select coalesce(sum(pay.amount), 0)
          from public.payments pay
         where pay.company_id = c.id
           and pay.status = 'confirmed'
           and pay.reversed_by_payment_id is null
           and pay.payment_date >= v_month_start
           and pay.payment_date < (v_month_start + interval '1 month')::date
      ),
      (
        select count(*)
          from public.units u
         where u.company_id = c.id
      ),
      cl.max_units,
      (
        select count(distinct p.id)
          from public.profiles p
          join public.user_roles ur on ur.user_id = p.id
         where p.company_id = c.id
           and ur.role <> 'tenant'
      ),
      cl.max_staff_users,
      coalesce(
        (
          select um.whatsapp_sent
            from public.company_usage_monthly um
           where um.company_id = c.id
             and um.month = v_month_start
        ),
        0
      ),
      cl.max_whatsapp_per_month,
      coalesce(su.bytes, 0::bigint),
      cl.max_storage_bytes,
      sub.status,
      sub.renewal_date
    from public.companies c
    left join public.evolution_connections e
      on e.company_id = c.id
     and e.id = 1
    left join public.company_limits cl
      on cl.company_id = c.id
    left join public.company_storage_usage su
      on su.company_id = c.id
    -- Latest subscription per company via distinct on, not a lateral `limit 1`:
    -- the T014 structure test forbids any `from companies … limit 1` statement.
    left join (
      select distinct on (s.company_id) s.company_id, s.status, s.renewal_date
        from public.company_subscriptions s
       order by s.company_id, s.period_start desc, s.created_at desc
    ) sub on sub.company_id = c.id;
end;
$$;

revoke all on function public.platform_company_health() from public, anon, authenticated, company_service, service_role;
grant execute on function public.platform_company_health() to authenticated;
