-- ============================================================================
-- تفريغ البيانات التشغيلية قبل إدخال البيانات الحقيقية
-- Clear operational data (tenants, contracts, invoices, payments, concessions,
-- audit log, notification pool, tenant portal logins) ahead of live data entry.
--
-- DELIBERATELY PRESERVED: properties, units, buildings, companies, all settings
-- tables (option_lists, cron_jobs, notification_templates, permissions,
-- role_permissions), landing-page tables, backups, commercial_brands, and the
-- three admin accounts.
--
-- Order is dictated by the FK graph, not by tidiness:
--   * invoices -> contracts / tenants is ON DELETE RESTRICT, so every invoice
--     must go before any contract or tenant can be deleted.
--   * profiles.tenant_id -> tenants is ON DELETE SET NULL, so deleting tenants
--     first would erase the very predicate that identifies a portal account.
--     Those IDs are therefore snapshotted before anything is touched.
--   * audit_logs is emptied last, so it also sheds whatever the deletes above
--     may have recorded.
--
-- Run inside a single transaction with ON_ERROR_STOP=1.
-- ============================================================================

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- 0. لقطة لحسابات بوابة المستأجرين قبل أي حذف
--    Snapshot the portal accounts up front: step 6 deletes `tenants`, which
--    nulls profiles.tenant_id via SET NULL and would otherwise leave the seven
--    tenant accounts indistinguishable from the three admin ones.
-- ---------------------------------------------------------------------------
create temp table _tenant_users on commit drop as
select id, email from public.profiles where tenant_id is not null;

-- ---------------------------------------------------------------------------
-- 1. حواجز الأمان — تتوقف العملية بالكامل إذا اختلّ أي افتراض
--    Guards. Each aborts the whole transaction rather than deleting the wrong
--    rows: a privileged role sitting on a tenant-linked profile means the
--    tenant/admin split this script was written against no longer holds.
-- ---------------------------------------------------------------------------
do $guard$
declare
  bad_roles int;
  portal_n  int;
  admin_n   int;
begin
  select count(*) into bad_roles
    from public.user_roles r
    join public.profiles p on p.id = r.user_id
   where p.tenant_id is not null
     and r.role::text <> 'tenant';
  if bad_roles > 0 then
    raise exception 'ABORT: % non-tenant role(s) attached to tenant-linked profiles', bad_roles;
  end if;

  select count(*) into portal_n from _tenant_users;
  select count(*) into admin_n from public.profiles where tenant_id is null;

  if admin_n = 0 then
    raise exception 'ABORT: no admin profiles would survive';
  end if;

  raise notice 'Guards passed: % portal account(s) to delete, % admin account(s) preserved',
    portal_n, admin_n;
end
$guard$;

-- ---------------------------------------------------------------------------
-- 2. المدفوعات وما يتفرع عنها
--    Payments and everything hanging off them. Allocations go first: they
--    RESTRICT against invoices, and their delete trigger rewrites
--    invoices.payment_method while those invoices still exist.
-- ---------------------------------------------------------------------------
delete from public.payment_allocations;
delete from public.receipts;
delete from public.partial_payments;
delete from public.payment_requests;
delete from public.refunds;
delete from public.payments;
delete from public.webhook_events;
delete from public.deposits;

-- ---------------------------------------------------------------------------
-- 3. الفواتير والتنازلات والخصومات
--    Invoices, concessions and discounts. There is no discounts table — a
--    discount is concessions.discount_amount/percent, invoice_items.
--    discount_percent, or invoices.discount, so clearing these three tables
--    clears every discount there is.
--
--    Concessions are deleted explicitly rather than left to cascade from
--    contracts, because tg_restore_invoices_on_concession_delete rewrites the
--    invoices it discounted — that has to run while those invoices still exist.
-- ---------------------------------------------------------------------------
delete from public.concession_invoices;
delete from public.concessions;
delete from public.contract_closeout_invoice_actions;
delete from public.contract_closeout_deductions;
delete from public.contract_closeouts;
delete from public.invoice_items;
delete from public.invoices;

-- ---------------------------------------------------------------------------
-- 4. العقود وفصل الوحدات والعلامات التجارية عنها
--    Contracts, and the detach of everything that pointed at them.
--
--    A unit carries no contract_id: it is tied to a contract only through the
--    contract_units join table plus units.status. Dropping the join rows is
--    therefore the detach, and tg_contract_units_sync_unit_status flips each
--    unit back to vacant as it goes. The explicit update afterwards is a
--    backstop, not a duplicate — it guarantees the end state regardless of
--    whether every trigger path fired.
--
--    Properties have no contract column at all; they reach contracts only via
--    their units, so clearing the join detaches them too.
-- ---------------------------------------------------------------------------
delete from public.insurance_payments;
delete from public.electricity_charges;
delete from public.contract_operational_events;
delete from public.contract_units;

update public.commercial_brands set contract_id = null where contract_id is not null;

delete from public.contracts;

update public.units set status = 'vacant' where status <> 'vacant';

-- ---------------------------------------------------------------------------
-- 5. المستأجرون والإشعارات والتقارير
--    Tenants, the notification pool, and reports generated from the old data.
-- ---------------------------------------------------------------------------
delete from public.tenant_documents;
delete from public.tenant_messages;
delete from public.user_tenants;
delete from public.notifications;
delete from public.generated_reports;
delete from public.tenants;

-- ---------------------------------------------------------------------------
-- 6. بيانات دخول بوابة المستأجرين
--    Portal credentials. profiles and user_roles carry no FK to auth.users, so
--    deleting the auth user alone leaves both rows orphaned; all three are
--    deleted explicitly. auth.sessions / identities / refresh_tokens cascade.
-- ---------------------------------------------------------------------------
delete from public.user_roles where user_id in (select id from _tenant_users);
delete from public.profiles   where id      in (select id from _tenant_users);
delete from auth.users        where id      in (select id from _tenant_users);

-- ---------------------------------------------------------------------------
-- 7. سجل التدقيق — آخر خطوة
--    Audit log last, so it also sheds anything the deletes above recorded.
-- ---------------------------------------------------------------------------
delete from public.audit_logs;

-- ---------------------------------------------------------------------------
-- 8. التحقق بعد التنفيذ
--    Post-conditions. A surviving row in a cleared table, an occupied unit, a
--    brand still pointing at a contract, or a lost property/unit/admin rolls
--    the whole transaction back.
-- ---------------------------------------------------------------------------
do $verify$
declare
  leftover  int;
  props     int;
  unts      int;
  occupied  int;
  bound     int;
  admins    int;
begin
  select (select count(*) from public.tenants)
       + (select count(*) from public.contracts)
       + (select count(*) from public.contract_units)
       + (select count(*) from public.invoices)
       + (select count(*) from public.invoice_items)
       + (select count(*) from public.concessions)
       + (select count(*) from public.concession_invoices)
       + (select count(*) from public.payments)
       + (select count(*) from public.payment_allocations)
       + (select count(*) from public.receipts)
       + (select count(*) from public.notifications)
       + (select count(*) from public.audit_logs)
    into leftover;
  if leftover <> 0 then
    raise exception 'ABORT: % row(s) survived the clear', leftover;
  end if;

  select count(*) into occupied from public.units where status <> 'vacant';
  select count(*) into bound from public.commercial_brands where contract_id is not null;
  if occupied <> 0 or bound <> 0 then
    raise exception 'ABORT: detach incomplete (% non-vacant unit(s), % brand(s) still bound)',
      occupied, bound;
  end if;

  select count(*) into props  from public.properties;
  select count(*) into unts   from public.units;
  select count(*) into admins from public.profiles;
  if props = 0 or unts = 0 or admins = 0 then
    raise exception 'ABORT: preserved data damaged (properties=%, units=%, profiles=%)',
      props, unts, admins;
  end if;

  raise notice 'OK — preserved: % properties, % units (all vacant), % admin account(s)',
    props, unts, admins;
end
$verify$;

commit;
