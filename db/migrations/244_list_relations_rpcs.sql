-- 244_list_relations_rpcs.sql
--
-- The contracts and tenants lists each fetched their page, then fanned out
-- into 5–7 further requests that had to run one after another (tenants →
-- contract_units → units → properties → brands → concessions → overdue).
-- Every request is a full browser → Cloudflare → Kong → PostgREST round trip
-- (~50–80 ms measured from the server itself, more from Kuwait), so the
-- contracts screen spent ~1 s waiting on data that takes ~2 ms to read.
--
-- These functions return all of a page's related rows in ONE request. They are
-- SECURITY INVOKER: every row is read through the caller's own RLS, exactly as
-- the separate requests did, so nobody sees anything they could not see before.
-- They return raw rows only; the browser still does the grouping and the
-- business rules (active-contract choice, concession months), unchanged.

/**
 * يرجع شعار المتجر وصورة بطاقته لأول علامة تجارية نشطة مرتبطة بكل عقد.
 *
 * Mirrors fetchActiveBrandsByContractIds: the first active brand by
 * display_order wins a contract that two brands claim (migration 162 made the
 * link a join table). `b.id` breaks display_order ties so the answer is stable.
 */
create or replace function public.contract_brand_assets(p_contract_ids uuid[])
returns table (contract_id uuid, logo_path text, cover_path text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  select distinct on (l.contract_id)
         l.contract_id, logo.storage_path, cover.storage_path
    from public.commercial_brand_contracts l
    join public.commercial_brands b on b.id = l.brand_id and b.is_active
    left join public.landing_media logo on logo.id = b.logo_media_id
    left join public.landing_media cover on cover.id = b.cover_media_id
   where l.contract_id = any (p_contract_ids)
   order by l.contract_id, b.display_order, b.id;
$fn$;

/**
 * يرجع كل ما تحتاجه صفحة العقود عن العقود المعروضة في طلب واحد.
 *
 * Same rows the page used to fetch in seven requests: the tenants, the
 * contract_units lines in line_order, their units and buildings, the active
 * concessions, the first active brand, and which contracts owe an overdue
 * balance (state AND balance > 0 — an overdue invoice settled out of band
 * keeps its state, see fetchOverdueContractIds).
 */
create or replace function public.contract_list_relations(p_contract_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  with lines as (
    select cu.contract_id, cu.unit_id, cu.monthly_amount, cu.line_order
      from public.contract_units cu
     where cu.contract_id = any (p_contract_ids)
  ), unit_rows as (
    select u.* from public.units u where u.id in (select unit_id from lines)
  )
  select jsonb_build_object(
    'tenants', coalesce((
      select jsonb_agg(to_jsonb(t))
        from public.tenants t
       where t.id in (select c.tenant_id from public.contracts c
                       where c.id = any (p_contract_ids))
    ), '[]'::jsonb),
    'contract_units', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.contract_id, l.line_order) from lines l
    ), '[]'::jsonb),
    'units', coalesce((select jsonb_agg(to_jsonb(u)) from unit_rows u), '[]'::jsonb),
    'properties', coalesce((
      select jsonb_agg(to_jsonb(p))
        from public.properties p
       where p.id in (select property_id from unit_rows)
    ), '[]'::jsonb),
    'concessions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'contract_id', k.contract_id, 'type', k.type,
               'start_date', k.start_date, 'end_date', k.end_date,
               'discount_percent', k.discount_percent,
               'discount_amount', k.discount_amount))
        from public.concessions k
       where k.contract_id = any (p_contract_ids) and k.status = 'active'
    ), '[]'::jsonb),
    'brands', coalesce((
      select jsonb_agg(to_jsonb(b)) from public.contract_brand_assets(p_contract_ids) b
    ), '[]'::jsonb),
    'overdue_contract_ids', coalesce((
      select jsonb_agg(distinct i.contract_id)
        from public.invoices i
       where i.contract_id = any (p_contract_ids)
         and i.state = 'overdue' and i.balance > 0
    ), '[]'::jsonb)
  );
$fn$;

/**
 * يرجع كل ما تحتاجه صفحة المستأجرين عن المستأجرين المعروضين في طلب واحد.
 *
 * Every contract in any state (the lifecycle column counts them all), their
 * contract_units lines, the units and buildings of those lines, brands per
 * contract, and the overdue (tenant, contract) pairs. Units, buildings and
 * brands cover every contract rather than only the active ones the page
 * shows: the page picks the active contracts itself and looks the rest up by
 * id, so a few extra rows cost nothing and keep that rule in one place.
 */
create or replace function public.tenant_list_relations(p_tenant_ids uuid[])
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $fn$
  with contract_rows as (
    select c.id, c.code, c.tenant_id, c.state, c.start_date, c.end_date, c.monthly_amount
      from public.contracts c
     where c.tenant_id = any (p_tenant_ids)
  ), lines as (
    select cu.contract_id, cu.unit_id, cu.line_order
      from public.contract_units cu
     where cu.contract_id in (select id from contract_rows)
  ), unit_rows as (
    select u.* from public.units u where u.id in (select unit_id from lines)
  )
  select jsonb_build_object(
    'contracts', coalesce((select jsonb_agg(to_jsonb(c)) from contract_rows c), '[]'::jsonb),
    'contract_units', coalesce((
      select jsonb_agg(jsonb_build_object('contract_id', l.contract_id, 'unit_id', l.unit_id)
                       order by l.contract_id, l.line_order)
        from lines l
    ), '[]'::jsonb),
    'units', coalesce((select jsonb_agg(to_jsonb(u)) from unit_rows u), '[]'::jsonb),
    'properties', coalesce((
      select jsonb_agg(to_jsonb(p))
        from public.properties p
       where p.id in (select property_id from unit_rows)
    ), '[]'::jsonb),
    'brands', coalesce((
      select jsonb_agg(to_jsonb(b))
        from public.contract_brand_assets(array(select id from contract_rows)) b
    ), '[]'::jsonb),
    'overdue', coalesce((
      select jsonb_agg(jsonb_build_object('tenant_id', i.tenant_id, 'contract_id', i.contract_id))
        from public.invoices i
       where i.tenant_id = any (p_tenant_ids)
         and i.state = 'overdue' and i.balance > 0
    ), '[]'::jsonb)
  );
$fn$;

revoke all on function public.contract_brand_assets(uuid[]) from public, anon;
revoke all on function public.contract_list_relations(uuid[]) from public, anon;
revoke all on function public.tenant_list_relations(uuid[]) from public, anon;
grant execute on function public.contract_brand_assets(uuid[]) to authenticated, service_role;
grant execute on function public.contract_list_relations(uuid[]) to authenticated, service_role;
grant execute on function public.tenant_list_relations(uuid[]) to authenticated, service_role;
