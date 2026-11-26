-- T038: استبدال التسلسلات العامة بعدّادات معزولة لكل شركة
-- Replaces the global code sequences with per-company counters in public.company_counters
-- behind all existing next_*_code() function names, and enforces company context in next_receipt_code().

create table public.company_counters (
  company_id uuid not null default public.current_company_id()
    references public.companies(id) on delete cascade,
  kind text not null
    check (kind in (
      'invoice',
      'payment',
      'receipt',
      'contract',
      'refund',
      'property',
      'building',
      'unit',
      'tenant',
      'payment_request',
      'expense',
      'deposit',
      'electricity_charge',
      'employee',
      'maintenance_request'
    )),
  last_value bigint not null default 0 check (last_value >= 0),
  primary key (company_id, kind)
);

-- ترحيل أعلى قيم الرموز الحالية لكل شركة حتى لا تتصادم السجلات الجديدة مع البذور القائمة.
do $$
declare
  v_spec record;
begin
  for v_spec in
    select *
      from (values
        ('invoices', 'invoice', 'INV'),
        ('payments', 'payment', 'PAY'),
        ('contracts', 'contract', 'CON'),
        ('refunds', 'refund', 'REF'),
        ('properties', 'property', 'PROP'),
        ('buildings', 'building', 'BLDG'),
        ('units', 'unit', 'UNIT'),
        ('tenants', 'tenant', 'DANA'),
        ('payment_requests', 'payment_request', 'PREQ'),
        ('expenses', 'expense', 'EXP'),
        ('deposits', 'deposit', 'DEP'),
        ('electricity_charges', 'electricity_charge', 'ELEC'),
        ('employees', 'employee', 'EMP'),
        ('maintenance_requests', 'maintenance_request', 'MNT')
      ) as t(tbl, kind, prefix)
  loop
    execute format(
      $q$
        insert into public.company_counters (company_id, kind, last_value)
        select company_id, %L,
               max((substring(code from '([0-9]+)$'))::bigint)
          from public.%I
         where code ~ ('^' || %L || '-[0-9]+$')
         group by company_id
        on conflict (company_id, kind) do update
          set last_value = greatest(public.company_counters.last_value, excluded.last_value)
      $q$,
      v_spec.kind,
      v_spec.tbl,
      v_spec.prefix
    );
  end loop;
end;
$$;

alter table public.company_counters enable row level security;
alter table public.company_counters force row level security;

grant select on public.company_counters to authenticated;
grant select, insert, update, delete on public.company_counters to company_service;
grant all on public.company_counters to service_role;

create policy company_counters_select_company
  on public.company_counters
  for select
  to authenticated
  using (company_id = (select public.current_company_id()));

create policy company_counters_company_service_all
  on public.company_counters
  for all
  to company_service
  using (company_id = (select public.current_company_id()))
  with check (company_id = (select public.current_company_id()));

create policy company_counters_service_role_all
  on public.company_counters
  for all
  to service_role
  using (true)
  with check (true);

/**
 * يرفع عدّاد نوع مستند معيّن للشركة الحالية ذرياً ويعيد القيمة التالية، ويرفض العمل دون سياق شركة.
 */
create or replace function public.next_company_counter(p_kind text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_next bigint;
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  insert into public.company_counters (company_id, kind, last_value)
  values (v_company_id, p_kind, 1)
  on conflict (company_id, kind)
  do update set last_value = public.company_counters.last_value + 1
  returning last_value into v_next;

  return v_next;
end;
$$;

revoke all on function public.next_company_counter(text) from public, anon;
grant execute on function public.next_company_counter(text) to authenticated, company_service, service_role;

/**
 * يولّد رمز العقار التالي الخاص بالشركة الحالية بصيغة PROP-001.
 */
create or replace function public.next_property_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'PROP-' || lpad(public.next_company_counter('property')::text, 3, '0');
$$;

/**
 * يولّد رمز المبنى التالي الخاص بالشركة الحالية بصيغة BLDG-00001.
 */
create or replace function public.next_building_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'BLDG-' || lpad(public.next_company_counter('building')::text, 5, '0');
$$;

/**
 * يولّد رمز الوحدة التالي الخاص بالشركة الحالية بصيغة UNIT-00001.
 */
create or replace function public.next_unit_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'UNIT-' || lpad(public.next_company_counter('unit')::text, 5, '0');
$$;

/**
 * يولّد رمز المستأجر التالي الخاص بالشركة الحالية بصيغة DANA-000001.
 */
create or replace function public.next_tenant_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'DANA-' || lpad(public.next_company_counter('tenant')::text, 6, '0');
$$;

/**
 * يولّد رمز العقد التالي الخاص بالشركة الحالية بصيغة CON-00001.
 */
create or replace function public.next_contract_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'CON-' || lpad(public.next_company_counter('contract')::text, 5, '0');
$$;

/**
 * يولّد رمز الفاتورة التالي الخاص بالشركة الحالية بصيغة INV-0000001.
 */
create or replace function public.next_invoice_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'INV-' || lpad(public.next_company_counter('invoice')::text, 7, '0');
$$;

/**
 * يولّد رمز الدفعة التالي الخاص بالشركة الحالية بصيغة PAY-0000001.
 */
create or replace function public.next_payment_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'PAY-' || lpad(public.next_company_counter('payment')::text, 7, '0');
$$;

/**
 * يولّد رمز طلب الدفع التالي الخاص بالشركة الحالية بصيغة PREQ-0000001.
 */
create or replace function public.next_payment_request_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'PREQ-' || lpad(public.next_company_counter('payment_request')::text, 7, '0');
$$;

/**
 * يولّد رمز الاسترداد التالي الخاص بالشركة الحالية بصيغة REF-0000001.
 */
create or replace function public.next_refund_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'REF-' || lpad(public.next_company_counter('refund')::text, 7, '0');
$$;

/**
 * يولّد رمز المصروف التالي الخاص بالشركة الحالية بصيغة EXP-000001.
 */
create or replace function public.next_expense_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'EXP-' || lpad(public.next_company_counter('expense')::text, 6, '0');
$$;

/**
 * يولّد رمز الإيداع التالي الخاص بالشركة الحالية بصيغة DEP-000001.
 */
create or replace function public.next_deposit_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'DEP-' || lpad(public.next_company_counter('deposit')::text, 6, '0');
$$;

/**
 * يولّد رمز رسوم الكهرباء التالي الخاص بالشركة الحالية بصيغة ELEC-0000001.
 */
create or replace function public.next_electricity_charge_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'ELEC-' || lpad(public.next_company_counter('electricity_charge')::text, 7, '0');
$$;

/**
 * يولّد رمز الموظف التالي الخاص بالشركة الحالية بصيغة EMP-00001.
 */
create or replace function public.next_employee_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'EMP-' || lpad(public.next_company_counter('employee')::text, 5, '0');
$$;

/**
 * يولّد رمز طلب الصيانة التالي الخاص بالشركة الحالية بصيغة MNT-000001.
 */
create or replace function public.next_maintenance_request_code()
returns text
language sql
security invoker
set search_path = public
as $$
  select 'MNT-' || lpad(public.next_company_counter('maintenance_request')::text, 6, '0');
$$;

/**
 * يولّد رمز إيصال عشوائياً فريداً ضمن نطاق الشركة الحالية ويرفض العمل دون سياق شركة.
 */
create or replace function public.next_receipt_code()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_company_id uuid := public.current_company_id();
  v_now timestamp := timezone('Asia/Kuwait', now());
  v_prefix text;
  v_bytes bytea;
  v_token text;
  v_code text;
  v_i integer;
  v_chars constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
begin
  if v_company_id is null then
    raise exception 'COMPANY_REQUIRED' using errcode = '42501';
  end if;

  v_prefix := 'REC-' || to_char(v_now, 'YYYY-FMMonth-DD-MM-YYYY') || '-';

  loop
    v_bytes := extensions.gen_random_bytes(15);
    v_token := '';
    for v_i in 0..14 loop
      v_token := v_token || substr(v_chars, (get_byte(v_bytes, v_i) % 36) + 1, 1);
    end loop;
    v_code := v_prefix || v_token;
    exit when not exists (
      select 1
        from public.receipts r
       where r.company_id = v_company_id
         and r.code = v_code
    );
  end loop;

  return v_code;
end;
$$;

revoke all on function public.next_property_code() from public, anon;
revoke all on function public.next_building_code() from public, anon;
revoke all on function public.next_unit_code() from public, anon;
revoke all on function public.next_tenant_code() from public, anon;
revoke all on function public.next_contract_code() from public, anon;
revoke all on function public.next_invoice_code() from public, anon;
revoke all on function public.next_payment_code() from public, anon;
revoke all on function public.next_payment_request_code() from public, anon;
revoke all on function public.next_refund_code() from public, anon;
revoke all on function public.next_expense_code() from public, anon;
revoke all on function public.next_deposit_code() from public, anon;
revoke all on function public.next_electricity_charge_code() from public, anon;
revoke all on function public.next_employee_code() from public, anon;
revoke all on function public.next_maintenance_request_code() from public, anon;
revoke all on function public.next_receipt_code() from public, anon;

grant execute on function public.next_property_code() to authenticated, company_service, service_role;
grant execute on function public.next_building_code() to authenticated, company_service, service_role;
grant execute on function public.next_unit_code() to authenticated, company_service, service_role;
grant execute on function public.next_tenant_code() to authenticated, company_service, service_role;
grant execute on function public.next_contract_code() to authenticated, company_service, service_role;
grant execute on function public.next_invoice_code() to authenticated, company_service, service_role;
grant execute on function public.next_payment_code() to authenticated, company_service, service_role;
grant execute on function public.next_payment_request_code() to authenticated, company_service, service_role;
grant execute on function public.next_refund_code() to authenticated, company_service, service_role;
grant execute on function public.next_expense_code() to authenticated, company_service, service_role;
grant execute on function public.next_deposit_code() to authenticated, company_service, service_role;
grant execute on function public.next_electricity_charge_code() to authenticated, company_service, service_role;
grant execute on function public.next_employee_code() to authenticated, company_service, service_role;
grant execute on function public.next_maintenance_request_code() to authenticated, company_service, service_role;
grant execute on function public.next_receipt_code() to authenticated, company_service, service_role;

drop sequence if exists
  public.property_code_seq,
  public.building_code_seq,
  public.unit_code_seq,
  public.tenant_code_seq,
  public.contract_code_seq,
  public.invoice_code_seq,
  public.payment_code_seq,
  public.payment_request_code_seq,
  public.refund_code_seq,
  public.expense_code_seq,
  public.deposit_code_seq,
  public.electricity_charge_code_seq,
  public.employee_code_seq,
  public.maintenance_request_code_seq,
  public.receipt_code_seq;
