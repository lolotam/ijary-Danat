/**
 * قائمة السماح لاستيراد `src/integrations/supabase/client.server.ts` (`supabaseAdmin` / `service_role`).
 *
 * Strictly matches `specs/001-multi-company-saas/contracts/company-context.md` section 3;
 * every server function and library helper outside these paths must use `companyClient(companyId)`.
 */
export const PLATFORM_ALLOWLIST = [
  "src/platform/**",
  "src/company/hostCompany.server.ts",
  "src/worker/relay.ts",
  "src/worker/runJobPorts.ts",
  "src/worker/scheduler.ts",
];
