-- ============================================================
-- Migration 98: generated_reports DELETE policy + grants
--
-- Policy-and-grant only — no table or function change.
--
-- The `reports.delete` permission already existed in public.permissions
-- (seeded with the reports module) and was simply unreachable: RLS on
-- public.generated_reports had only staff SELECT and service_role ALL, so a
-- browser delete as authenticated matched no policy, affected zero rows, and
-- did not error. This wires the missing DELETE policy to has_permission.
--
-- Two-layer grant reality (why a naive "match migration 07" rewrite fails):
--
--   1. Migration 07 line 130 did grant SELECT only to authenticated on this
--      table (insert / update / delete went to report_schedules and
--      notifications, not generated_reports). That part is correct.
--
--   2. Supabase's default privileges then granted ALL (arwdDxtm) to both
--      `anon` AND `authenticated` on top of what migration 07 wrote. Live
--      ACL before this migration:
--        postgres=arwdDxtm/postgres , anon=arwdDxtm/postgres ,
--        authenticated=arwdDxtm/postgres , service_role=arwdDxtm/postgres
--      A migration that only reasons about migration 07's SELECT grant will
--      consistently misjudge the live state of every table in this database.
--
-- Therefore we revoke ALL from public, anon, and authenticated, then re-grant
-- only what the browser path actually uses: SELECT + DELETE for authenticated.
-- INSERT / UPDATE / TRUNCATE are removed from authenticated because every
-- write to this table goes through supabaseAdmin (service_role) in
-- src/fns/runReportSchedule.ts and src/fns/resendGeneratedReport.ts; reads
-- go through useGeneratedReports. service_role is left untouched — migration
-- 07 granted it select/insert/update/delete deliberately and the report
-- generator depends on it.
--
-- A policy without the table privilege still denies, so the DELETE grant is
-- load-bearing. Revoking public + anon + authenticated together closes the
-- residual ALL routes (migration 96 pattern: any one grantee alone left open
-- leaves another route open).
-- Idempotent.
-- ============================================================

revoke all on public.generated_reports from public, anon, authenticated;
grant select, delete on public.generated_reports to authenticated;

drop policy if exists generated_reports_delete_permitted on public.generated_reports;
create policy generated_reports_delete_permitted
  on public.generated_reports for delete to authenticated
  using (public.has_permission(auth.uid(), 'reports.delete'));
