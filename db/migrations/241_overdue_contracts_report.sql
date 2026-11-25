-- 241_overdue_contracts_report.sql
--
-- Weekly "overdue by contract" report: one row per contract with overdue
-- invoices. A second report kind on report_schedules rather than a section in
-- the summary report, so it can be switched off on its own. The summary builder
-- (build_scheduled_report_html, live body from 143) is NOT touched.

alter table public.report_schedules
  add column if not exists report_kind text not null default 'summary';
alter table public.report_schedules
  drop constraint if exists report_schedules_report_kind_check;
alter table public.report_schedules
  add constraint report_schedules_report_kind_check
  check (report_kind in ('summary', 'overdue_contracts'));

-- يعيد اسم الشهر والسنة بلغة التقرير، مثل «يناير 2026».
create or replace function public.report_month_label(p_year int, p_month int, p_is_ar boolean)
returns text language sql immutable
set search_path = public
as $fn$
  select (case when p_is_ar
    then (array['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'])[p_month]
    else (array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])[p_month]
  end) || ' ' || p_year;
$fn$;

-- يبني تقرير المتأخرات الأسبوعي: صف لكل عقد عليه فواتير متأخرة.
-- Overdue = state 'overdue' (set by evaluate_overdue after grace days) with a
-- positive balance; archived contracts are excluded (migration 82 rule).
--
-- Locale notes: report_schedules.locale is public.locale_code (an enum, 07),
-- so the unknown literal in the = comparison coerces on its own (143 does the
-- same), while the html lang= attribute and the seed coalesce below spell the
-- casts out. v_company_name follows migration 143 exactly, fallback included.
create or replace function public.build_overdue_contracts_report_html(
  p_schedule_id uuid, p_as_of date default null)
returns table(html text, period_start date, period_end date)
language plpgsql security definer
set search_path = public
as $fn$
declare
  v_schedule public.report_schedules%rowtype;
  v_company public.companies%rowtype;
  v_end date := coalesce(p_as_of, current_date);
  v_start date;
  v_is_ar boolean;
  v_dir text;
  v_rows text := '';
  v_count integer := 0;
  v_total numeric(14,3) := 0;
  v_title text;
  v_company_name text;
  r record;
  c_on text := '#0b1c30'; c_muted text := '#434655'; c_outline text := '#c3c6d7';
  c_primary text := '#004ac6'; c_red text := '#EF4444'; c_bg text := '#f8f9ff';
begin
  if auth.role() = 'authenticated' and not public.has_permission(auth.uid(), 'reports.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  select * into v_schedule from public.report_schedules where id = p_schedule_id;
  if not found then raise exception 'Report schedule not found'; end if;
  v_is_ar := v_schedule.locale = 'ar';
  v_dir := case when v_is_ar then 'rtl' else 'ltr' end;
  select * into v_company from public.companies order by created_at limit 1;
  v_company_name := coalesce(
    case when v_is_ar then v_company.name_ar else coalesce(v_company.name_en, v_company.name_ar) end,
    case when v_is_ar then 'دانة المستقبل العقارية' else 'Danat Al Mustaqbal Real Estate' end
  );
  v_title := coalesce(case when v_is_ar then v_schedule.name_ar else v_schedule.name_en end,
                      v_schedule.name_ar);

  -- الفترة عنوان لقطة فقط؛ الصفوف تبقى «متأخرة بتاريخ v_end» مهما كان التكرار.
  v_start := case v_schedule.frequency
    when 'daily' then v_end
    when 'weekly' then v_end - 6
    when 'monthly' then date_trunc('month', v_end)::date
    when 'yearly' then date_trunc('year', v_end)::date
  end;

  for r in
    with per_contract as (
      select i.contract_id,
             count(distinct (i.period_year, i.period_month)) as months,
             min(i.period_year * 100 + i.period_month) as first_ym,
             max(i.period_year * 100 + i.period_month) as last_ym,
             sum(i.balance) as total
        from public.invoices i
        join public.contracts c on c.id = i.contract_id
       where i.state = 'overdue' and i.balance > 0 and c.archived_at is null
       group by i.contract_id
    )
    select c.code,
           public.tenant_display_name(t, true) as party,
           pc.months, pc.first_ym, pc.last_ym, pc.total
      from per_contract pc
      join public.contracts c on c.id = pc.contract_id
      join public.tenants t on t.id = c.tenant_id
     order by pc.total desc, c.code
  loop
    v_count := v_count + 1;
    v_total := v_total + r.total;
    v_rows := v_rows || '<tr>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';" dir="rtl">'
      || replace(replace(replace(coalesce(r.party, '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';font-family:monospace;" dir="ltr">'
      || replace(replace(replace(coalesce(r.code, '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';text-align:center;">' || r.months || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';">'
      || public.report_month_label(r.first_ym / 100, r.first_ym % 100, v_is_ar) || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';">'
      || public.report_month_label(r.last_ym / 100, r.last_ym % 100, v_is_ar) || '</td>'
      || '<td style="padding:8px;border-bottom:1px solid ' || c_outline || ';color:' || c_red || ';font-weight:700;" dir="ltr">'
      || to_char(r.total, 'FM999,999,990.000') || ' KWD</td>'
      || '</tr>';
  end loop;

  html := '<!doctype html><html lang="' || v_schedule.locale::text || '" dir="' || v_dir || '"><head><meta charset="utf-8">'
    || '<meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    || '<body style="margin:0;padding:16px;background:' || c_bg || ';font-family:Cairo,Segoe UI,Arial,sans-serif;color:' || c_on || ';">'
    || '<div style="max-width:900px;margin:0 auto;background:#fff;border:1px solid ' || c_outline || ';border-radius:16px;padding:20px;">'
    || '<div style="font-size:20px;font-weight:700;color:' || c_primary || ';">'
    || replace(replace(replace(v_company_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</div>'
    || '<div style="font-size:16px;font-weight:600;color:' || c_muted || ';margin:6px 0 16px;">'
    || replace(replace(replace(v_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || ' · ' || v_start || ' / ' || v_end || '</div>'
    || case when v_count = 0
         then '<p style="color:' || c_muted || ';">'
              || case when v_is_ar then 'لا توجد عقود متأخرة' else 'No overdue contracts' end || '</p>'
         else '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">'
           || '<thead><tr style="background:#eff4ff;text-align:start;">'
           || case when v_is_ar
                then '<th style="padding:8px;">الاسم التجاري</th><th style="padding:8px;">رقم العقد</th><th style="padding:8px;">عدد الأشهر المتأخرة</th><th style="padding:8px;">من</th><th style="padding:8px;">إلى</th><th style="padding:8px;">إجمالي المتأخر</th>'
                else '<th style="padding:8px;">Commercial name</th><th style="padding:8px;">Contract</th><th style="padding:8px;">Overdue months</th><th style="padding:8px;">From</th><th style="padding:8px;">To</th><th style="padding:8px;">Total overdue</th>'
              end
           || '</tr></thead><tbody>' || v_rows || '</tbody>'
           || '<tfoot><tr style="font-weight:700;background:#fff5f5;">'
           || '<td style="padding:8px;" colspan="5">'
           || case when v_is_ar then 'الإجمالي (' || v_count || ' عقد)' else 'Total (' || v_count || ' contracts)' end
           || '</td><td style="padding:8px;color:' || c_red || ';" dir="ltr">' || to_char(v_total, 'FM999,999,990.000') || ' KWD</td>'
           || '</tr></tfoot></table>'
       end
    || '</div></body></html>';
  period_start := v_start;
  period_end := v_end;
  return next;
end;
$fn$;

revoke all on function public.report_month_label(int, int, boolean) from public, anon;
revoke all on function public.build_overdue_contracts_report_html(uuid, date) from public, anon;
grant execute on function public.report_month_label(int, int, boolean) to authenticated, service_role;
grant execute on function public.build_overdue_contracts_report_html(uuid, date) to authenticated, service_role;

-- Seed: copies recipients, locale and next run from 7-DAYS-REPORT (the owner's
-- weekly summary) and is ALWAYS inserted inactive: until the new runner is
-- deployed, an active row would be run by the old builder and email a summary
-- titled "Weekly Overdue Report". The orchestrator activates it after deploy.
insert into public.report_schedules
  (code, name_ar, name_en, frequency, recipients, locale, is_active, next_run_at, report_kind)
select 'WEEKLY-OVERDUE-REPORT', 'تقرير المتأخرات الأسبوعي', 'Weekly Overdue Report', 'weekly',
       coalesce(w.recipients, '[]'::jsonb),
       coalesce(w.locale, 'ar'::public.locale_code),
       false,
       w.next_run_at,
       'overdue_contracts'
  from (select 1) as one
  left join lateral (
    select * from public.report_schedules where code = '7-DAYS-REPORT'
  ) w on true
on conflict (code) do nothing;
