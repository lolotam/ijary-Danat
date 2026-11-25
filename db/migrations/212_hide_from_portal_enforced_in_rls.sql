-- 212_hide_from_portal_enforced_in_rls.sql
--
-- إخفاء عقد السطح يصبح قاعدة في RLS، لا مجرد مرشِّح في الواجهة.
--
-- Review finding on PR #209. Migration 210 filtered `hide_from_portal` in the
-- portal's React Query hooks and enforced it inside
-- `evaluate_portal_payable_invoices`, so a tenant could not *pay* a hidden
-- contract. They could still *read* one: `contracts_select_allowed` (migration
-- 04) authorises a tenant read purely on `profiles.tenant_id`, and
-- `invoices_select_allowed` (migration 05) on `tenant_id` plus
-- `is_visible_to_tenant`. A tenant with a browser console — or anyone holding
-- their anon key and session — could ask PostgREST for the roof contract and
-- its invoices directly and get them.
--
-- "Completely hidden" has to mean hidden at the row, or it means very little.
-- The staff branch of each policy is untouched: admins read everything, and
-- `is_visible_to_tenant` keeps its separate meaning on invoices.
--
-- Deliberately NOT applied to `payments` or `payment_allocations`. A payment is
-- the tenant's own money and a single payment can settle invoices across both a
-- visible and a hidden contract; hiding the row would make their own history
-- lie about what they paid. The portal instead drops the hidden *allocation*
-- from what it renders, which is `usePortalPayments`' job.

begin;

drop policy if exists contracts_select_allowed on public.contracts;
create policy contracts_select_allowed on public.contracts for select to authenticated using (
  public.is_staff(auth.uid()) or (
    not coalesce(hide_from_portal, false) and exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.tenant_id = contracts.tenant_id
    )
  )
);

-- An invoice is visible to its tenant only while its CONTRACT is, and the
-- subquery is written in the positive for a reason that cost a test run to
-- learn: RLS *does* apply to a table referenced inside another table's policy
-- expression. A `not exists (… where hide_from_portal)` is therefore evaluated
-- under the contracts policy just narrowed above — it finds nothing for a
-- hidden contract, `not exists` is true, and every invoice sails through. The
-- positive form turns that same fact into the rule: no readable contract, no
-- readable invoice, and the two policies cannot drift because there is only one
-- definition of what a tenant may see.
--
-- The `profiles` check stays even though the contract check subsumes it. It is
-- the sentence that says out loud whose invoice this is, and migration 39's
-- tenant-isolation hardening is easier to reason about with it present.
drop policy if exists invoices_select_allowed on public.invoices;
create policy invoices_select_allowed on public.invoices for select to authenticated using (
  public.is_staff(auth.uid()) or (
    is_visible_to_tenant
    and exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.tenant_id = invoices.tenant_id
    )
    and exists (
      select 1 from public.contracts c where c.id = invoices.contract_id
    )
  )
);

commit;
