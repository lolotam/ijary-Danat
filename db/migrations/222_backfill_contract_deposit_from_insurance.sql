-- 222_backfill_contract_deposit_from_insurance.sql
--
-- ينقل مبالغ التأمين المسجّلة يدوياً قبل وجود المزامنة إلى وديعة عقودها، مرة واحدة.
--
-- Migration 220 copies an insurance row's amount into `contracts.deposit`, but
-- only when a row is saved. Fourteen rows were entered through the Insurance
-- tab on 2026-09-20, three days before that sync existed, so their contracts
-- still show a deposit of 0 while the owner's rule is "insurance = contract
-- deposit". This runs each of them through the same
-- `sync_contract_deposit_from_insurance` the UI calls, so every change gets
-- the same `contract.deposit.sync_from_insurance` audit row as a UI save
-- (actor recorded as `system`).
--
-- Only contracts whose deposit is still 0 are touched: a non-zero deposit
-- that differs from its insurance row was set by someone and is not
-- overwritten here. That predicate also makes a second run a no-op, and on a
-- fresh database with no insurance rows the loop does nothing.

begin;

do $$
declare
  v_pending integer;
  v_synced integer := 0;
  v_row record;
begin
  select count(*) into v_pending
    from public.insurance_payments ip
    join public.contracts c on c.id = ip.contract_id
   where c.deposit = 0
     and ip.amount > 0;

  for v_row in
    select ip.id
      from public.insurance_payments ip
      join public.contracts c on c.id = ip.contract_id
     where c.deposit = 0
       and ip.amount > 0
     order by ip.created_at, ip.id
  loop
    perform public.sync_contract_deposit_from_insurance(v_row.id);
    v_synced := v_synced + 1;
  end loop;

  if v_synced <> v_pending then
    raise exception 'Deposit backfill synced % of % pending contracts', v_synced, v_pending;
  end if;

  if exists (
    select 1
      from public.insurance_payments ip
      join public.contracts c on c.id = ip.contract_id
     where c.deposit = 0
       and ip.amount > 0
  ) then
    raise exception 'Deposit backfill left contracts with a zero deposit and an insurance row';
  end if;

  raise notice 'Deposit backfill: % contracts synced from insurance', v_synced;
end;
$$;

commit;
