-- 61_allow_deleting_system_catalog_rows.sql
--
-- Reverses 60_protect_system_catalog_rows.sql at the owner's explicit request.
--
-- Migration 60 added BEFORE DELETE triggers that refused to remove any row
-- flagged `is_system`, because the "System" badge promised protection and
-- nothing enforced it. That closed the gap between the badge and reality by
-- making the badge true.
--
-- In use, the badge turned out to be the wrong half to keep. The seeded
-- catalogues are not a fixed vocabulary the app depends on — they are a
-- starting point, and most deployments want to prune them. On this database
-- that is 8 of the 10 expense categories, so the panel offered an admin two
-- deletable rows out of ten and refused the rest with no way forward.
--
-- So the promise is withdrawn rather than enforced: `is_system` goes back to
-- meaning "shipped with the app", which is provenance, not permission. The
-- badge still renders, and the delete confirmation warns when the row is a
-- seeded one, but nothing refuses the deletion.
--
-- CONSEQUENCES, stated plainly, because this migration is what enables them:
--
--   * option_list_items — deleting a seeded item (`knet`, `cash`,
--     `bank_transfer`) removes that option from its dropdown. Historical rows
--     keep their values: `payments.method` is the enum `public.payment_methods`,
--     not a foreign key here, so no financial record changes. What is lost is
--     forward-looking — staff can no longer pick that method on a new payment.
--
--   * option_lists — `option_list_items.list_id` is ON DELETE CASCADE, so
--     deleting a list takes every item in it. The UI confirms this separately.
--
--   * expense_categories — `expenses.category_id` is ON DELETE SET NULL. The
--     delete therefore always succeeds and never blocks; expenses that used the
--     category survive with a null category and fall into the uncategorised
--     bucket of `get_budget_summary` (current definition in
--     56_refunds_partial_insurance.sql). No expense row and no amount is lost.
--
-- Nothing here is destructive on its own: it removes refusals, it does not
-- delete data.

drop trigger if exists trg_option_list_items_block_system_delete on public.option_list_items;
drop trigger if exists trg_option_lists_block_system_delete on public.option_lists;
drop trigger if exists trg_expense_categories_block_system_delete on public.expense_categories;

-- The function existed only to back those three triggers (migration 60 created
-- it and nothing else references it), so it goes too rather than lingering as a
-- dead definition that a future reader mistakes for an active guard.
drop function if exists public.tg_block_system_row_delete();
