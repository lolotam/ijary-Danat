-- 48_receipt_wording_reissue.sql
--
-- Delivers commit 3d3edf6 ("remove 'وليس إيجار' from invoice/receipt headers
-- and notes") to already-migrated databases.
--
-- Why this migration is needed at all:
-- 3d3edf6 corrected the wording by editing migrations 05 and 45 IN PLACE.
-- That works for a database built from scratch, but migrations are applied
-- once and never re-run, so every environment that had already executed 45 —
-- production included — still carries the old
-- `receipt_html_for_payment()` body with 'قيمة استثمار وليس إيجار' in it.
-- Editing an applied migration changes the repo, not the server.
--
-- The function is `create or replace`, and per the repo's convention the
-- highest-numbered definition wins, so re-issuing the corrected body here is
-- the supported way to roll the change forward. Body is byte-identical to the
-- corrected definition in 45 (escaping and the security-definer/search_path
-- hardening from that migration are preserved) — only the migration number is
-- new. Safe to re-run; idempotent.
------------------------------------------------------------

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

-- Note on existing data: receipts.html_snapshot rows written BEFORE this
-- migration keep the old wording, by design — a snapshot is a record of what
-- the tenant was shown at the time. Only newly generated receipts pick up the
-- corrected text. Backfilling historical snapshots would rewrite issued
-- documents and is deliberately not done here.
