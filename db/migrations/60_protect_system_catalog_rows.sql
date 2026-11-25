-- 60_protect_system_catalog_rows.sql
--
-- Found by live testing on 2026-07-31 (Journey 1), not by any test.
--
-- The settings catalogues render a "System" badge on seeded rows, and
-- docs/testing/2026-07-31-user-journeys-t1-t15.md states plainly:
--
--   > system items ... still show a lock/system marker and **cannot** be
--   > deleted. Deleting those is meant to be blocked
--
-- Nothing blocked it. `is_system` was read in exactly one place —
-- admin.settings.lists.tsx, to draw the badge. The delete button rendered
-- identically for system and custom rows, RLS checked only `has_role(admin)`,
-- and there was no trigger. An admin could delete `knet`, `cash` or
-- `bank_transfer` with one click.
--
-- Blast radius, measured rather than assumed: `payments.method` is the enum
-- `public.payment_methods`, not a foreign key to option_list_items, so existing
-- payments keep their value and no financial record is corrupted. What breaks is
-- forward-looking and silent — the method disappears from the admin dropdown and
-- staff can no longer record a KNET payment, with nothing on screen explaining
-- why the option vanished.
--
-- The guard lives in the database, not the form. A disabled button is a
-- courtesy; PostgREST is reachable directly with the same admin JWT, so the UI
-- alone protects nothing. The button is disabled too (separate change), so the
-- badge's promise is visible as well as enforced.

create or replace function public.tg_block_system_row_delete()
returns trigger
language plpgsql
as $$
begin
  if old.is_system then
    raise exception 'Cannot delete a system item'
      using errcode = '23503',
            hint = 'System entries are seeded with the app. Deactivate it instead.';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_option_list_items_block_system_delete on public.option_list_items;
create trigger trg_option_list_items_block_system_delete
  before delete on public.option_list_items
  for each row
  execute function public.tg_block_system_row_delete();

drop trigger if exists trg_option_lists_block_system_delete on public.option_lists;
create trigger trg_option_lists_block_system_delete
  before delete on public.option_lists
  for each row
  execute function public.tg_block_system_row_delete();

-- Expense categories are a real table (expenses reference them by category_id),
-- managed by their own panel on the same screen and carrying the same flag, so
-- they inherit the same promise and the same gap.
drop trigger if exists trg_expense_categories_block_system_delete on public.expense_categories;
create trigger trg_expense_categories_block_system_delete
  before delete on public.expense_categories
  for each row
  execute function public.tg_block_system_row_delete();
