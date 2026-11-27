-- 334_whatsapp_connections_readers.sql (US9: T159–T162 follow-up)
--
-- يفتح قراءة اتصال واتساب النشط لموظفي صندوق الرسائل، وينقل مؤشر واتساب في
-- لوحة صحة الشركات من جلسة Evolution القديمة إلى جدول `whatsapp_connections`.
--
-- 1. `whatsapp_connections_select_staff` answered `settings.integrations`
--    only, so a staff member who may read the inbox (`notifications.read`) but
--    not manage integrations saw no active connection and the inbox scoped by
--    `connection_id` came back empty. The column-level grant from 333 still
--    keeps `last_qr` out of reach of `authenticated`.
-- 2. `platform_company_health()` read the `evolution_connections` singleton
--    (id 1). Every company now has its own connection row, so the flag reads
--    the company's active one: connected is `true`, any other state `false`,
--    and no active connection is `null` unless the company published a
--    WhatsApp number it cannot send from (`false`).
--
-- Rollback:
--   re-run the select policy from 333 section 4, and the function + grants
--   from 329_platform_company_health_v2.sql.

drop policy if exists whatsapp_connections_select_staff on public.whatsapp_connections;
create policy whatsapp_connections_select_staff
  on public.whatsapp_connections
  for select
  to authenticated
  using (
    company_id = (select public.current_company_id())
    and (
      (select public.has_permission((select auth.uid()), 'settings.integrations'::text))
      or (select public.has_permission((select auth.uid()), 'notifications.read'::text))
    )
  );

drop function if exists public.platform_company_health();

/**
 * يعرض حالة كل شركة مع التحصيل الشهري واستهلاك الحدود وحالة الاشتراك،
 * ومؤشر واتساب من اتصال الشركة النشط.
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
        when wc.id is not null and wc.status = 'connected' then true
        when wc.id is not null then false
        when nullif(btrim(c.whatsapp), '') is null then null
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
    left join public.whatsapp_connections wc
      on wc.company_id = c.id
     and wc.is_active
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
