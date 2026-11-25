do $$ begin
  create type public.notification_channels as enum ('email', 'whatsapp', 'both');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.notification_providers as enum ('smtp', 'resend', 'whatsapp_cloud_api');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.notification_types as enum (
    'due_reminder', 'overdue_reminder', 'receipt', 'contract_expiry',
    'scheduled_report', 'document_send', 'manual_message'
  );
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.notification_states as enum ('queued', 'sent', 'failed', 'skipped', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.notification_templates (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  type public.notification_types not null,
  channel public.notification_channels not null,
  locale public.locale_code not null,
  subject_ar text,
  subject_en text,
  body_ar text,
  body_en text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (type, channel, locale)
);

create table if not exists public.provider_configs (
  id uuid primary key default gen_random_uuid(),
  provider public.notification_providers not null unique,
  is_enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  from_email text,
  from_whatsapp text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.provider_config_uses_secret_references(p_config jsonb)
returns boolean language sql immutable set search_path = public
as $$
  select jsonb_typeof(p_config) = 'object' and not exists (
    select 1 from jsonb_each_text(p_config) entry
    where (
      entry.key ~* '(secret|password|token|api.?key)'
      and entry.key !~* '(_env|_ref)$'
    ) or (
      entry.key ~* '(_env|_ref)$'
      and entry.value !~ '^[A-Z][A-Z0-9_]*$'
    )
  )
$$;

do $$ begin
  alter table public.provider_configs
    add constraint provider_configs_secret_references_only
    check (public.provider_config_uses_secret_references(config)) not valid;
exception when duplicate_object then null; end $$;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  contract_id uuid references public.contracts(id) on delete set null,
  report_schedule_id uuid,
  type public.notification_types not null,
  channel public.notification_channels not null,
  locale public.locale_code not null default 'ar',
  template_code text references public.notification_templates(code) on update cascade,
  subject text,
  body text,
  payload jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz,
  sent_at timestamptz,
  provider public.notification_providers,
  provider_message_id text,
  state public.notification_states not null default 'queued',
  failure_reason text,
  retry_count integer not null default 0 check (retry_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.report_schedules (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name_ar text not null,
  name_en text,
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'yearly')),
  recipients jsonb not null check (jsonb_typeof(recipients) = 'array'),
  locale public.locale_code not null default 'ar',
  is_active boolean not null default true,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.generated_reports (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid references public.report_schedules(id) on delete set null,
  period_start date,
  period_end date,
  html_content text,
  storage_path text,
  locale public.locale_code,
  sent boolean not null default false,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

do $$ begin
  alter table public.notifications add constraint notifications_report_schedule_id_fkey
    foreign key (report_schedule_id) references public.report_schedules(id) on delete set null;
exception when duplicate_object then null; end $$;

create index if not exists notifications_tenant_id_idx on public.notifications(tenant_id);
create index if not exists notifications_type_idx on public.notifications(type);
create index if not exists notifications_state_idx on public.notifications(state);
create index if not exists notifications_scheduled_at_idx on public.notifications(scheduled_at);
create index if not exists notifications_created_at_idx on public.notifications(created_at desc);
create index if not exists generated_reports_schedule_id_idx on public.generated_reports(schedule_id);
create index if not exists generated_reports_created_at_idx on public.generated_reports(created_at desc);

grant select on public.notification_templates, public.notifications, public.report_schedules, public.generated_reports to authenticated;
grant select, insert, update, delete on public.notification_templates, public.provider_configs, public.notifications, public.report_schedules, public.generated_reports to service_role;
grant select, insert, update, delete on public.provider_configs to authenticated;
grant insert, update, delete on public.notification_templates, public.notifications, public.report_schedules to authenticated;

alter table public.notification_templates enable row level security;
alter table public.provider_configs enable row level security;
alter table public.notifications enable row level security;
alter table public.report_schedules enable row level security;
alter table public.generated_reports enable row level security;

drop policy if exists notification_templates_staff_read on public.notification_templates;
create policy notification_templates_staff_read on public.notification_templates for select to authenticated
  using (public.is_staff(auth.uid()));
drop policy if exists notification_templates_admin_write on public.notification_templates;
create policy notification_templates_admin_write on public.notification_templates for all to authenticated
  using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
drop policy if exists notification_templates_service_role_all on public.notification_templates;
create policy notification_templates_service_role_all on public.notification_templates for all to service_role using (true) with check (true);

drop policy if exists provider_configs_admin_all on public.provider_configs;
create policy provider_configs_admin_all on public.provider_configs for all to authenticated
  using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
drop policy if exists provider_configs_service_role_all on public.provider_configs;
create policy provider_configs_service_role_all on public.provider_configs for all to service_role using (true) with check (true);

drop policy if exists notifications_staff_read on public.notifications;
create policy notifications_staff_read on public.notifications for select to authenticated using (public.is_staff(auth.uid()));
drop policy if exists notifications_admin_write on public.notifications;
create policy notifications_admin_write on public.notifications for all to authenticated
  using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
drop policy if exists notifications_service_role_all on public.notifications;
create policy notifications_service_role_all on public.notifications for all to service_role using (true) with check (true);

drop policy if exists report_schedules_staff_read on public.report_schedules;
create policy report_schedules_staff_read on public.report_schedules for select to authenticated using (public.is_staff(auth.uid()));
drop policy if exists report_schedules_admin_write on public.report_schedules;
create policy report_schedules_admin_write on public.report_schedules for all to authenticated
  using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));
drop policy if exists report_schedules_service_role_all on public.report_schedules;
create policy report_schedules_service_role_all on public.report_schedules for all to service_role using (true) with check (true);

drop policy if exists generated_reports_staff_read on public.generated_reports;
create policy generated_reports_staff_read on public.generated_reports for select to authenticated using (public.is_staff(auth.uid()));
drop policy if exists generated_reports_service_role_all on public.generated_reports;
create policy generated_reports_service_role_all on public.generated_reports for all to service_role using (true) with check (true);

drop trigger if exists set_updated_at on public.notification_templates;
create trigger set_updated_at before update on public.notification_templates for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.provider_configs;
create trigger set_updated_at before update on public.provider_configs for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.notifications;
create trigger set_updated_at before update on public.notifications for each row execute function public.tg_set_updated_at();
drop trigger if exists set_updated_at on public.report_schedules;
create trigger set_updated_at before update on public.report_schedules for each row execute function public.tg_set_updated_at();

insert into public.notification_templates (
  code, type, channel, locale, subject_ar, subject_en, body_ar, body_en
) values
  ('due-reminder-ar', 'due_reminder', 'both', 'ar', 'تذكير باستحقاق {{period}}', 'Payment due reminder for {{period}}', 'السيد/ة {{tenant_name}}، نذكركم باستحقاق مبلغ {{amount}} عن {{unit}} للفترة {{period}}. {{company_name}}', 'Dear {{tenant_name}}, {{amount}} is due for {{unit}} for {{period}}. {{company_name}}'),
  ('due-reminder-en', 'due_reminder', 'both', 'en', 'تذكير باستحقاق {{period}}', 'Payment due reminder for {{period}}', 'السيد/ة {{tenant_name}}، نذكركم باستحقاق مبلغ {{amount}} عن {{unit}} للفترة {{period}}. {{company_name}}', 'Dear {{tenant_name}}, {{amount}} is due for {{unit}} for {{period}}. {{company_name}}'),
  ('overdue-reminder-ar', 'overdue_reminder', 'both', 'ar', 'تذكير بمبلغ متأخر {{period}}', 'Overdue payment reminder for {{period}}', 'السيد/ة {{tenant_name}}، المبلغ المتأخر {{amount}} عن {{unit}} للفترة {{period}}. {{company_name}}', 'Dear {{tenant_name}}, the overdue amount is {{amount}} for {{unit}} for {{period}}. {{company_name}}'),
  ('overdue-reminder-en', 'overdue_reminder', 'both', 'en', 'تذكير بمبلغ متأخر {{period}}', 'Overdue payment reminder for {{period}}', 'السيد/ة {{tenant_name}}، المبلغ المتأخر {{amount}} عن {{unit}} للفترة {{period}}. {{company_name}}', 'Dear {{tenant_name}}, the overdue amount is {{amount}} for {{unit}} for {{period}}. {{company_name}}'),
  ('receipt-ar', 'receipt', 'both', 'ar', 'إيصال استلام {{period}}', 'Receipt for {{period}}', 'السيد/ة {{tenant_name}}، تم استلام {{amount}} عن {{unit}} للفترة {{period}}. {{company_name}}', 'Dear {{tenant_name}}, we received {{amount}} for {{unit}} for {{period}}. {{company_name}}'),
  ('receipt-en', 'receipt', 'both', 'en', 'إيصال استلام {{period}}', 'Receipt for {{period}}', 'السيد/ة {{tenant_name}}، تم استلام {{amount}} عن {{unit}} للفترة {{period}}. {{company_name}}', 'Dear {{tenant_name}}, we received {{amount}} for {{unit}} for {{period}}. {{company_name}}'),
  ('contract-expiry-ar', 'contract_expiry', 'both', 'ar', 'تنبيه انتهاء العقد', 'Contract expiry notice', 'السيد/ة {{tenant_name}}، ينتهي عقد الوحدة {{unit}} خلال {{months_until_expiry}} شهر. {{company_name}}', 'Dear {{tenant_name}}, the contract for {{unit}} expires in {{months_until_expiry}} month(s). {{company_name}}'),
  ('contract-expiry-en', 'contract_expiry', 'both', 'en', 'تنبيه انتهاء العقد', 'Contract expiry notice', 'السيد/ة {{tenant_name}}، ينتهي عقد الوحدة {{unit}} خلال {{months_until_expiry}} شهر. {{company_name}}', 'Dear {{tenant_name}}, the contract for {{unit}} expires in {{months_until_expiry}} month(s). {{company_name}}')
on conflict (code) do update set subject_ar = excluded.subject_ar, subject_en = excluded.subject_en, body_ar = excluded.body_ar, body_en = excluded.body_en;

insert into public.provider_configs (provider, is_enabled, config) values
  ('smtp', false, '{"host_env":"SMTP_HOST","port_env":"SMTP_PORT","user_env":"SMTP_USER","secret_env":"SMTP_PASS"}'::jsonb),
  ('resend', false, '{"secret_env":"RESEND_API_KEY"}'::jsonb),
  ('whatsapp_cloud_api', false, '{"secret_env":"WHATSAPP_ACCESS_TOKEN","phone_number_id_env":"WHATSAPP_PHONE_NUMBER_ID","waba_id_env":"WHATSAPP_WABA_ID","template_namespace_ref":"WHATSAPP_TEMPLATE_NAMESPACE"}'::jsonb)
on conflict (provider) do nothing;

create or replace function public.identify_contract_expiry_reminders(p_as_of date default null)
returns table(contract_id uuid, tenant_id uuid, months_until int, template_type text)
language plpgsql security definer set search_path = public
as $$
declare v_as_of date := coalesce(p_as_of, current_date);
begin
  if auth.role() = 'authenticated' and not public.has_permission(auth.uid(), 'notifications.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;
  return query
  select c.id, c.tenant_id, threshold.months_until, 'contract_expiry'::text
  from public.contracts c
  join public.tenants t on t.id = c.tenant_id and t.reminders_enabled
  cross join (values (4), (3), (2), (1)) as threshold(months_until)
  where c.state = 'active'
    and c.end_date = (v_as_of + make_interval(months => threshold.months_until))::date
    and not exists (
      select 1 from public.notifications n
      where n.contract_id = c.id
        and n.type = 'contract_expiry'
        and n.state <> 'cancelled'
        and n.payload->>'months_until' = threshold.months_until::text
    )
  order by threshold.months_until desc, c.end_date, c.id;
end;
$$;
revoke all on function public.identify_contract_expiry_reminders(date) from public;
grant execute on function public.identify_contract_expiry_reminders(date) to authenticated, service_role;

create or replace function public.build_scheduled_report_html(p_schedule_id uuid, p_as_of date default null)
returns table(html text, period_start date, period_end date)
language plpgsql security definer set search_path = public
as $$
declare
  v_schedule public.report_schedules%rowtype;
  v_company public.companies%rowtype;
  v_start date;
  v_end date := coalesce(p_as_of, current_date);
  v_paid numeric(14,3) := 0;
  v_overdue numeric(14,3) := 0;
  v_overdue_count integer := 0;
  v_deposits numeric(14,3) := 0;
  v_units text := '';
  v_tenants text := '';
  v_dir text;
  v_title text;
  v_body text;
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
  select coalesce(sum(p.amount), 0) into v_paid from public.payments p
    where p.status = 'confirmed' and p.payment_date between v_start and v_end;
  select count(*), coalesce(sum(i.balance), 0) into v_overdue_count, v_overdue
    from public.invoices i where i.state = 'overdue' and i.balance > 0;
  if to_regclass('public.bank_deposits') is not null then
    execute 'select coalesce(sum(amount), 0) from public.bank_deposits where deposit_date between $1 and $2'
      into v_deposits using v_start, v_end;
  elsif to_regclass('public.deposits') is not null then
    execute 'select coalesce(sum(amount), 0) from public.deposits where deposit_date between $1 and $2'
      into v_deposits using v_start, v_end;
  end if;
  select coalesce(string_agg('<tr><td>' || status || '</td><td>' || total || '</td></tr>', ''), '')
    into v_units from (select status::text, count(*)::text total from public.units group by status) s;
  select coalesce(string_agg('<tr><td>' || lifecycle || '</td><td>' || total || '</td></tr>', ''), '')
    into v_tenants from (select lifecycle::text, count(*)::text total from public.tenants group by lifecycle) s;
  v_dir := case when v_schedule.locale = 'ar' then 'rtl' else 'ltr' end;
  v_title := case when v_schedule.locale = 'ar' then v_schedule.name_ar else coalesce(v_schedule.name_en, v_schedule.name_ar) end;
  v_body := '<!doctype html><html dir="' || v_dir || '"><head><meta charset="utf-8"><style>' ||
    'body{font-family:Arial,sans-serif;color:#17212b;background:#f7f4ed;padding:24px}main{max-width:780px;margin:auto;background:#fff;padding:32px;border-top:6px solid ' || coalesce(v_company.brand_primary, '#0f766e') || '}' ||
    'h1{margin:0 0 6px}p{color:#64748b}table{width:100%;border-collapse:collapse;margin:18px 0}th,td{border:1px solid #dbe1e8;padding:10px;text-align:start}th{background:#f1f5f9}.value{font-size:22px;font-weight:700}</style></head><body><main>' ||
    '<h1>' || v_title || '</h1><p>' || coalesce(v_company.name_ar, v_company.name_en, '') || ' · ' || v_start || ' — ' || v_end || '</p>' ||
    '<table><tr><th>Collected total / إجمالي التحصيل</th><th>Bank deposits / الإيداعات</th><th>Overdue / المتأخرات</th></tr>' ||
    '<tr><td class="value">' || v_paid || ' KWD</td><td class="value">' || v_deposits || ' KWD</td><td class="value">' || v_overdue || ' KWD (' || v_overdue_count || ')</td></tr></table>' ||
    '<h2>Property status / حالة العقارات</h2><table><tr><th>Status</th><th>Count</th></tr>' || v_units || '</table>' ||
    '<h2>Tenant status / حالة المستأجرين</h2><table><tr><th>Status</th><th>Count</th></tr>' || v_tenants || '</table>' ||
    '<footer>' || coalesce(case when v_schedule.locale = 'ar' then v_company.invoice_footer_ar else v_company.invoice_footer_en end, '') || '</footer></main></body></html>';
  html := v_body; period_start := v_start; period_end := v_end; return next;
end;
$$;
revoke all on function public.build_scheduled_report_html(uuid, date) from public;
grant execute on function public.build_scheduled_report_html(uuid, date) to authenticated, service_role;
