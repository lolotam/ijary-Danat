-- 300_functions_reports_html.sql
-- T037: function audit — report HTML builders.
-- Split from 283_functions_notifications_reports.sql (T052l) to keep each migration under 600 lines;
-- bodies are unchanged. Every SECURITY DEFINER function scopes by
-- `public.current_company_id()` or runs as SECURITY INVOKER. Idempotent.

/** يبني تقرير العقود المتأخرة بصيغة HTML ضمن نطاق الشركة الحالية فقط. */
create or replace function public.build_overdue_contracts_report_html(p_schedule_id uuid, p_as_of date default null)
returns table(html text, period_start date, period_end date)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
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
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'reports.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select * into v_schedule from public.report_schedules where id = p_schedule_id and company_id = v_company_id;
  if not found then raise exception 'Report schedule not found'; end if;
  v_is_ar := v_schedule.locale = 'ar';
  v_dir := case when v_is_ar then 'rtl' else 'ltr' end;
  select * into v_company from public.companies where id = v_company_id;
  v_company_name := coalesce(
    case when v_is_ar then v_company.name_ar else coalesce(v_company.name_en, v_company.name_ar) end,
    case when v_is_ar then 'دانة المستقبل العقارية' else 'Danat Al Mustaqbal Real Estate' end);
  v_title := coalesce(case when v_is_ar then v_schedule.name_ar else v_schedule.name_en end, v_schedule.name_ar);

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
        join public.contracts c on c.company_id = v_company_id and c.id = i.contract_id
       where i.company_id = v_company_id and i.state = 'overdue' and i.balance > 0 and c.archived_at is null
       group by i.contract_id
    )
    select c.code, public.tenant_display_name(t, true) as party, pc.months, pc.first_ym, pc.last_ym, pc.total
      from per_contract pc
      join public.contracts c on c.company_id = v_company_id and c.id = pc.contract_id
      join public.tenants t on t.company_id = v_company_id and t.id = c.tenant_id
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
      || to_char(r.total, 'FM999,999,990.000') || ' KWD</td></tr>';
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
         then '<p style="color:' || c_muted || ';">' || case when v_is_ar then 'لا توجد عقود متأخرة' else 'No overdue contracts' end || '</p>'
         else '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;"><thead><tr style="background:#eff4ff;text-align:start;">'
           || case when v_is_ar
                then '<th style="padding:8px;">الاسم التجاري</th><th style="padding:8px;">رقم العقد</th><th style="padding:8px;">عدد الأشهر المتأخرة</th><th style="padding:8px;">من</th><th style="padding:8px;">إلى</th><th style="padding:8px;">إجمالي المتأخر</th>'
                else '<th style="padding:8px;">Commercial name</th><th style="padding:8px;">Contract</th><th style="padding:8px;">Overdue months</th><th style="padding:8px;">From</th><th style="padding:8px;">To</th><th style="padding:8px;">Total overdue</th>'
              end
           || '</tr></thead><tbody>' || v_rows || '</tbody><tfoot><tr style="font-weight:700;background:#fff5f5;"><td style="padding:8px;" colspan="5">'
           || case when v_is_ar then 'الإجمالي (' || v_count || ' عقد)' else 'Total (' || v_count || ' contracts)' end
           || '</td><td style="padding:8px;color:' || c_red || ';" dir="ltr">' || to_char(v_total, 'FM999,999,990.000') || ' KWD</td></tr></tfoot></table>'
       end
    || '</div></body></html>';
  period_start := v_start;
  period_end := v_end;
  return next;
end;
$$;

/** يبني التقرير الدوري المجدول بصيغة HTML من بيانات الشركة الحالية فقط. */
create or replace function public.build_scheduled_report_html(p_schedule_id uuid, p_as_of date default null)
returns table(html text, period_start date, period_end date)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_schedule public.report_schedules%rowtype;
  v_company public.companies%rowtype;
  v_start date;
  v_end date := coalesce(p_as_of, current_date);
  v_paid numeric(14,3) := 0; v_paid_count integer := 0;
  v_overdue numeric(14,3) := 0; v_overdue_count integer := 0;
  v_expenses numeric(14,3) := 0; v_net numeric(14,3) := 0;
  v_payment_rows text := ''; v_overdue_rows text := '';
  v_units_occupied integer := 0; v_units_available integer := 0; v_units_maintenance integer := 0; v_units_total integer := 0;
  v_tenants_active integer := 0; v_tenants_blocked integer := 0; v_tenants_ended integer := 0;
  v_pct_occupied integer := 0; v_pct_available integer := 0; v_pct_maintenance integer := 0;
  v_dir text; v_title text; v_company_name text; v_footer text; v_body text; v_is_ar boolean;
  v_net_hint text; v_paid_hint text; v_expenses_hint text; v_overdue_hint text; v_snapshot_title text; v_snapshot_body text;
  v_primary text := '#004ac6';
  c_bg text := '#f8f9ff'; c_card text := '#ffffff'; c_on text := '#0b1c30'; c_muted text := '#434655';
  c_outline text := '#c3c6d7'; c_blue text := '#2563EB'; c_red text := '#EF4444'; c_green text := '#10B981';
  c_teal text := '#0D9488'; c_amber text := '#F59E0B'; c_error text := '#ba1a1a'; c_error_bg text := '#ffdad6';
  c_surface_low text := '#eff4ff'; c_surface_gray text := '#F8FAFC'; c_purple text := '#8B5CF6'; c_orange text := '#F97316';
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;
  if auth.role() = 'authenticated' then
    if not public.has_permission(auth.uid(), 'reports.read') then
      raise exception 'Permission denied' using errcode = '42501';
    end if;
  elsif auth.role() not in ('company_service', 'service_role') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select * into v_schedule from public.report_schedules where id = p_schedule_id and company_id = v_company_id;
  if not found then raise exception 'Report schedule not found'; end if;
  v_is_ar := v_schedule.locale = 'ar';
  select * into v_company from public.companies where id = v_company_id;

  v_start := case v_schedule.frequency
    when 'daily' then v_end when 'weekly' then v_end - 6
    when 'monthly' then date_trunc('month', v_end)::date when 'yearly' then date_trunc('year', v_end)::date
  end;

  select coalesce(sum(p.amount), 0), count(*) into v_paid, v_paid_count
    from public.payments p
   where p.company_id = v_company_id and p.status = 'confirmed' and p.payment_date between v_start and v_end;

  select count(*), coalesce(sum(i.balance), 0) into v_overdue_count, v_overdue
    from public.invoices i
   where i.company_id = v_company_id and i.state = 'overdue' and i.balance > 0;

  if to_regclass('public.expenses') is not null then
    select coalesce(sum(e.amount), 0) into v_expenses
      from public.expenses e
     where e.company_id = v_company_id and e.expense_date between v_start and v_end;
  end if;
  v_net := v_paid - v_expenses;

  select coalesce(count(*) filter (where status in ('occupied', 'reserved')), 0),
         coalesce(count(*) filter (where status in ('available', 'vacant')), 0),
         coalesce(count(*) filter (where status = 'under_maintenance'), 0),
         coalesce(count(*), 0)
    into v_units_occupied, v_units_available, v_units_maintenance, v_units_total
    from public.units
   where company_id = v_company_id and status is distinct from 'archived';

  if v_units_total > 0 then
    v_pct_occupied := least(100, round((v_units_occupied::numeric / v_units_total) * 100)::integer);
    v_pct_available := least(100, round((v_units_available::numeric / v_units_total) * 100)::integer);
    v_pct_maintenance := least(100, round((v_units_maintenance::numeric / v_units_total) * 100)::integer);
  end if;

  select coalesce(count(*) filter (where lifecycle = 'active'), 0),
         coalesce(count(*) filter (where lifecycle = 'blocked'), 0),
         coalesce(count(*) filter (where lifecycle = 'contract_ended'), 0)
    into v_tenants_active, v_tenants_blocked, v_tenants_ended
    from public.tenants
   where company_id = v_company_id;

  select coalesce(string_agg(
    '<tr><td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_on || ';">'
    || replace(replace(replace(coalesce(public.tenant_display_name(t, v_is_ar), '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</td>'
    || '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_muted || ';">' || p.payment_date::text || '</td>'
    || '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;font-weight:700;color:' || c_green || ';">'
    || to_char(p.amount, 'FM999,999,990.000') || ' KWD</td></tr>', '' order by p.payment_date desc), '')
    into v_payment_rows
    from (select p.* from public.payments p
           where p.company_id = v_company_id and p.status = 'confirmed' and p.payment_date between v_start and v_end
           order by p.payment_date desc limit 40) p
    left join public.tenants t on t.company_id = v_company_id and t.id = p.tenant_id;

  select coalesce(string_agg(
    '<tr><td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_on || ';">'
    || replace(replace(replace(coalesce(public.tenant_display_name(t, v_is_ar), '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</td>'
    || '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_muted || ';">'
    || i.period_month::text || '/' || i.period_year::text || '</td>'
    || '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;font-weight:700;color:' || c_error || ';text-align:end;">'
    || to_char(i.balance, 'FM999,999,990.000') || '</td></tr>', '' order by i.due_date), '')
    into v_overdue_rows
    from (select i.* from public.invoices i
           where i.company_id = v_company_id and i.state = 'overdue' and i.balance > 0
           order by i.due_date limit 40) i
    left join public.tenants t on t.company_id = v_company_id and t.id = i.tenant_id;

  v_dir := case when v_is_ar then 'rtl' else 'ltr' end;
  v_title := case when v_is_ar then v_schedule.name_ar else coalesce(v_schedule.name_en, v_schedule.name_ar) end;
  v_company_name := coalesce(
    case when v_is_ar then v_company.name_ar else coalesce(v_company.name_en, v_company.name_ar) end,
    case when v_is_ar then 'دانة المستقبل العقارية' else 'Danat Al Mustaqbal Real Estate' end);
  v_footer := coalesce(
    case when v_is_ar then v_company.invoice_footer_ar else v_company.invoice_footer_en end,
    case when v_is_ar then 'هذه رسالة تلقائية من نظام إدارة الإيجارات — دانة المستقبل العقارية.'
         else 'Automated message from the rental management system — Danat Al Mustaqbal Real Estate.' end);
  v_primary := coalesce(nullif(v_company.brand_primary, ''), '#004ac6');
  if v_primary !~ '^#[0-9A-Fa-f]{3,8}$' then v_primary := '#004ac6'; end if;

  v_paid_hint := case when v_is_ar then v_paid_count::text || ' دفعة'
                      else v_paid_count::text || case when v_paid_count = 1 then ' payment' else ' payments' end end;
  v_expenses_hint := case when v_is_ar then 'مصروفات الفترة' else 'Period outgoings' end;
  v_net_hint := case when v_net >= 0 then case when v_is_ar then 'رصيد إيجابي' else 'Positive balance' end
                     else case when v_is_ar then 'رصيد سالب' else 'Negative balance' end end;
  v_overdue_hint := case when v_is_ar then v_overdue_count::text || ' فاتورة تتطلب متابعة'
                         else v_overdue_count::text || ' pending invoices require attention' end;
  v_snapshot_title := case when v_is_ar then 'ملخص الفترة' else 'Period snapshot' end;
  v_snapshot_body := case when v_is_ar
    then 'صافي التحصيل ' || to_char(v_net, 'FM999999990.000') || ' د.ك بعد خصم المصروفات، مع ' || v_overdue_count::text || ' فاتورة متأخرة للمتابعة.'
    else 'Net collection ' || to_char(v_net, 'FM999999990.000') || ' KWD after expenses, with ' || v_overdue_count::text || ' overdue invoices to follow up.' end;

  v_body := '<!DOCTYPE html><html lang="' || case when v_is_ar then 'ar' else 'en' end || '" dir="' || v_dir || '"><head><meta charset="utf-8"/>'
    || '<meta name="viewport" content="width=device-width, initial-scale=1.0"/><meta http-equiv="X-UA-Compatible" content="IE=edge"/>'
    || '<title>' || replace(replace(replace(v_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</title>'
    || '<style type="text/css">body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;border-collapse:collapse;}body{margin:0!important;padding:0!important;width:100%!important;background-color:' || c_bg || ';}.email-shell{width:100%;max-width:600px;}.stat-value{font-size:26px;line-height:32px;font-weight:700;}.label-caps{font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;}.card-shadow{box-shadow:0 4px 12px rgba(0,0,0,0.05);}@media only screen and (max-width:620px){.email-shell,.kpi-cell,.stack-col{width:100%!important;max-width:100%!important;display:block!important;box-sizing:border-box!important;}.kpi-spacer,.stack-spacer{display:none!important;}}</style>'
    || '</head><body style="margin:0;padding:0;background-color:' || c_bg || ';font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:' || c_on || ';">'
    || '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">' || replace(replace(replace(v_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || ' · ' || v_start || ' / ' || v_end || '</div>'
    || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:' || c_bg || ';"><tr><td align="center" class="px-outer" style="padding:20px 16px;">'
    || '<table role="presentation" class="email-shell" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">'
    || '<tr><td style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:16px 16px 0 0;padding:18px 24px;"><div style="font-size:20px;line-height:28px;font-weight:700;color:' || v_primary || ';">' || replace(replace(replace(v_company_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</div></td></tr>'
    || '<tr><td class="px-inner" style="background-color:' || c_bg || ';padding:28px 8px 8px 8px;text-align:center;"><div class="display-title" style="font-size:28px;line-height:34px;font-weight:700;color:' || v_primary || ';">' || replace(replace(replace(v_company_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</div>'
    || '<div style="font-size:16px;line-height:24px;font-weight:600;color:' || c_muted || ';margin-top:8px;" dir="' || v_dir || '">' || replace(replace(replace(v_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || ' <span style="color:#737686;margin:0 8px;">|</span> ' || v_start || ' / ' || v_end || '</div></td></tr>'
    || '<tr><td style="padding:16px 0 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    || '<td class="kpi-cell" width="50%" valign="top" style="width:50%;padding:0 6px 12px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_blue || ';border-radius:12px;"><tr><td style="padding:18px 16px;color:#ffffff;"><div class="label-caps">Collected / التحصيل</div><div class="stat-value" style="margin-top:8px;">' || to_char(v_paid, 'FM999999990.000') || ' KWD</div><div style="font-size:13px;opacity:0.85;margin-top:6px;">' || v_paid_hint || '</div></td></tr></table></td>'
    || '<td class="kpi-spacer" width="12" style="width:12px;">&nbsp;</td>'
    || '<td class="kpi-cell" width="50%" valign="top" style="width:50%;padding:0 0 12px 6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_red || ';border-radius:12px;"><tr><td style="padding:18px 16px;color:#ffffff;"><div class="label-caps">Expenses / المصروفات</div><div class="stat-value" style="margin-top:8px;">' || to_char(v_expenses, 'FM999999990.000') || ' KWD</div><div style="font-size:13px;opacity:0.85;margin-top:6px;">' || v_expenses_hint || '</div></td></tr></table></td>'
    || '</tr></table></td></tr>'
    || '<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    || '<td class="kpi-cell" width="50%" valign="top" style="width:50%;padding:0 6px 12px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_green || ';border-radius:12px;"><tr><td style="padding:18px 16px;color:#ffffff;"><div class="label-caps">Net / الصافي</div><div class="stat-value" style="margin-top:8px;">' || to_char(v_net, 'FM999999990.000') || ' KWD</div><div style="font-size:13px;opacity:0.85;margin-top:6px;">' || v_net_hint || '</div></td></tr></table></td>'
    || '<td class="kpi-spacer" width="12" style="width:12px;">&nbsp;</td>'
    || '<td class="kpi-cell" width="50%" valign="top" style="width:50%;padding:0 0 12px 6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_teal || ';border-radius:12px;"><tr><td style="padding:18px 16px;color:#ffffff;"><div class="label-caps">' || case when v_is_ar then 'الإيداعات' else 'Deposits' end || '</div><div class="stat-value" style="margin-top:8px;">—</div><div style="font-size:13px;opacity:0.85;margin-top:6px;">' || case when v_is_ar then 'سجل فقط — وحدة الإيداعات' else 'Ledger only — Deposits module' end || '</div></td></tr></table></td>'
    || '</tr></table></td></tr>'
    || '<tr><td style="padding:4px 0 20px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_amber || ';border-radius:12px;"><tr><td style="padding:18px 16px;color:#ffffff;"><div class="label-caps">Overdue / المتأخرات</div><div class="stat-value" style="margin-top:6px;">' || to_char(v_overdue, 'FM999999990.000') || ' KWD</div><div style="font-size:13px;opacity:0.9;margin-top:4px;">' || v_overdue_hint || '</div></td></tr></table></td></tr>'
    || '<tr><td style="padding:8px 0;"><div class="section-title" style="font-size:18px;font-weight:600;color:' || c_on || ';margin:0 0 12px 0;">✓ Successful Payments / المدفوعات الناجحة</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:12px;overflow:hidden;"><tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr style="background-color:' || c_surface_low || ';"><th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;color:' || c_muted || ';text-align:start;border-bottom:1px solid ' || c_outline || ';">Tenant / المستأجر</th><th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;color:' || c_muted || ';text-align:start;border-bottom:1px solid ' || c_outline || ';">Date</th><th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;color:' || c_muted || ';text-align:start;border-bottom:1px solid ' || c_outline || ';">Amount</th></tr>'
    || coalesce(nullif(v_payment_rows, ''), '<tr><td colspan="3" style="padding:16px;font-size:14px;color:' || c_muted || ';text-align:center;">—</td></tr>') || '</table></td></tr></table></td></tr>'
    || '<tr><td style="padding:20px 0 8px 0;"><div class="section-title" style="font-size:18px;font-weight:600;color:' || c_on || ';margin:0 0 12px 0;">⏱ Delayed Cases / حالات التأخير</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:12px;overflow:hidden;"><tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr style="background-color:' || c_error_bg || ';"><th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;color:#93000a;text-align:start;border-bottom:1px solid ' || c_outline || ';">Tenant / المستأجر</th><th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;color:#93000a;text-align:start;border-bottom:1px solid ' || c_outline || ';">Period</th><th align="right" style="padding:12px 16px;font-size:11px;font-weight:700;color:#93000a;text-align:end;border-bottom:1px solid ' || c_outline || ';">Balance</th></tr>'
    || coalesce(nullif(v_overdue_rows, ''), '<tr><td colspan="3" style="padding:16px;font-size:14px;color:' || c_muted || ';text-align:center;">—</td></tr>') || '</table></td></tr></table></td></tr>'
    || '<tr><td style="padding:24px 0 8px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>'
    || '<td class="stack-col" width="50%" valign="top" style="width:50%;padding:0 6px 0 0;"><div class="section-title" style="font-size:18px;font-weight:600;color:' || c_on || ';margin:0 0 12px 0;">Property Status / حالة العقارات</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:12px;"><tr><td style="padding:16px;">'
    || '<table width="100%" style="margin-bottom:14px;"><tr><td style="font-size:14px;color:' || c_muted || ';">Occupied / مشغول</td><td align="right" style="font-size:14px;font-weight:700;">' || v_units_occupied || '</td></tr><tr><td colspan="2" style="padding-top:6px;"><table width="100%" style="background-color:#e5eeff;border-radius:999px;height:8px;"><tr><td width="' || greatest(v_pct_occupied, 1) || '%" style="background-color:' || c_blue || ';height:8px;border-radius:999px;">&nbsp;</td><td>&nbsp;</td></tr></table></td></tr></table>'
    || '<table width="100%" style="margin-bottom:14px;"><tr><td style="font-size:14px;color:' || c_muted || ';">Available / متاح</td><td align="right" style="font-size:14px;font-weight:700;">' || v_units_available || '</td></tr><tr><td colspan="2" style="padding-top:6px;"><table width="100%" style="background-color:#e5eeff;border-radius:999px;height:8px;"><tr><td width="' || greatest(v_pct_available, 1) || '%" style="background-color:#6cf8bb;height:8px;border-radius:999px;">&nbsp;</td><td>&nbsp;</td></tr></table></td></tr></table>'
    || '<table width="100%"><tr><td style="font-size:14px;color:' || c_muted || ';">Maintenance / صيانة</td><td align="right" style="font-size:14px;font-weight:700;">' || v_units_maintenance || '</td></tr><tr><td colspan="2" style="padding-top:6px;"><table width="100%" style="background-color:#e5eeff;border-radius:999px;height:8px;"><tr><td width="' || greatest(v_pct_maintenance, 1) || '%" style="background-color:' || c_orange || ';height:8px;border-radius:999px;">&nbsp;</td><td>&nbsp;</td></tr></table></td></tr></table>'
    || '</td></tr></table></td><td class="stack-spacer" width="12" style="width:12px;">&nbsp;</td>'
    || '<td class="stack-col" width="50%" valign="top" style="width:50%;padding:0 0 0 6px;"><div class="section-title" style="font-size:18px;font-weight:600;color:' || c_on || ';margin:0 0 12px 0;">Tenant Status / حالة المستأجرين</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:12px;"><tr><td style="padding:12px;">'
    || '<table width="100%" style="background-color:' || c_surface_gray || ';border-radius:8px;margin-bottom:8px;"><tr><td style="padding:12px 14px;font-size:14px;">Active / نشط</td><td align="right" style="padding:12px 14px;font-size:20px;font-weight:700;color:' || v_primary || ';">' || v_tenants_active || '</td></tr></table>'
    || '<table width="100%" style="background-color:' || c_surface_gray || ';border-radius:8px;margin-bottom:8px;"><tr><td style="padding:12px 14px;font-size:14px;">Blocked / محظور</td><td align="right" style="padding:12px 14px;font-size:20px;font-weight:700;color:' || c_error || ';">' || v_tenants_blocked || '</td></tr></table>'
    || '<table width="100%" style="background-color:' || c_surface_gray || ';border-radius:8px;"><tr><td style="padding:12px 14px;font-size:14px;">Contract Ended</td><td align="right" style="padding:12px 14px;font-size:20px;font-weight:700;color:' || c_muted || ';">' || v_tenants_ended || '</td></tr></table>'
    || '</td></tr></table></td></tr></table></td></tr>'
    || '<tr><td style="padding:20px 0 8px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_purple || ';border-radius:12px;"><tr><td style="padding:18px 16px;color:#ffffff;"><div style="font-size:16px;font-weight:600;">' || v_snapshot_title || '</div><div style="font-size:13px;opacity:0.9;margin-top:6px;">' || replace(replace(replace(v_snapshot_body, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</div></td></tr></table></td></tr>'
    || '<tr><td style="padding:32px 8px 8px 8px;text-align:center;border-top:1px solid ' || c_outline || ';margin-top:16px;"><div style="font-size:11px;font-weight:700;color:' || c_muted || ';">' || replace(replace(replace(v_company_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</div><div style="font-size:12px;color:#737686;margin-top:10px;">' || replace(replace(replace(v_footer, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</div></td></tr>'
    || '</table></td></tr></table></body></html>';

  html := v_body;
  period_start := v_start;
  period_end := v_end;
  return next;
end;
$$;


revoke all on function public.build_overdue_contracts_report_html(uuid, date) from public, anon;
revoke all on function public.build_scheduled_report_html(uuid, date) from public, anon;
grant execute on function public.build_overdue_contracts_report_html(uuid, date) to authenticated, company_service, service_role;
grant execute on function public.build_scheduled_report_html(uuid, date) to authenticated, company_service, service_role;
