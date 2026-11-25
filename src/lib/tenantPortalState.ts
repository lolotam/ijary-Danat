/**
 * حالة بوابة المستأجر كما تُعرض في القائمة.
 *
 * `tenants.tenant_portal_enabled` is a switch an admin sets by hand, and
 * setting it creates nothing. In production 54 tenants carry it while only 29
 * have an account behind it, so the column reported "Yes" for 25 people who had
 * no way to sign in — a promise that surfaced only when one of them phoned in.
 *
 * `no-account` is the state worth naming: the flag is on and nothing backs it.
 */
export type TenantPortalState = "disabled" | "enabled" | "no-account";

export interface TenantPortalInput {
  portalEnabled: boolean;
  /** هل يوجد صف في profiles مرتبط بهذا المستأجر. */
  hasAccount: boolean;
  /**
   * هل تعذّرت قراءة الحسابات أصلاً.
   *
   * `profiles` is readable only with `users.read`, so for anyone else the
   * account set was never fetched. Reporting `no-account` then would describe
   * the viewer's permissions rather than the tenant, which is why this collapses
   * to the plain enabled state instead.
   */
  accountsUnknown: boolean;
}

/** يحدّد ما تعرضه خلية البوابة لمستأجر واحد. */
export function tenantPortalState(input: TenantPortalInput): TenantPortalState {
  if (!input.portalEnabled) return "disabled";
  if (input.accountsUnknown || input.hasAccount) return "enabled";
  return "no-account";
}
