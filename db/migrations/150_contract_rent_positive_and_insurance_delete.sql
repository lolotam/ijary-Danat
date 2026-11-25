-- 150_contract_rent_positive_and_insurance_delete.sql
--
-- Two contract-side rules the application asked for but only the form enforced.

------------------------------------------------------------
-- 1. A contract line cannot carry a zero rent
------------------------------------------------------------

-- Migration 110 constrained `monthly_amount >= 0`. A contract saved at zero
-- generates zero-value invoices for its whole term, which is never what anyone
-- meant — it is a half-filled form, not a rent-free arrangement. Rent-free
-- periods are what `public.concessions` models.
--
-- Tightening a check constraint fails on any violating row, so this was verified
-- against production before being written: zero rows in `contract_units` and
-- zero contracts currently hold a non-positive monthly amount.
--
-- The form rule alone was not enough. `save_contract_with_units` performs no
-- positivity check and the bulk importer accepts zero, so both would still write
-- rows the form refuses.
alter table public.contract_units
  drop constraint if exists contract_units_monthly_amount_check;
alter table public.contract_units
  add constraint contract_units_monthly_amount_check
  check (monthly_amount > 0);

------------------------------------------------------------
-- 2. Deleting a contract's insurance holding, atomically
------------------------------------------------------------

-- Zeroing a contract's insurance now deletes its `insurance_payments` row.
--
-- THE COST, RECORDED HERE BECAUSE IT IS NOT REVERSIBLE
-- `get_budget_summary` does not read a stored historical figure — it recomputes
-- `insurance_collected` from the rows that exist at query time (migration 56).
-- Deleting a holding therefore lowers the insurance figure of the month it was
-- collected in, retroactively, and a report already printed for that month will
-- no longer reproduce. This is a deliberate product decision; the audit row is
-- what makes it traceable, and nothing makes it reversible.
--
-- WHY AN RPC RATHER THAN A DELETE PLUS AN AUDIT CALL FROM THE BROWSER
-- Those are two round-trips. If the second fails the row is already gone and the
-- audit trail this comment leans on does not exist — while the caller reports an
-- error for an operation that in fact succeeded. Same reason `close_out_contract`
-- and `erase_all_data` write their audit rows from inside SQL.
--
-- There is exactly one holding per contract (`unique (contract_id)`, migration
-- 56), so the manual Insurance panel and the contract form's mirror write the
-- same row. There is no separately-owned manual holding for this to destroy by
-- surprise.
create or replace function public.delete_contract_insurance(p_contract_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $fn$
declare
  v_row public.insurance_payments;
begin
  -- SECURITY DEFINER bypasses the RLS policy that would otherwise enforce this,
  -- so the check has to be made explicitly. Roles are customisable, so the
  -- permission is the authority, not a role name.
  if not public.has_permission(auth.uid(), 'insurance.delete') then
    raise exception 'insurance_delete_forbidden' using errcode = '42501';
  end if;

  select * into v_row
    from public.insurance_payments
   where contract_id = p_contract_id;

  -- No holding is not a failure: a contract whose insurance was always zero has
  -- nothing to remove, and the caller reports "unchanged".
  if not found then
    return false;
  end if;

  delete from public.insurance_payments where id = v_row.id;

  perform public.write_audit(
    'insurance_payments.delete',
    'insurance_payments',
    v_row.id,
    to_jsonb(v_row),
    null
  );

  return true;
end;
$fn$;

-- A new function arrives with EXECUTE granted to PUBLIC, and
-- `src/db/anonExecute.sqltest.ts` fails the suite for any anon-executable
-- SECURITY DEFINER outside three named RLS helpers. `anon` is named explicitly
-- as well as `public`: revoking from one does not remove a grant held by the
-- other (see migrations 78 / 103 / 113).
revoke all on function public.delete_contract_insurance(uuid) from public, anon;
grant execute on function public.delete_contract_insurance(uuid) to authenticated, service_role;
