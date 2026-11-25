-- 210_contract_hide_from_portal.sql
--
-- إخفاء عقود السطح وفواتيرها بالكامل عن بوابة المستأجر، مع إبقاء رابط الدفع
-- الذي ينشئه الموظف يدويًا يعمل كما هو.
--
-- The business rule: a tenant who rents a shop AND a rooftop must see only the
-- shop in the portal. The rooftop contract, its invoices, its balance and its
-- pay button all disappear; the office collects that rent by generating a
-- KNET/hosted link from the admin screens and sending it over WhatsApp or
-- email. Everything stays visible and manageable in the dashboard.
--
-- NOT the same flag as `suppress_tenant_billing_docs` (migration 173), and the
-- distinction is the whole point:
--
--   suppress_tenant_billing_docs -> the tenant SEES and PAYS the invoice; only
--     the printable paper (invoice PDF, receipt PDF, print, preview) is denied.
--   hide_from_portal             -> the tenant does not see the contract at
--     all, and cannot start a payment for it from the portal.
--
-- The eight roof contracts already carry the first flag, so it seeds the
-- second — the codes themselves (CON-00011, CON-00059..CON-00065) are
-- production facts, while the flag is the same set and is reproducible on a
-- clean test database.
--
-- Behaviour column, not a roof column — 173's reasoning applies unchanged:
-- `units.floor` / `units.type` are operator-editable free text (see
-- `src/lib/unitFloorTypeBinding.ts`), so nothing deciding what a tenant is
-- billed for or shown may hang off a label an operator can rename in
-- Settings -> Lists. A ninth roof contract next month flips this switch rather
-- than needing a migration, and renaming a list value can never silently
-- unhide a contract.

begin;

alter table public.contracts
  add column if not exists hide_from_portal boolean not null default false;

comment on column public.contracts.hide_from_portal is
  'When true, the tenant portal hides this contract, its invoices, its contribution to the outstanding balance, and any payment it could start. Admin screens are unaffected, and a staff-generated payment link still settles these invoices. Behaviour flag - not derived from units.floor/type. Distinct from suppress_tenant_billing_docs, which hides only printable documents.';

-- One-time seed, not a rule — and the `not exists` is what makes that true.
-- Review finding on PR #209: `and not hide_from_portal` alone selects exactly
-- the row an admin has since revealed (suppressed, not hidden) and hides it
-- again, so re-running the migration would silently undo their decision. The
-- guard says "seed only while nothing has been hidden yet", which is the first
-- application and nothing else.
--
-- What it does not cover, stated rather than pretended: an admin who reveals
-- every one of the eight leaves the table looking unseeded, so a re-run would
-- seed them again. The alternative is a sentinel row to record that the seed
-- ran, and that is more machinery than one backfill deserves.
update public.contracts
   set hide_from_portal = true
 where suppress_tenant_billing_docs
   and not hide_from_portal
   and not exists (select 1 from public.contracts where hide_from_portal);

-- *** SIGNATURE CHANGE — THE OLD FORM MUST DROP FIRST. ***
-- A function's identity is (name, argument types), so `create or replace` with
-- a new argument list creates an OVERLOAD and leaves migration 121's two-arg
-- body live, still serving every existing call. Migrations 97 and 121 both hit
-- this; PostgREST answers such an ambiguity with a 300, which reads as neither
-- success nor a usable error. Dropping first is the only way through.
--
-- Callers passing only the first two arguments keep working across the deploy
-- window because the new parameter has a default — which matters, since
-- browser tabs opened before the deploy go on calling the two-arg form.
drop function if exists public.evaluate_portal_payable_invoices(uuid, uuid);

create or replace function public.evaluate_portal_payable_invoices(
  p_tenant_id uuid,
  p_contract_id uuid default null,
  p_include_hidden boolean default false
)
returns table (
  invoice_id uuid,
  period_year integer,
  period_month integer,
  total numeric,
  paid numeric,
  balance numeric,
  state text,
  is_overdue boolean,
  sequence_order integer,
  is_selectable boolean,
  lock_reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- Asking to include hidden contracts is not the same as being allowed to.
  -- A tenant crafting this call is silently downgraded to their own view,
  -- which is what makes "a tenant cannot pay a roof invoice from the portal"
  -- an enforced rule rather than a hidden button. Only staff get what they
  -- ask for, and `createPayment` asks for it so a staff-generated link still
  -- settles a hidden invoice.
  -- Every `coalesce` here is load-bearing. Outside a PostgREST request —
  -- service_role, a cron job, psql — `auth.role()` and `auth.uid()` are NULL,
  -- so `auth.role() <> 'authenticated'` is NULL and `true and NULL` is NULL,
  -- which plpgsql treats as not true. Without them this guard read as "allow
  -- when the caller is not a tenant" and behaved as "deny everyone but a
  -- logged-in staff user", which the SQL suite caught as an empty result for a
  -- superuser call.
  v_include_hidden boolean := coalesce(p_include_hidden, false)
    and (
      coalesce(auth.role(), '') <> 'authenticated'
      or coalesce(public.is_staff(auth.uid()), false)
    );
begin
  if p_tenant_id is null then
    raise exception 'Tenant is required';
  end if;

  -- Auth guard: re-stated verbatim from migrations 97 and 121. Adding a
  -- parameter must not widen who may call this.
  if auth.role() = 'authenticated' and not (
    public.is_staff(auth.uid()) or (
      public.has_role(auth.uid(), 'tenant') and exists (
        select 1
        from public.profiles p
        where p.id = auth.uid() and p.tenant_id = p_tenant_id
      )
    )
  ) then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if not exists (select 1 from public.tenants t where t.id = p_tenant_id) then
    raise exception 'Tenant not found';
  end if;

  -- A contract id from another tenant raises rather than quietly returning
  -- nothing: silence would read to the caller as "this contract has no
  -- invoices", which is a different and misleading answer.
  if p_contract_id is not null and not exists (
    select 1 from public.contracts c
    where c.id = p_contract_id and c.tenant_id = p_tenant_id
  ) then
    raise exception 'Contract does not belong to this tenant'
      using errcode = '42501';
  end if;

  return query
  with payable as (
    select
      i.id,
      i.period_year,
      i.period_month,
      i.total,
      i.paid,
      i.balance,
      i.state::text,
      (i.state = 'overdue' or (i.due_date + coalesce(c.grace_days, 0)) < current_date) as overdue,
      row_number() over (
        order by i.period_year, i.period_month, i.due_date, i.id
      )::integer as seq
    from public.invoices i
    left join public.contracts c on c.id = i.contract_id
    where i.tenant_id = p_tenant_id
      and i.state in ('due', 'overdue', 'partially_paid')
      and i.balance > 0
      and i.is_visible_to_tenant
      and (p_contract_id is null or i.contract_id = p_contract_id)
      -- Dropping these from the tenant's set also renumbers `seq` around them,
      -- which is the point: a roof arrear must not sit at position 1 and block
      -- the shop invoice behind the pay-oldest-first rule.
      and (v_include_hidden or not coalesce(c.hide_from_portal, false))
  ), ordered as (
    select
      p.*,
      first_value(p.period_month) over (order by p.seq) as blocking_month,
      first_value(p.period_year) over (order by p.seq) as blocking_year
    from payable p
  )
  select
    o.id,
    o.period_year,
    o.period_month,
    o.total,
    o.paid,
    o.balance,
    o.state,
    o.overdue,
    o.seq,
    o.seq = 1,
    case
      when o.seq = 1 then null
      else 'ادفع فاتورة شهر '
        || lpad(o.blocking_month::text, 2, '0') || '/' || o.blocking_year::text
        || ' أولًا / Pay month '
        || lpad(o.blocking_month::text, 2, '0') || '/' || o.blocking_year::text
        || ' first'
    end
  from ordered o
  order by o.seq;
end;
$$;

comment on function public.evaluate_portal_payable_invoices(uuid, uuid, boolean) is
  'يُرجع فواتير المستأجر القابلة للدفع مرتّبة الأقدم أولًا، ويستبعد عقود السطح المخفية عن البوابة. Returns a tenant''s payable invoices in pay-oldest-first order. p_include_hidden is a request, not a grant: a tenant caller is downgraded to their own view, so only staff - and createPayment, settling a staff-generated link - ever see an invoice belonging to a hide_from_portal contract.';

-- Migration 96's lesson: `from public` alone misses an explicit anon grant and
-- `from anon` alone misses a PUBLIC grant. Name both.
revoke all on function public.evaluate_portal_payable_invoices(uuid, uuid, boolean) from public, anon;
grant execute on function public.evaluate_portal_payable_invoices(uuid, uuid, boolean)
  to authenticated, service_role;

-- A dedicated RPC rather than another pass through `save_contract_with_units`.
-- That function's live body is migration 200's, it takes the whole contract
-- plus its units, and re-issuing it to add one boolean is exactly how
-- migrations 166 and 173 ended up carrying a stale body forward. A switch in
-- one row deserves a function that flips that switch and nothing else.
create or replace function public.update_contract_portal_visibility(
  p_contract_id uuid,
  p_hide_from_portal boolean
)
returns public.contracts
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_row public.contracts;
begin
  if auth.role() = 'authenticated'
     and not public.has_permission(auth.uid(), 'contracts.update') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  if p_hide_from_portal is null then
    raise exception 'p_hide_from_portal is required';
  end if;

  update public.contracts
     set hide_from_portal = p_hide_from_portal,
         updated_at = now()
   where id = p_contract_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Contract not found';
  end if;

  -- Written from inside SQL so the switch and its record commit together. What
  -- a tenant could see is a question someone will ask months later, and the
  -- answer has to name who changed it and when.
  perform public.write_audit(
    'contract.portal_visibility',
    'contract',
    p_contract_id,
    null,
    jsonb_build_object('hide_from_portal', p_hide_from_portal)
  );

  return v_row;
end;
$$;

comment on function public.update_contract_portal_visibility(uuid, boolean) is
  'يبدّل إخفاء عقد واحد وفواتيره عن بوابة المستأجر، ويكتب صف التدقيق في نفس العملية. Flips one contract''s portal visibility and nothing else, checking contracts.update and writing its audit row in the same statement - so "who hid this from the tenant, and when" stays answerable.';

revoke all on function public.update_contract_portal_visibility(uuid, boolean) from public, anon;
grant execute on function public.update_contract_portal_visibility(uuid, boolean)
  to authenticated, service_role;

commit;
