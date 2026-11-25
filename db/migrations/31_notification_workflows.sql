-- 31_notification_workflows.sql
-- Schema-only: enum extensions, notification audit columns, provider mutual
-- exclusivity trigger, contract-expiry RPC (incl. 7-day), richer report HTML.
-- Seeds that use the new enum values live in 32_notification_workflow_seeds.sql
-- (Postgres requires ALTER TYPE ... ADD VALUE to commit before INSERT uses it).
-- Idempotent.

------------------------------------------------------------
-- Enum extensions
-- Note: new enum labels cannot be *used* in DML/casts until this transaction
-- commits. Seeds that INSERT using these labels are in migration 32.
------------------------------------------------------------

-- Prefer IF NOT EXISTS (PG 15+). Fall back without it for older servers.
do $$ begin
  alter type public.notification_providers add value if not exists 'twilio';
exception
  when duplicate_object then null;
  when others then
    begin
      alter type public.notification_providers add value 'twilio';
    exception when duplicate_object then null;
    end;
end $$;

do $$ begin
  alter type public.notification_types add value if not exists 'deposit_confirmation';
exception
  when duplicate_object then null;
  when others then
    begin
      alter type public.notification_types add value 'deposit_confirmation';
    exception when duplicate_object then null;
    end;
end $$;

do $$ begin
  alter type public.notification_types add value if not exists 'user_credentials';
exception
  when duplicate_object then null;
  when others then
    begin
      alter type public.notification_types add value 'user_credentials';
    exception when duplicate_object then null;
    end;
end $$;

do $$ begin
  alter type public.notification_types add value if not exists 'payment_admin_alert';
exception
  when duplicate_object then null;
  when others then
    begin
      alter type public.notification_types add value 'payment_admin_alert';
    exception when duplicate_object then null;
    end;
end $$;

do $$ begin
  create type public.notification_audience as enum ('tenant', 'admin', 'both', 'system');
exception when duplicate_object then null; end $$;

------------------------------------------------------------
-- notifications audit columns
------------------------------------------------------------

alter table public.notifications
  add column if not exists audience public.notification_audience not null default 'tenant';

alter table public.notifications
  add column if not exists recipient_address text;

alter table public.notifications
  add column if not exists sender_address text;

create index if not exists notifications_audience_idx on public.notifications(audience);
create index if not exists notifications_recipient_address_idx on public.notifications(recipient_address);

------------------------------------------------------------
-- Mutual exclusivity: one email provider, one WhatsApp provider
------------------------------------------------------------

create or replace function public.tg_provider_mutual_exclusivity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Compare as text so this function can be created in the same transaction as
  -- ALTER TYPE ... ADD VALUE 'twilio' (new enum labels are unusable until commit).
  if new.is_enabled is true then
    if new.provider::text in ('smtp', 'resend') then
      update public.provider_configs
         set is_enabled = false, updated_at = now()
       where provider::text in ('smtp', 'resend')
         and provider is distinct from new.provider
         and is_enabled is true;
    elsif new.provider::text in ('whatsapp_cloud_api', 'twilio') then
      update public.provider_configs
         set is_enabled = false, updated_at = now()
       where provider::text in ('whatsapp_cloud_api', 'twilio')
         and provider is distinct from new.provider
         and is_enabled is true;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists provider_mutual_exclusivity on public.provider_configs;
create trigger provider_mutual_exclusivity
  before insert or update of is_enabled on public.provider_configs
  for each row
  execute function public.tg_provider_mutual_exclusivity();

------------------------------------------------------------
-- Contract expiry: 4/3/2/1 months + 7 days
-- Must DROP first: return row type (OUT columns) changed vs phase-5 version.
------------------------------------------------------------

drop function if exists public.identify_contract_expiry_reminders(date);

create or replace function public.identify_contract_expiry_reminders(p_as_of date default null)
returns table(
  contract_id uuid,
  tenant_id uuid,
  months_until int,
  days_until int,
  milestone text,
  template_type text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_as_of date := coalesce(p_as_of, current_date);
begin
  if auth.role() = 'authenticated' and not public.has_permission(auth.uid(), 'notifications.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  return query
  select
    c.id,
    c.tenant_id,
    threshold.months_until,
    null::int as days_until,
    (threshold.months_until::text || 'm') as milestone,
    'contract_expiry'::text
  from public.contracts c
  join public.tenants t on t.id = c.tenant_id and t.reminders_enabled
  cross join (values (4), (3), (2), (1)) as threshold(months_until)
  where c.state = 'active'
    and c.end_date = (v_as_of + make_interval(months => threshold.months_until))::date
    and not exists (
      select 1 from public.notifications n
      where n.contract_id = c.id
        and n.type = 'contract_expiry'
        and n.state in ('sent', 'queued')
        and coalesce(n.payload->>'milestone', n.payload->>'months_until' || 'm')
            = threshold.months_until::text || 'm'
    )

  union all

  select
    c.id,
    c.tenant_id,
    null::int as months_until,
    7 as days_until,
    '7d'::text as milestone,
    'contract_expiry'::text
  from public.contracts c
  join public.tenants t on t.id = c.tenant_id and t.reminders_enabled
  where c.state = 'active'
    and c.end_date = (v_as_of + 7)
    and not exists (
      select 1 from public.notifications n
      where n.contract_id = c.id
        and n.type = 'contract_expiry'
        and n.state in ('sent', 'queued')
        and n.payload->>'milestone' = '7d'
    )

  order by 5 desc, 1;
end;
$$;

revoke all on function public.identify_contract_expiry_reminders(date) from public;
grant execute on function public.identify_contract_expiry_reminders(date) to authenticated, service_role;

------------------------------------------------------------
-- Richer scheduled report HTML
------------------------------------------------------------

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
  v_units text := '';
  v_tenants text := '';
  v_dir text;
  v_title text;
  v_body text;
  v_is_ar boolean;
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

  select coalesce(string_agg(
    '<tr><td>' || coalesce(t.name, '—') || '</td><td>' || p.payment_date::text ||
    '</td><td>' || p.amount::text || ' KWD</td><td>' || coalesce(p.reference, p.code) || '</td></tr>',
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
    '<tr><td>' || coalesce(t.name, '—') || '</td><td>' || i.code || '</td><td>' ||
    i.period_month::text || '/' || i.period_year::text || '</td><td>' ||
    i.balance::text || ' KWD</td><td>' || i.due_date::text || '</td></tr>',
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
      '<tr><td>' || d.deposit_date::text || '</td><td>' || d.bank_name ||
      '</td><td>' || d.amount::text || ' KWD</td><td>' || d.code || '</td></tr>',
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

  select coalesce(string_agg('<tr><td>' || status || '</td><td>' || total || '</td></tr>', ''), '')
    into v_units
    from (select status::text, count(*)::text total from public.units group by status) s;

  select coalesce(string_agg('<tr><td>' || lifecycle || '</td><td>' || total || '</td></tr>', ''), '')
    into v_tenants
    from (select lifecycle::text, count(*)::text total from public.tenants group by lifecycle) s;

  v_is_ar := v_schedule.locale = 'ar';
  v_dir := case when v_is_ar then 'rtl' else 'ltr' end;
  v_title := case when v_is_ar then v_schedule.name_ar else coalesce(v_schedule.name_en, v_schedule.name_ar) end;

  v_body := '<!doctype html><html dir="' || v_dir || '"><head><meta charset="utf-8"><style>' ||
    'body{font-family:Arial,sans-serif;color:#17212b;background:#f7f4ed;padding:24px}' ||
    'main{max-width:820px;margin:auto;background:#fff;padding:32px;border-top:6px solid ' ||
    coalesce(v_company.brand_primary, '#0f766e') || '}' ||
    'h1{margin:0 0 6px}h2{margin:28px 0 10px;font-size:18px}p{color:#64748b}' ||
    'table{width:100%;border-collapse:collapse;margin:14px 0}' ||
    'th,td{border:1px solid #dbe1e8;padding:9px;text-align:start;font-size:13px}' ||
    'th{background:#f1f5f9}.value{font-size:20px;font-weight:700}' ||
    '.kpi{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:18px 0}' ||
    '.kpi div{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px}' ||
    '</style></head><body><main>' ||
    '<h1>' || v_title || '</h1><p>' ||
    coalesce(case when v_is_ar then v_company.name_ar else v_company.name_en end, '') ||
    ' · ' || v_start || ' — ' || v_end || '</p>' ||
    '<div class="kpi">' ||
    '<div><div>Collected / التحصيل</div><div class="value">' || v_paid || ' KWD</div><div>' || v_paid_count || ' payments</div></div>' ||
    '<div><div>Expenses / المصروفات</div><div class="value">' || v_expenses || ' KWD</div></div>' ||
    '<div><div>Net / الصافي</div><div class="value">' || v_net || ' KWD</div></div>' ||
    '<div><div>Bank deposits / الإيداعات</div><div class="value">' || v_deposits || ' KWD</div></div>' ||
    '<div><div>Overdue / المتأخرات</div><div class="value">' || v_overdue || ' KWD</div><div>' || v_overdue_count || ' invoices</div></div>' ||
    '</div>' ||
    '<h2>Successful payments / المدفوعات الناجحة</h2>' ||
    '<table><tr><th>Tenant</th><th>Date</th><th>Amount</th><th>Ref</th></tr>' ||
    coalesce(nullif(v_payment_rows, ''), '<tr><td colspan="4">—</td></tr>') || '</table>' ||
    '<h2>Delayed / overdue cases / حالات التأخير</h2>' ||
    '<table><tr><th>Tenant</th><th>Invoice</th><th>Period</th><th>Balance</th><th>Due</th></tr>' ||
    coalesce(nullif(v_overdue_rows, ''), '<tr><td colspan="5">—</td></tr>') || '</table>' ||
    '<h2>Bank deposits / الإيداعات البنكية</h2>' ||
    '<table><tr><th>Date</th><th>Bank</th><th>Amount</th><th>Code</th></tr>' ||
    coalesce(nullif(v_deposit_rows, ''), '<tr><td colspan="4">—</td></tr>') || '</table>' ||
    '<h2>Property status / حالة العقارات</h2><table><tr><th>Status</th><th>Count</th></tr>' ||
    coalesce(nullif(v_units, ''), '<tr><td colspan="2">—</td></tr>') || '</table>' ||
    '<h2>Tenant status / حالة المستأجرين</h2><table><tr><th>Status</th><th>Count</th></tr>' ||
    coalesce(nullif(v_tenants, ''), '<tr><td colspan="2">—</td></tr>') || '</table>' ||
    '<footer style="margin-top:24px;color:#64748b;font-size:12px">' ||
    coalesce(case when v_is_ar then v_company.invoice_footer_ar else v_company.invoice_footer_en end, '') ||
    '</footer></main></body></html>';

  html := v_body;
  period_start := v_start;
  period_end := v_end;
  return next;
end;
$$;

revoke all on function public.build_scheduled_report_html(uuid, date) from public;
grant execute on function public.build_scheduled_report_html(uuid, date) to authenticated, service_role;
