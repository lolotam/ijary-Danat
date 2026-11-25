-- 167_drop_brand_contract_id.sql
--
-- CONTRACT half of the expand/contract pair opened by migration 162.
--
-- !! DO NOT APPLY WITH THE REST OF THIS BATCH. !!
--
-- Apply 162-166 before the merge, then merge (which starts the Dokploy build),
-- then WAIT until the new container is confirmed to be serving -- the bundle
-- hash on https://danat-future.com matching the one inside the container, not
-- merely a green build -- and only then apply this file. Dokploy takes minutes
-- to build, and for those minutes the OLD bundle is still selecting
-- `commercial_brands.contract_id`. Dropping it early turns every shop row in
-- Settings > Landing page into a 400.
--
-- Why drop it at all: `commercial_brand_contracts` (162) is now the source of
-- truth, and this column would become a second one that nothing reads and
-- everything can quietly disagree with. That is this repository's most
-- recurring defect shape -- `is_system`, `archived_at` and the LtrText pairs
-- were all written and never read -- and the cure is to not leave the column
-- behind in the first place.

------------------------------------------------------------------------
-- 1. Re-run the backfill before dropping
------------------------------------------------------------------------
-- 162 backfilled once, at expand time. Between that moment and this one the
-- old bundle was still live and an admin editing a shop would have written
-- `contract_id` and nothing else. This second pass carries any such write into
-- the join table rather than deleting it with the column.
--
-- Residual, stated rather than engineered around: a link CLEARED through the
-- old bundle in that window reappears here, because a cleared scalar and a
-- never-set one are the same NULL. The window is the length of one deploy and
-- the action is one admin clearing one shop's contract; a dual-write trigger
-- to close it would be more moving parts than the risk is worth.
insert into public.commercial_brand_contracts (brand_id, contract_id)
select b.id, b.contract_id
  from public.commercial_brands b
 where b.contract_id is not null
on conflict do nothing;

------------------------------------------------------------------------
-- 2. Drop the column
------------------------------------------------------------------------
drop index if exists public.commercial_brands_contract_id_idx;

alter table public.commercial_brands
  drop column if exists contract_id;
