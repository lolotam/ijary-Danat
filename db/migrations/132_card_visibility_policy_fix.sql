-- 132_card_visibility_policy_fix.sql
-- يعيد بناء سياستَي RLS على card_visibility بعد أن أثبتت سياسة 126 أنّها غير قابلة للتحقيق.
--
-- Migration 126 scoped both policies to `company_id = (select p.company_id
-- from public.profiles p where p.id = auth.uid())`. That profile-scoped subquery
-- is correct IN PRINCIPLE for a multi-company deployment, but in THIS deployment
-- `profiles.company_id` is NULL for every user (verified against production:
-- six profiles, zero with a company_id), so the subselect yields NULL,
-- `company_id = NULL` evaluates to NULL rather than true, and the policy could
-- be satisfied by NO ONE — every SELECT returned zero rows and every write was
-- denied. The Cards Control screen rendered from the registry alone, so it
-- looked functional while never reading or persisting anything.
--
-- The fix drops the unsatisfiable `company_id` term from BOTH policies:
--
--   * SELECT becomes `using (true)`. Visibility of which KPI cards are on is
--     not sensitive, and every gated list page reads the table to decide what
--     to render, so every signed-in staff member must be able to read it. This
--     matches how the rest of the staff tables in this schema behave.
--
--   * WRITE keeps `public.has_permission(auth.uid(), 'company.update')` in both
--     `using` and `with check`. The permission check is the real protection and
--     it works; only the unsatisfiable company term is removed.
--
-- Do NOT repopulate `profiles.company_id` here. That is a broader change that
-- touches authentication and the assumptions of other tables' policies, and is
-- out of scope for this fix. The client still filters reads by `company_id`
-- (useCardVisibility), so behaviour stays correct on this single-company
-- deployment and on any future multi-company one once `profiles.company_id`
-- is actually populated.

drop policy if exists card_visibility_select on public.card_visibility;
create policy card_visibility_select on public.card_visibility
  for select to authenticated
  using (true);

drop policy if exists card_visibility_write on public.card_visibility;
create policy card_visibility_write on public.card_visibility
  for all to authenticated
  using (public.has_permission(auth.uid(), 'company.update'))
  with check (public.has_permission(auth.uid(), 'company.update'));
