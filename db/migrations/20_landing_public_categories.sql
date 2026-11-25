-- 20_landing_public_categories.sql
-- The public landing page filters commercial_brands by category and needs the
-- category display names (name_ar / name_en). building_categories was
-- staff-only (04_phase2); expose read-only access to anonymous visitors.
-- Category labels contain no sensitive data. Idempotent and safe to re-run.

grant select on public.building_categories to anon;

drop policy if exists building_categories_select_public on public.building_categories;
create policy building_categories_select_public on public.building_categories
  for select to anon
  using (true);
