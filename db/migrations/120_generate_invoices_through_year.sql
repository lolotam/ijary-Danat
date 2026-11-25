-- 120_generate_invoices_through_year.sql
--
-- `generate_invoices(p_contract_id, p_through_year)` did not generate *through*
-- a year. It generated exactly the one year it was handed, because its whole
-- body was `select * from generate_invoices_for_year(p_contract_id,
-- p_through_year, false)` and that function's `v_year` is a single scalar
-- (`coalesce(p_through_year, extract(year from current_date))`), never a range.
--
-- The parameter name promised a range the body never delivered, and the admin
-- Generate button binds it to the year the invoices page happens to be showing
-- (`admin.invoices.tsx` — `year = search.year ?? now.getFullYear()`). So for a
-- contract that runs past December of the viewed year there was no reachable
-- path to its later periods: the button asked for the current year, every
-- period in that year already existed, `on conflict ... do nothing` swallowed
-- the inserts, and the caller got zero rows with no error.
--
-- Production evidence (2026-08-09, contract CON-00003 extended 12 → 17 months,
-- 2026-08-01 → 2027-12-31):
--
--   01:24:59  contract.update   end_date 2027-12-31, duration_months 17
--   01:25:19  invoice.generate  {"input": {"throughYear": 2026}, "generated": 0}
--
-- Nothing failed. The 12 periods of 2027 were simply never requested. Calling
-- generate_invoices_for_year(contract, 2027, false) by hand produced all twelve
-- correctly — the generator was right, it was unreachable.
--
-- Why fix it HERE and not in regenerate_contract_invoices: creating future
-- periods on a contract edit is deliberately not this system's behaviour.
-- Migration 97 paired regenerate and reapply on exactly that rule — preserve
-- an in-term future unpaid invoice, never create one — and
-- src/db/invoiceRegeneration.sqltest.ts:629 and :724 hold both sides of it.
-- Future invoices exist only because an admin explicitly asked for them. This
-- migration makes that explicit ask able to reach the years it names; it does
-- not move the automatic horizon.
--
-- Supersede-by-number: `generate_invoices` was last defined in
-- 37_concession_free_months_skip_and_reapply.sql. That file is untouched — see
-- 119's header and migration 48 for the last time editing an applied migration
-- silently did nothing. generate_invoices_for_year (119) is NOT redefined here;
-- the per-year generator was never the bug.
--
-- No signature change and no `returns table (...)` row-type change, so plain
-- `create or replace` stays legal and there is no `drop function` in this file.

-- ---------------------------------------------------------------------------
-- generate_invoices — a true "through year" generator
-- ---------------------------------------------------------------------------
create or replace function public.generate_invoices(
  p_contract_id uuid default null,
  p_through_year integer default null
)
returns table (
  id uuid, code text, contract_id uuid, period_year integer,
  period_month integer, total numeric, state text
)
language plpgsql security definer set search_path = public
as $$
declare
  v_current integer := extract(year from current_date)::integer;
  v_target integer := coalesce(p_through_year, v_current);
  v_horizon integer;
  v_first integer;
  v_last integer;
  v_year integer;
begin
  -- The guard has to be here, not only inside generate_invoices_for_year.
  -- The loop below can legitimately run zero times (every in-scope contract
  -- already ended), and an empty loop never reaches the inner function's
  -- check — an unauthorised caller would then read "0 generated" instead of a
  -- permission error, which is indistinguishable from "nothing to do".
  if auth.role() = 'authenticated'
    and not public.has_permission(auth.uid(), 'invoices.create') then
    raise exception 'Permission denied' using errcode = '42501';
  end if;

  -- Same range as generate_invoices_for_year's own check. Repeated rather than
  -- delegated for the same reason as the guard above: the loop may not run.
  if v_target < 2000 or v_target > 2200 then
    raise exception 'Target year is outside the supported range';
  end if;

  -- Clamp the forward end to the furthest year any in-scope contract actually
  -- runs to. Generating past every contract's end date is a guaranteed no-op —
  -- generate_invoices_for_year's loop predicate requires
  -- `c.end_date >= make_date(v_year, 1, 1)` — but without this clamp the Zod
  -- schema's 2200 ceiling would be a 175-iteration full-portfolio scan that
  -- inserts nothing. Archived contracts are excluded to match migration 82:
  -- they are billable by no path, so they must not extend the horizon either.
  select max(extract(year from c.end_date))::integer into v_horizon
    from public.contracts c
   where c.archived_at is null
     and (p_contract_id is null or c.id = p_contract_id);

  -- Asking for a PAST year still means that year alone — an admin filling a
  -- historical gap must not have the request silently widened to today.
  -- Asking for the current year or later means current year → target.
  v_first := least(v_target, v_current);
  v_last := least(v_target, coalesce(v_horizon, v_current));

  for v_year in v_first .. v_last loop
    return query
      select * from public.generate_invoices_for_year(p_contract_id, v_year, false);
  end loop;
end;
$$;

revoke execute on function public.generate_invoices(uuid, integer) from public, anon;
grant execute on function public.generate_invoices(uuid, integer) to authenticated, service_role;
