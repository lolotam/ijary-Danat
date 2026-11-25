-- 67_backfill_contract_insurance.sql
--
-- T13c said insurance rows are "created when a contract with deposit > 0 is
-- activated". Migration 56 built public.insurance_payments and the Insurance
-- tab that reads it, but nothing ever wrote the row: the Batch D plan's
-- Commit 3 has no step for it and there is no trigger on public.contracts. So
-- every contract saved with an insurance amount since then recorded that money
-- only on contracts.deposit, and Payment and Refund → Insurance stayed empty.
--
-- useSyncContractInsurance (src/hooks/useContracts.ts) closes the gap going
-- forward. This closes it for the contracts already saved.
--
-- Idempotent, and a no-op on a clean database — bun run test:db builds from
-- scratch with no contracts, so this inserts nothing there.

insert into public.insurance_payments (
  contract_id,
  tenant_id,
  unit_id,
  building_id,
  amount,
  collected_date
)
select
  c.id,
  c.tenant_id,
  c.unit_id,
  u.building_id,
  c.deposit,
  -- The contract's start, not current_date. These are historic holdings, and
  -- stamping them today would pile them all into this month's
  -- get_budget_summary → insurance_collected.
  c.start_date
from public.contracts c
left join public.units u on u.id = c.unit_id
where c.deposit > 0
  -- Draft contracts have not been agreed yet, so no insurance is held. Every
  -- other state has: an expired or terminated contract's insurance stays on
  -- record until a refund returns it.
  and c.state <> 'draft'
-- unique (contract_id): never disturb a row an accountant already entered by
-- hand, and never double-insert on re-apply.
on conflict (contract_id) do nothing;
