-- 243_rls_hoist_auth_checks.sql
--
-- Every RLS policy in `public` calls is_staff / has_role / has_permission with
-- auth.uid() directly. Postgres evaluates such a call once PER ROW: counting
-- 4,628 invoices as an admin ran is_staff 4,628 times (47.9 ms, measured on
-- production 2026-10-05). Wrapped in a scalar sub-select the call becomes an
-- InitPlan, evaluated ONCE per statement (0.8 ms for the same count). This is
-- the pattern Supabase documents for RLS performance.
--
-- Semantics are unchanged: auth.uid() is constant within a statement and the
-- three helpers are STABLE, so evaluating them once gives the same answer as
-- evaluating them per row. Only how often they run changes.
--
-- Rewritten mechanically from the catalog rather than by hand, so all 183
-- policies get the same treatment and none is missed or mistyped. Idempotent:
-- an expression that already contains `SELECT auth.uid()` is left as it is.
-- A policy re-created by a later migration in the old form simply runs slower
-- until this file's pattern is applied to it too — it never runs wrongly.

/**
 * يلفّ استدعاءات التحقق من هوية المستخدم بـ (select ...) حتى تُحسب مرة واحدة لكل استعلام.
 *
 * Input is a policy expression deparsed with search_path = pg_catalog, so every
 * name is schema-qualified and the patterns below are exact. Order matters: the
 * helper calls are rewritten first around a placeholder, then any remaining
 * bare auth.uid(), then the placeholder — so no auth.uid() is wrapped twice.
 */
create or replace function pg_temp.rls_hoist_auth(p_expr text)
returns text
language plpgsql
immutable
as $fn$
declare
  v text := p_expr;
begin
  if v is null or v !~ 'auth\.uid\(\)' or v ~ 'SELECT auth\.uid\(\)' then
    return v;
  end if;
  v := regexp_replace(v, 'public\.is_staff\(auth\.uid\(\)\)',
                      '(SELECT public.is_staff(__RLS_UID__))', 'g');
  v := regexp_replace(v,
         'public\.(has_role|has_permission)\(auth\.uid\(\), (''[^'']*''::[a-z_.]+)\)',
         '(SELECT public.\1(__RLS_UID__, \2))', 'g');
  v := replace(v, 'auth.uid()', '(SELECT auth.uid())');
  v := replace(v, '__RLS_UID__', '(SELECT auth.uid())');
  return v;
end;
$fn$;

do $mig$
declare
  r record;
  v_qual text;
  v_check text;
  v_sql text;
  v_changed integer := 0;
  -- Restored at the end: migrations are often applied concatenated in one
  -- transaction, and a leaked search_path would break every file after this.
  v_search_path text := current_setting('search_path');
  v_lock_timeout text := current_setting('lock_timeout');
begin
  -- Fully-qualified deparse, so the rewritten text means the same thing
  -- whatever search_path the policy is later evaluated under.
  perform set_config('search_path', 'pg_catalog', true);
  -- ALTER POLICY takes an exclusive lock on its table; never queue behind a
  -- long-running query and stall the app while holding the earlier locks.
  perform set_config('lock_timeout', '5s', true);

  for r in
    select c.relname,
           p.polname,
           pg_get_expr(p.polqual, p.polrelid) as qual,
           pg_get_expr(p.polwithcheck, p.polrelid) as wcheck
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
     order by c.relname, p.polname
  loop
    v_qual := pg_temp.rls_hoist_auth(r.qual);
    v_check := pg_temp.rls_hoist_auth(r.wcheck);
    if v_qual is not distinct from r.qual and v_check is not distinct from r.wcheck then
      continue;
    end if;

    v_sql := format('alter policy %I on public.%I', r.polname, r.relname);
    if v_qual is not null then
      v_sql := v_sql || format(' using (%s)', v_qual);
    end if;
    if v_check is not null then
      v_sql := v_sql || format(' with check (%s)', v_check);
    end if;
    execute v_sql;
    v_changed := v_changed + 1;
  end loop;

  perform set_config('search_path', v_search_path, true);
  perform set_config('lock_timeout', v_lock_timeout, true);
  raise notice 'rls_hoist_auth: % policies rewritten', v_changed;
end;
$mig$;
