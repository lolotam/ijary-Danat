-- 96_revoke_anon_execute_on_definer_functions.sql
--
-- Production hole (confirmed live, rolled-back transaction only):
--
--   Most guarded SECURITY DEFINER functions in this repo gate like:
--
--     if auth.role() = 'authenticated'
--       and not public.has_permission(auth.uid(), '…') then
--       raise exception 'Permission denied' using errcode = '42501';
--     end if;
--
--   An `anon` caller has auth.role() = 'anon', so the whole condition is false
--   and the guard never runs. Combined with an EXECUTE grant, the function
--   body runs unguarded. PostgREST maps the anon JWT to this database role,
--   and the anon key ships in the browser bundle, so the grant is reachable
--   over public HTTPS.
--
--   Accuracy: erase_all_data is NOT in that shape. Its guard is
--   `if not public.has_role(auth.uid(), 'admin') then raise` with no
--   `auth.role() = 'authenticated'` precondition, so anon is already rejected
--   by the body. Revoking its EXECUTE is hygiene, not a breach fix. Only the
--   `auth.role() = 'authenticated' and not has_permission(…)` shape has the
--   guard-skip hole.
--
-- Two independent exposure routes (the repeatable mistake in this codebase):
--
--   Route A — explicit `anon=X` grant (empty-looking grantee is NOT this).
--     Comes from Supabase default privileges: after a function is created,
--     anon and authenticated each get their own EXECUTE grant. Revoking only
--     FROM PUBLIC leaves those intact. Closed by naming `anon` on the REVOKE.
--
--   Route B — PUBLIC `=X` grant (ACL shows a leading empty grantee, e.g.
--     `=X/postgres , postgres=X/postgres , authenticated=X/…`).
--     Postgres default for a new function that was never explicitly revoked.
--     `anon` inherits EXECUTE through PUBLIC and holds no grant of its own, so
--     `from anon` alone is a no-op. Closed only by naming `public` on the REVOKE.
--
--   Therefore every revoke in this file is:
--
--     revoke execute on function public.f(argtypes) from public, anon;
--
--   `from public` alone (older migrations' idiom) misses Route A.
--   `from anon` alone misses Route B.
--   Both are always required. A function can sit on either route depending on
--   whether its defining migration happened to write a revoke.
--
-- Classification of the 57 functions that currently hold anon EXECUTE:
--
--   Group 1 — MUST KEEP anon EXECUTE (RLS helpers):
--     has_permission, is_staff, has_role.
--     Several RLS policies use role `public` (includes anon) and call these
--     helpers in USING / WITH CHECK. Today an anon request evaluates them,
--     they return false, and the row is denied with an empty result. Revoking
--     EXECUTE (from public or from anon) would turn that clean empty list into
--     "permission denied for function has_permission" (HTTP 500). Do not
--     revoke these three — they are on the PUBLIC grant list too, and that is
--     intentional.
--
--   Group 2 — INERT (trigger functions, returns trigger):
--     tg_*, handle_new_user, guard_profile_self_update,
--     protect_charged_meter_reading, sync_following_meter_reading,
--     refresh_draft_charge_for_reading, validate_electricity_charge_insert,
--     deactivate_portal_users_without_active_contract.
--     Postgres refuses direct calls ("trigger functions can only be called as
--     triggers"), so the grant never conferred an exploit path. Revoked below
--     for hygiene only — not claimed as a security fix.
--
--   Group 3 — REVOKE (callable money / state / data paths):
--     Everything else on the live list: invoice/payment generators and
--     mutators, portal payable evaluation, sequence generators, audit/cron
--     helpers, lifecycle sync, reports, etc. If a function is not clearly in
--     group 1 or 2, it is in group 3.
--
-- This migration changes privileges only. No function body is rewritten.
-- No re-GRANT to authenticated / service_role — those grants already exist.
--
-- Idempotence: REVOKE of a privilege the grantee does not hold is a no-op in
-- Postgres, so re-running this file is safe.
--
-- Argument types below match the highest-numbered migration that defines each
-- function (or the grant/revoke line that already names the signature).

------------------------------------------------------------
-- Group 3: callable paths — revoke EXECUTE from public and anon
------------------------------------------------------------

-- Money / invoice / payment paths
revoke execute on function public.apply_payment_allocation(uuid, jsonb) from public, anon;
revoke execute on function public.backfill_contract_invoices(uuid) from public, anon;
revoke execute on function public.contract_period_amounts(uuid, date) from public, anon;
revoke execute on function public.evaluate_overdue(date) from public, anon;
revoke execute on function public.evaluate_portal_payable_invoices(uuid, integer) from public, anon;
revoke execute on function public.generate_electricity_charges(integer, integer, uuid) from public, anon;
revoke execute on function public.generate_invoices(uuid, integer) from public, anon;
revoke execute on function public.generate_invoices_for_year(uuid, integer, boolean) from public, anon;
revoke execute on function public.generate_salaries_for_month(integer, integer) from public, anon;
revoke execute on function public.invoice_has_pending_request(uuid) from public, anon;
revoke execute on function public.reapply_contract_invoices(uuid) from public, anon;
revoke execute on function public.receipt_html_for_payment(uuid) from public, anon;
revoke execute on function public.regenerate_contract_invoices(uuid) from public, anon;
revoke execute on function public.reverse_payment(uuid, text) from public, anon;
revoke execute on function public.set_invoice_paid(uuid, boolean) from public, anon;

-- Destructive / admin / audit / cron / report
revoke execute on function public._seed_option_items(text, jsonb) from public, anon;
revoke execute on function public.build_scheduled_report_html(uuid, date) from public, anon;
revoke execute on function public.erase_all_data() from public, anon;
revoke execute on function public.get_budget_summary(date, date, uuid, uuid) from public, anon;
revoke execute on function public.get_deposit_total(date, date, text, text, text) from public, anon;
revoke execute on function public.identify_contract_expiry_reminders(date) from public, anon;
revoke execute on function public.record_cron_run(text, text, integer, text) from public, anon;
revoke execute on function public.write_audit(text, text, uuid, jsonb, jsonb, text, text) from public, anon;

-- Sequence generators (next_*_code)
revoke execute on function public.next_building_code() from public, anon;
revoke execute on function public.next_contract_code() from public, anon;
revoke execute on function public.next_electricity_charge_code() from public, anon;
revoke execute on function public.next_employee_code() from public, anon;
revoke execute on function public.next_invoice_code() from public, anon;
revoke execute on function public.next_maintenance_request_code() from public, anon;
revoke execute on function public.next_payment_code() from public, anon;
revoke execute on function public.next_payment_request_code() from public, anon;
revoke execute on function public.next_property_code() from public, anon;
revoke execute on function public.next_receipt_code() from public, anon;
revoke execute on function public.next_tenant_code() from public, anon;
revoke execute on function public.next_unit_code() from public, anon;

-- Lifecycle / unit / electricity compute + sync (callable, not trigger-typed)
revoke execute on function public.compute_electricity_amount(uuid, numeric) from public, anon;
revoke execute on function public.compute_tenant_lifecycle(uuid, public.tenant_lifecycle) from public, anon;
revoke execute on function public.compute_unit_status(uuid, public.unit_status) from public, anon;
revoke execute on function public.set_tenant_blocked(uuid, boolean) from public, anon;
revoke execute on function public.sync_tenant_lifecycle_for(uuid) from public, anon;
revoke execute on function public.sync_unit_status_for(uuid) from public, anon;
revoke execute on function public.unit_has_active_contract(uuid) from public, anon;

------------------------------------------------------------
-- Group 2: trigger functions — revoke for hygiene only
-- (never callable as plain SQL; not a production exploit path)
------------------------------------------------------------

revoke execute on function public.deactivate_portal_users_without_active_contract() from public, anon;
revoke execute on function public.guard_profile_self_update() from public, anon;
revoke execute on function public.handle_new_user() from public, anon;
revoke execute on function public.protect_charged_meter_reading() from public, anon;
revoke execute on function public.refresh_draft_charge_for_reading() from public, anon;
revoke execute on function public.sync_following_meter_reading() from public, anon;
revoke execute on function public.tg_contract_sync_tenant_lifecycle() from public, anon;
revoke execute on function public.tg_contract_sync_unit_status() from public, anon;
revoke execute on function public.tg_sync_payment_receipt() from public, anon;
revoke execute on function public.tg_tenant_default_lifecycle() from public, anon;
revoke execute on function public.tg_unit_enforce_derived_status() from public, anon;
revoke execute on function public.validate_electricity_charge_insert() from public, anon;

-- Group 1 deliberately omitted:
--   has_permission(uuid, text)
--   is_staff(uuid)
--   has_role(uuid, public.app_role)
-- See header: RLS policies for role `public` evaluate these as anon.
