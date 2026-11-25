-- 44_scheduled_report_email_design.sql
-- Redesign weekly/monthly (and other) scheduled admin report emails to match
-- stitch_property_dashboard_minimal_light "vibrant property email report"
-- (desktop + mobile). Email-safe table layout, inline styles, fluid stacking.

create or replace function public.build_scheduled_report_html(p_schedule_id uuid, p_as_of date default null)
returns table(html text, period_start date, period_end date)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_schedule public.report_schedules%rowtype;
  v_company public.companies%rowtype;
  v_start date;
  v_end date := coalesce(p_as_of, current_date);
  v_paid numeric(14,3) := 0;
  v_paid_count integer := 0;
  v_overdue numeric(14,3) := 0;
  v_overdue_count integer := 0;
  v_deposits numeric(14,3) := 0;
  v_expenses numeric(14,3) := 0;
  v_net numeric(14,3) := 0;
  v_payment_rows text := '';
  v_overdue_rows text := '';
  v_deposit_rows text := '';
  v_units_occupied integer := 0;
  v_units_available integer := 0;
  v_units_maintenance integer := 0;
  v_units_total integer := 0;
  v_tenants_active integer := 0;
  v_tenants_blocked integer := 0;
  v_tenants_ended integer := 0;
  v_pct_occupied integer := 0;
  v_pct_available integer := 0;
  v_pct_maintenance integer := 0;
  v_dir text;
  v_title text;
  v_company_name text;
  v_footer text;
  v_body text;
  v_is_ar boolean;
  v_net_hint text;
  v_paid_hint text;
  v_expenses_hint text;
  v_deposits_hint text;
  v_overdue_hint text;
  v_snapshot_title text;
  v_snapshot_body text;
  v_primary text := '#004ac6';
  -- design tokens (Stitch vibrant portfolio monitor)
  c_bg text := '#f8f9ff';
  c_card text := '#ffffff';
  c_on text := '#0b1c30';
  c_muted text := '#434655';
  c_outline text := '#c3c6d7';
  c_blue text := '#2563EB';
  c_red text := '#EF4444';
  c_green text := '#10B981';
  c_teal text := '#0D9488';
  c_amber text := '#F59E0B';
  c_error text := '#ba1a1a';
  c_error_bg text := '#ffdad6';
  c_surface_low text := '#eff4ff';
  c_surface_gray text := '#F8FAFC';
  c_purple text := '#8B5CF6';
  c_orange text := '#F97316';
begin
  if auth.role() = 'authenticated' and not public.has_permission(auth.uid(), 'reports.read') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  select * into v_schedule from public.report_schedules where id = p_schedule_id;
  if not found then raise exception 'Report schedule not found'; end if;
  select * into v_company from public.companies order by created_at limit 1;

  v_start := case v_schedule.frequency
    when 'daily' then v_end
    when 'weekly' then v_end - 6
    when 'monthly' then date_trunc('month', v_end)::date
    when 'yearly' then date_trunc('year', v_end)::date
  end;

  select coalesce(sum(p.amount), 0), count(*)
    into v_paid, v_paid_count
    from public.payments p
   where p.status = 'confirmed'
     and p.payment_date between v_start and v_end;

  select count(*), coalesce(sum(i.balance), 0)
    into v_overdue_count, v_overdue
    from public.invoices i
   where i.state = 'overdue' and i.balance > 0;

  if to_regclass('public.deposits') is not null then
    select coalesce(sum(d.amount), 0)
      into v_deposits
      from public.deposits d
     where d.status = 'confirmed'
       and d.deposit_date between v_start and v_end;
  end if;

  if to_regclass('public.expenses') is not null then
    select coalesce(sum(e.amount), 0)
      into v_expenses
      from public.expenses e
     where e.expense_date between v_start and v_end;
  end if;

  v_net := v_paid - v_expenses;

  -- Unit status counts for progress bars
  select
    coalesce(count(*) filter (where status in ('occupied', 'reserved')), 0),
    coalesce(count(*) filter (where status in ('available', 'vacant')), 0),
    coalesce(count(*) filter (where status = 'under_maintenance'), 0),
    coalesce(count(*), 0)
  into v_units_occupied, v_units_available, v_units_maintenance, v_units_total
  from public.units
  where status is distinct from 'archived';

  if v_units_total > 0 then
    v_pct_occupied := least(100, round((v_units_occupied::numeric / v_units_total) * 100)::integer);
    v_pct_available := least(100, round((v_units_available::numeric / v_units_total) * 100)::integer);
    v_pct_maintenance := least(100, round((v_units_maintenance::numeric / v_units_total) * 100)::integer);
  end if;

  select
    coalesce(count(*) filter (where lifecycle = 'active'), 0),
    coalesce(count(*) filter (where lifecycle = 'blocked'), 0),
    coalesce(count(*) filter (where lifecycle = 'contract_ended'), 0)
  into v_tenants_active, v_tenants_blocked, v_tenants_ended
  from public.tenants;

  -- Detail rows (inline styles for email clients)
  select coalesce(string_agg(
    '<tr>' ||
    '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_on || ';">' ||
      replace(replace(replace(coalesce(t.name, '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') ||
    '</td>' ||
    '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_muted || ';">' ||
      p.payment_date::text ||
    '</td>' ||
    '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;font-weight:700;color:' || c_green || ';">' ||
      to_char(p.amount, 'FM999999990.000') || ' KWD' ||
    '</td>' ||
    '</tr>',
    '' order by p.payment_date desc
  ), '')
  into v_payment_rows
  from (
    select p.*
    from public.payments p
    where p.status = 'confirmed' and p.payment_date between v_start and v_end
    order by p.payment_date desc
    limit 40
  ) p
  left join public.tenants t on t.id = p.tenant_id;

  select coalesce(string_agg(
    '<tr>' ||
    '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_on || ';">' ||
      replace(replace(replace(coalesce(t.name, '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') ||
    '</td>' ||
    '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_muted || ';">' ||
      i.period_month::text || '/' || i.period_year::text ||
    '</td>' ||
    '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;font-weight:700;color:' || c_error || ';text-align:end;">' ||
      to_char(i.balance, 'FM999999990.000') ||
    '</td>' ||
    '</tr>',
    '' order by i.due_date
  ), '')
  into v_overdue_rows
  from (
    select i.*
    from public.invoices i
    where i.state = 'overdue' and i.balance > 0
    order by i.due_date
    limit 40
  ) i
  left join public.tenants t on t.id = i.tenant_id;

  if to_regclass('public.deposits') is not null then
    select coalesce(string_agg(
      '<tr>' ||
      '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_on || ';">' ||
        d.deposit_date::text ||
      '</td>' ||
      '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_on || ';">' ||
        replace(replace(replace(d.bank_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') ||
      '</td>' ||
      '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;font-weight:700;color:' || c_blue || ';">' ||
        to_char(d.amount, 'FM999999990.000') || ' KWD' ||
      '</td>' ||
      '<td style="padding:14px 16px;border-bottom:1px solid ' || c_outline || ';font-size:14px;color:' || c_muted || ';">' ||
        replace(replace(replace(d.code, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') ||
      '</td>' ||
      '</tr>',
      '' order by d.deposit_date desc
    ), '')
    into v_deposit_rows
    from (
      select d.*
      from public.deposits d
      where d.status = 'confirmed' and d.deposit_date between v_start and v_end
      order by d.deposit_date desc
      limit 40
    ) d;
  end if;

  v_is_ar := v_schedule.locale = 'ar';
  v_dir := case when v_is_ar then 'rtl' else 'ltr' end;
  v_title := case when v_is_ar then v_schedule.name_ar else coalesce(v_schedule.name_en, v_schedule.name_ar) end;
  v_company_name := coalesce(
    case when v_is_ar then v_company.name_ar else coalesce(v_company.name_en, v_company.name_ar) end,
    case when v_is_ar then 'دانة المستقبل العقارية' else 'Danat Al Mustaqbal Real Estate' end
  );
  v_footer := coalesce(
    case when v_is_ar then v_company.invoice_footer_ar else v_company.invoice_footer_en end,
    case when v_is_ar
      then 'هذه رسالة تلقائية من نظام إدارة الإيجارات — دانة المستقبل العقارية.'
      else 'Automated message from the rental management system — Danat Al Mustaqbal Real Estate.'
    end
  );
  v_primary := coalesce(nullif(v_company.brand_primary, ''), '#004ac6');
  -- Defense-in-depth: v_primary is the only free-text value placed into an HTML
  -- style="" attribute (unlike the text-content fields, which are entity-escaped).
  -- brand_primary is admin config, but constrain it to a hex colour so no value
  -- can ever break out of the attribute; fall back to the default otherwise.
  if v_primary !~ '^#[0-9A-Fa-f]{3,8}$' then
    v_primary := '#004ac6';
  end if;

  v_paid_hint := case
    when v_is_ar then v_paid_count::text || ' دفعة'
    else v_paid_count::text || case when v_paid_count = 1 then ' payment' else ' payments' end
  end;
  v_expenses_hint := case when v_is_ar then 'مصروفات الفترة' else 'Period outgoings' end;
  v_deposits_hint := case when v_is_ar then 'تأكيدات بنكية' else 'Bank confirmations' end;
  v_net_hint := case
    when v_net >= 0 then case when v_is_ar then 'رصيد إيجابي' else 'Positive balance' end
    else case when v_is_ar then 'رصيد سالب' else 'Negative balance' end
  end;
  v_overdue_hint := case
    when v_is_ar then v_overdue_count::text || ' فاتورة تتطلب متابعة'
    else v_overdue_count::text || ' pending invoices require attention'
  end;
  v_snapshot_title := case when v_is_ar then 'ملخص الفترة' else 'Period snapshot' end;
  v_snapshot_body := case when v_is_ar
    then 'صافي التحصيل ' || to_char(v_net, 'FM999999990.000') || ' د.ك بعد خصم المصروفات، مع ' || v_overdue_count::text || ' فاتورة متأخرة للمتابعة.'
    else 'Net collection ' || to_char(v_net, 'FM999999990.000') || ' KWD after expenses, with ' || v_overdue_count::text || ' overdue invoices to follow up.'
  end;

  v_body :=
'<!DOCTYPE html>
<html lang="' || case when v_is_ar then 'ar' else 'en' end || '" dir="' || v_dir || '">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta http-equiv="X-UA-Compatible" content="IE=edge"/>
<title>' || replace(replace(replace(v_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</title>
<!--[if mso]>
<style type="text/css">
  table, td { font-family: Arial, Helvetica, sans-serif !important; }
</style>
<![endif]-->
<style type="text/css">
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
  img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
  body { margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: ' || c_bg || '; }
  .email-shell { width: 100%; max-width: 600px; }
  .stat-value { font-size: 26px; line-height: 32px; font-weight: 700; }
  .label-caps { font-size: 11px; line-height: 16px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
  .card-shadow { box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
  @media only screen and (max-width: 620px) {
    .email-shell { width: 100% !important; max-width: 100% !important; }
    .px-outer { padding-left: 12px !important; padding-right: 12px !important; }
    .px-inner { padding-left: 14px !important; padding-right: 14px !important; }
    .kpi-cell { display: block !important; width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; padding: 0 0 12px 0 !important; }
    .kpi-spacer { display: none !important; width: 0 !important; height: 0 !important; }
    .stack-col { display: block !important; width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; padding: 0 0 16px 0 !important; }
    .stack-spacer { display: none !important; width: 0 !important; height: 0 !important; }
    .stat-value { font-size: 22px !important; line-height: 28px !important; }
    .display-title { font-size: 22px !important; line-height: 28px !important; }
    .section-title { font-size: 17px !important; }
    .hide-on-mobile { display: none !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:' || c_bg || ';font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:' || c_on || ';">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
    ' || replace(replace(replace(v_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || ' · ' || v_start || ' / ' || v_end || '
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:' || c_bg || ';">
    <tr>
      <td align="center" class="px-outer" style="padding:20px 16px;">
        <table role="presentation" class="email-shell" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

          <!-- Header bar -->
          <tr>
            <td style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:16px 16px 0 0;padding:18px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-size:20px;line-height:28px;font-weight:700;color:' || v_primary || ';letter-spacing:-0.02em;">
                    ' || replace(replace(replace(v_company_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Title + period -->
          <tr>
            <td class="px-inner" style="background-color:' || c_bg || ';padding:28px 8px 8px 8px;text-align:center;">
              <div class="display-title" style="font-size:28px;line-height:34px;font-weight:700;color:' || v_primary || ';letter-spacing:-0.02em;">
                ' || replace(replace(replace(v_company_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '
              </div>
              <div style="font-size:16px;line-height:24px;font-weight:600;color:' || c_muted || ';margin-top:8px;" dir="' || v_dir || '">
                ' || replace(replace(replace(v_title, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '
                <span style="color:#737686;margin:0 8px;">|</span>
                ' || v_start || ' / ' || v_end || '
              </div>
            </td>
          </tr>

          <!-- KPI row 1: Collected + Expenses -->
          <tr>
            <td style="padding:16px 0 0 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="kpi-cell" width="50%" valign="top" style="width:50%;padding:0 6px 12px 0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_blue || ';border-radius:12px;">
                      <tr>
                        <td style="padding:18px 16px;color:#ffffff;">
                          <div class="label-caps" style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;opacity:0.92;">Collected / التحصيل</div>
                          <div class="stat-value" style="font-size:26px;line-height:32px;font-weight:700;margin-top:8px;">' || to_char(v_paid, 'FM999999990.000') || ' KWD</div>
                          <div style="font-size:13px;line-height:18px;opacity:0.85;margin-top:6px;">' || v_paid_hint || '</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td class="kpi-spacer" width="12" style="width:12px;font-size:0;line-height:0;">&nbsp;</td>
                  <td class="kpi-cell" width="50%" valign="top" style="width:50%;padding:0 0 12px 6px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_red || ';border-radius:12px;">
                      <tr>
                        <td style="padding:18px 16px;color:#ffffff;">
                          <div class="label-caps" style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;opacity:0.92;">Expenses / المصروفات</div>
                          <div class="stat-value" style="font-size:26px;line-height:32px;font-weight:700;margin-top:8px;">' || to_char(v_expenses, 'FM999999990.000') || ' KWD</div>
                          <div style="font-size:13px;line-height:18px;opacity:0.85;margin-top:6px;">' || v_expenses_hint || '</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- KPI row 2: Net + Deposits -->
          <tr>
            <td style="padding:0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="kpi-cell" width="50%" valign="top" style="width:50%;padding:0 6px 12px 0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_green || ';border-radius:12px;">
                      <tr>
                        <td style="padding:18px 16px;color:#ffffff;">
                          <div class="label-caps" style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;opacity:0.92;">Net / الصافي</div>
                          <div class="stat-value" style="font-size:26px;line-height:32px;font-weight:700;margin-top:8px;">' || to_char(v_net, 'FM999999990.000') || ' KWD</div>
                          <div style="font-size:13px;line-height:18px;opacity:0.85;margin-top:6px;">' || v_net_hint || '</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td class="kpi-spacer" width="12" style="width:12px;font-size:0;line-height:0;">&nbsp;</td>
                  <td class="kpi-cell" width="50%" valign="top" style="width:50%;padding:0 0 12px 6px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_teal || ';border-radius:12px;">
                      <tr>
                        <td style="padding:18px 16px;color:#ffffff;">
                          <div class="label-caps" style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;opacity:0.92;">Deposits / الإيداعات</div>
                          <div class="stat-value" style="font-size:26px;line-height:32px;font-weight:700;margin-top:8px;">' || to_char(v_deposits, 'FM999999990.000') || ' KWD</div>
                          <div style="font-size:13px;line-height:18px;opacity:0.85;margin-top:6px;">' || v_deposits_hint || '</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Overdue alert banner -->
          <tr>
            <td style="padding:4px 0 20px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_amber || ';border-radius:12px;">
                <tr>
                  <td style="padding:18px 16px;color:#ffffff;">
                    <div class="label-caps" style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;opacity:0.92;">Overdue / المتأخرات</div>
                    <div class="stat-value" style="font-size:26px;line-height:32px;font-weight:700;margin-top:6px;">' || to_char(v_overdue, 'FM999999990.000') || ' KWD</div>
                    <div style="font-size:13px;line-height:18px;opacity:0.9;margin-top:4px;">' || v_overdue_hint || '</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Successful payments -->
          <tr>
            <td style="padding:8px 0 8px 0;">
              <div class="section-title" style="font-size:18px;line-height:26px;font-weight:600;color:' || c_on || ';margin:0 0 12px 0;">
                ✓ Successful Payments / المدفوعات الناجحة
              </div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:12px;overflow:hidden;">
                <tr>
                  <td>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr style="background-color:' || c_surface_low || ';">
                        <th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:' || c_muted || ';text-align:start;border-bottom:1px solid ' || c_outline || ';">Tenant / المستأجر</th>
                        <th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:' || c_muted || ';text-align:start;border-bottom:1px solid ' || c_outline || ';">Date</th>
                        <th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:' || c_muted || ';text-align:start;border-bottom:1px solid ' || c_outline || ';">Amount</th>
                      </tr>
                      ' || coalesce(nullif(v_payment_rows, ''),
                        '<tr><td colspan="3" style="padding:16px;font-size:14px;color:' || c_muted || ';text-align:center;">—</td></tr>') || '
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Overdue table -->
          <tr>
            <td style="padding:20px 0 8px 0;">
              <div class="section-title" style="font-size:18px;line-height:26px;font-weight:600;color:' || c_on || ';margin:0 0 12px 0;">
                ⏱ Delayed Cases / حالات التأخير
              </div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:12px;overflow:hidden;">
                <tr>
                  <td>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr style="background-color:' || c_error_bg || ';">
                        <th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#93000a;text-align:start;border-bottom:1px solid ' || c_outline || ';">Tenant / المستأجر</th>
                        <th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#93000a;text-align:start;border-bottom:1px solid ' || c_outline || ';">Period</th>
                        <th align="right" style="padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:#93000a;text-align:end;border-bottom:1px solid ' || c_outline || ';">Balance</th>
                      </tr>
                      ' || coalesce(nullif(v_overdue_rows, ''),
                        '<tr><td colspan="3" style="padding:16px;font-size:14px;color:' || c_muted || ';text-align:center;">—</td></tr>') || '
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Bank deposits -->
          <tr>
            <td style="padding:20px 0 8px 0;">
              <div class="section-title" style="font-size:18px;line-height:26px;font-weight:600;color:' || c_on || ';margin:0 0 12px 0;">
                🏦 Bank Deposits / الإيداعات البنكية
              </div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:12px;overflow:hidden;">
                <tr>
                  <td>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr style="background-color:' || c_surface_low || ';">
                        <th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:' || c_muted || ';text-align:start;border-bottom:1px solid ' || c_outline || ';">Date</th>
                        <th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:' || c_muted || ';text-align:start;border-bottom:1px solid ' || c_outline || ';">Bank / البنك</th>
                        <th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:' || c_muted || ';text-align:start;border-bottom:1px solid ' || c_outline || ';">Amount</th>
                        <th align="left" style="padding:12px 16px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:' || c_muted || ';text-align:start;border-bottom:1px solid ' || c_outline || ';">Code</th>
                      </tr>
                      ' || coalesce(nullif(v_deposit_rows, ''),
                        '<tr><td colspan="4" style="padding:16px;font-size:14px;color:' || c_muted || ';text-align:center;">—</td></tr>') || '
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Property + Tenant status (side by side → stack on mobile) -->
          <tr>
            <td style="padding:24px 0 8px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="stack-col" width="50%" valign="top" style="width:50%;padding:0 6px 0 0;">
                    <div class="section-title" style="font-size:18px;line-height:26px;font-weight:600;color:' || c_on || ';margin:0 0 12px 0;">
                      Property Status / حالة العقارات
                    </div>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:12px;">
                      <tr>
                        <td style="padding:16px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
                            <tr>
                              <td style="font-size:14px;color:' || c_muted || ';">Occupied / مشغول</td>
                              <td align="right" style="font-size:14px;font-weight:700;color:' || c_on || ';">' || v_units_occupied || '</td>
                            </tr>
                            <tr>
                              <td colspan="2" style="padding-top:6px;">
                                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e5eeff;border-radius:999px;height:8px;">
                                  <tr>
                                    <td width="' || greatest(v_pct_occupied, 1) || '%" style="background-color:' || c_blue || ';height:8px;border-radius:999px;font-size:0;line-height:0;">&nbsp;</td>
                                    <td style="font-size:0;line-height:0;">&nbsp;</td>
                                  </tr>
                                </table>
                              </td>
                            </tr>
                          </table>
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
                            <tr>
                              <td style="font-size:14px;color:' || c_muted || ';">Available / متاح</td>
                              <td align="right" style="font-size:14px;font-weight:700;color:' || c_on || ';">' || v_units_available || '</td>
                            </tr>
                            <tr>
                              <td colspan="2" style="padding-top:6px;">
                                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e5eeff;border-radius:999px;height:8px;">
                                  <tr>
                                    <td width="' || greatest(v_pct_available, 1) || '%" style="background-color:#6cf8bb;height:8px;border-radius:999px;font-size:0;line-height:0;">&nbsp;</td>
                                    <td style="font-size:0;line-height:0;">&nbsp;</td>
                                  </tr>
                                </table>
                              </td>
                            </tr>
                          </table>
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0;">
                            <tr>
                              <td style="font-size:14px;color:' || c_muted || ';">Maintenance / صيانة</td>
                              <td align="right" style="font-size:14px;font-weight:700;color:' || c_on || ';">' || v_units_maintenance || '</td>
                            </tr>
                            <tr>
                              <td colspan="2" style="padding-top:6px;">
                                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#e5eeff;border-radius:999px;height:8px;">
                                  <tr>
                                    <td width="' || greatest(v_pct_maintenance, 1) || '%" style="background-color:' || c_orange || ';height:8px;border-radius:999px;font-size:0;line-height:0;">&nbsp;</td>
                                    <td style="font-size:0;line-height:0;">&nbsp;</td>
                                  </tr>
                                </table>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td class="stack-spacer" width="12" style="width:12px;font-size:0;line-height:0;">&nbsp;</td>
                  <td class="stack-col" width="50%" valign="top" style="width:50%;padding:0 0 0 6px;">
                    <div class="section-title" style="font-size:18px;line-height:26px;font-weight:600;color:' || c_on || ';margin:0 0 12px 0;">
                      Tenant Status / حالة المستأجرين
                    </div>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_card || ';border:1px solid ' || c_outline || ';border-radius:12px;">
                      <tr>
                        <td style="padding:12px;">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:' || c_surface_gray || ';border-radius:8px;margin-bottom:8px;">
                            <tr>
                              <td style="padding:12px 14px;font-size:14px;color:' || c_on || ';">Active / نشط</td>
                              <td align="right" style="padding:12px 14px;font-size:20px;font-weight:700;color:' || v_primary || ';">' || v_tenants_active || '</td>
                            </tr>
                          </table>
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:' || c_surface_gray || ';border-radius:8px;margin-bottom:8px;">
                            <tr>
                              <td style="padding:12px 14px;font-size:14px;color:' || c_on || ';">Blocked / محظور</td>
                              <td align="right" style="padding:12px 14px;font-size:20px;font-weight:700;color:' || c_error || ';">' || v_tenants_blocked || '</td>
                            </tr>
                          </table>
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:' || c_surface_gray || ';border-radius:8px;">
                            <tr>
                              <td style="padding:12px 14px;font-size:14px;color:' || c_on || ';">Contract Ended</td>
                              <td align="right" style="padding:12px 14px;font-size:20px;font-weight:700;color:' || c_muted || ';">' || v_tenants_ended || '</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Accent insight strip (matches design energy; pure static copy) -->
          <tr>
            <td style="padding:20px 0 8px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card-shadow" style="background-color:' || c_purple || ';border-radius:12px;">
                <tr>
                  <td style="padding:18px 16px;color:#ffffff;">
                    <div style="font-size:16px;font-weight:600;line-height:24px;">
                      ' || v_snapshot_title || '
                    </div>
                    <div style="font-size:13px;line-height:20px;opacity:0.9;margin-top:6px;">
                      ' || replace(replace(replace(v_snapshot_body, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:32px 8px 8px 8px;text-align:center;border-top:1px solid ' || c_outline || ';margin-top:16px;">
              <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:' || c_muted || ';">
                ' || replace(replace(replace(v_company_name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '
              </div>
              <div style="font-size:12px;line-height:18px;color:#737686;margin-top:10px;">
                ' || replace(replace(replace(v_footer, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>';

  html := v_body;
  period_start := v_start;
  period_end := v_end;
  return next;
end;
$$;

revoke all on function public.build_scheduled_report_html(uuid, date) from public;
grant execute on function public.build_scheduled_report_html(uuid, date) to authenticated, service_role;

comment on function public.build_scheduled_report_html(uuid, date) is
  'Builds bilingual weekly/monthly admin report HTML (Stitch vibrant email design, responsive table layout).';
