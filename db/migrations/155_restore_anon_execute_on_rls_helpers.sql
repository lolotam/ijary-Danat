-- 155_restore_anon_execute_on_rls_helpers.sql
--
-- Puts anon EXECUTE back on `has_permission`, `is_staff` and `has_role`.
--
-- WHAT WENT WRONG
-- Migration 142 re-issued all three to make them respect `profiles.is_active`,
-- and closed each with the house idiom for a SECURITY DEFINER function:
--
--   revoke all on function … from public, anon;
--   grant execute on function … to authenticated, service_role;
--
-- That idiom is correct for every definer function in this schema except these
-- three. Migration 96 singles them out by name as "Group 1 — MUST KEEP anon
-- EXECUTE (RLS helpers)" and spells out the consequence of revoking them:
--
--   "Several RLS policies use role `public` (includes anon) and call these
--    helpers in USING / WITH CHECK. Today an anon request evaluates them, they
--    return false, and the row is denied with an empty result. Revoking EXECUTE
--    (from public or from anon) would turn that clean empty list into
--    'permission denied for function has_permission' (HTTP 500). Do not revoke
--    these three — they are on the PUBLIC grant list too, and that is
--    intentional."
--
-- 142 revoked them anyway. Checked against the live database while preparing
-- this migration:
-- `has_function_privilege('anon','public.has_permission(uuid,text)','execute')`
-- returned false.
--
-- WHY NOTHING HAS BROKEN YET
-- Latent, not live: no anon-reachable policy currently calls these helpers, so
-- the public landing page still renders. The first policy that does would 500
-- for signed-out visitors, which is exactly the failure 96 described.
--
-- `src/db/anonExecute.sqltest.ts` has been failing on a clean `bun run test:db`
-- since 142 landed — "Positive companion: an over-broad revoke fails here, not
-- in production", as its own comment says. It was right.
--
-- WHAT THIS DOES NOT UNDO
-- 142's actual purpose stands untouched: all three still consult
-- `profiles.is_active`, so a deactivated user is refused. This restores who may
-- *call* them, not what they answer. The grant is narrowed to `anon` rather
-- than restored to PUBLIC — see the note at the grants below.

-- To `anon` specifically, NOT back to PUBLIC. Migration 96 described these as
-- "on the PUBLIC grant list too", but that was a statement of what happened to
-- be true, not a requirement. 142 already granted `authenticated` and
-- `service_role`, so `anon` is the only role missing, and naming it keeps the
-- grant from silently extending to any role added later.
grant execute on function public.has_permission(uuid, text) to anon;
grant execute on function public.is_staff(uuid) to anon;
grant execute on function public.has_role(uuid, public.app_role) to anon;

comment on function public.has_permission(uuid, text) is
  'RLS helper. anon holds EXECUTE on purpose — see migration 96 Group 1 and '
  'migration 155. Returns false for an anon or deactivated caller; revoking '
  'EXECUTE turns a clean empty result into HTTP 500.';
