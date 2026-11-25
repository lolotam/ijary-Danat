-- 45_security_hardening_wsr.sql
-- Security review remediation. Safe to re-run (idempotent: create or replace).
--
-- 1. erase_all_data() no longer destroys the audit trail that records the erase,
--    and now writes an audit entry of its own.
-- 2. receipt_html_for_payment() entity-escapes every free-text value it
--    interpolates, matching the escaping already applied to the scheduled-report
--    HTML in migration 44.

------------------------------------------------------------
-- Shared HTML-escaping helper
------------------------------------------------------------
-- PostgreSQL has no built-in HTML escaper. This mirrors the inline replace()
-- chain used in 44_scheduled_report_email_design.sql, as a named function so
-- future HTML-producing functions have one obvious thing to call.
create or replace function public.html_escape(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select case
    when p_value is null then ''
    else replace(
           replace(
             replace(
               replace(p_value, '&', '&amp;'),
               '<', '&lt;'),
             '>', '&gt;'),
           '"', '&quot;')
  end
$$;

revoke all on function public.html_escape(text) from public;
grant execute on function public.html_escape(text) to authenticated, service_role;

comment on function public.html_escape(text) is
  'Escapes &, <, > and " for safe interpolation into generated HTML.';

------------------------------------------------------------
-- 1. erase_all_data(): preserve the audit trail
------------------------------------------------------------
create or replace function public.erase_all_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Restrict to admin users only
  if not public.has_role(auth.uid(), 'admin') then
    raise exception 'Unauthorized: Only administrators can wipe the database.';
  end if;

  -- Record the erase BEFORE it runs, so the entry exists even if the caller's
  -- session dies mid-statement.
  perform public.write_audit(
    'database.erase_all',
    'database',
    null,
    null,
    jsonb_build_object('requested_at', now()),
    'success',
    null
  );

  -- Truncate operational and transactional tables in order.
  -- public.audit_logs is deliberately NOT in this list: wiping the data must not
  -- also wipe the forensic record of who wiped it. Do not re-add it.
  truncate table
    public.receipts,
    public.payment_allocations,
    public.payments,
    public.invoice_items,
    public.invoices,
    public.payment_requests,
    public.webhook_events,
    public.concessions,
    public.contracts,
    public.tenant_documents,
    public.tenants,
    public.electricity_charges,
    public.meter_readings,
    public.electricity_meters,
    public.units,
    public.buildings,
    public.properties,
    public.expenses,
    public.deposits,
    public.notifications,
    public.generated_reports,
    public.contact_inquiries
    cascade;
end;
$$;

comment on function public.erase_all_data() is
  'Admin-only destructive reset. Preserves public.audit_logs by design.';

------------------------------------------------------------
-- 2. receipt_html_for_payment(): escape interpolated text
------------------------------------------------------------
-- Company fields and the tenant name are free text. The output is stored in
-- receipts.html_snapshot; escaping it here means the column is safe to render
-- if it is ever wired into a print/preview path.
create or replace function public.receipt_html_for_payment(p_payment_id uuid)
returns text language sql security definer set search_path = public
as $$
  select '<article dir="rtl"><header>'
    || case when c.logo_url is null then ''
            else '<img src="' || public.html_escape(c.logo_url) || '" alt="" />' end
    || '<h1>قيمة استثمار</h1><h2>'
    || public.html_escape(coalesce(c.name_ar, c.name_en, '')) || '</h2></header><p>'
    || public.html_escape(coalesce(t.name, '')) || ' — '
    || public.html_escape(p.code) || '</p><ul>'
    || coalesce((
      select string_agg(
        '<li>قيمة استثمار ' || i.period_month::text || '/' || i.period_year::text
        || ': ' || pa.amount::text || ' ' || public.html_escape(p.currency) || '</li>',
        '' order by i.period_year, i.period_month
      )
      from public.payment_allocations pa
      join public.invoices i on i.id = pa.invoice_id
      where pa.payment_id = p.id
    ), '')
    || '</ul><strong>' || p.amount::text || ' ' || public.html_escape(p.currency)
    || '</strong><p>قيمة استثمار للوحدة</p><footer>'
    || public.html_escape(coalesce(c.address_ar, c.address_en, '')) || ' · '
    || public.html_escape(coalesce(c.phone, '')) || ' · '
    || public.html_escape(coalesce(c.map_url, ''))
    || ' · ' || public.html_escape(coalesce(c.name_ar, c.name_en, '')) || '</footer></article>'
  from public.payments p
  join public.tenants t on t.id = p.tenant_id
  left join public.companies c on c.id = p.company_id
  where p.id = p_payment_id
$$;

revoke all on function public.receipt_html_for_payment(uuid) from public;
grant execute on function public.receipt_html_for_payment(uuid) to authenticated, service_role;
