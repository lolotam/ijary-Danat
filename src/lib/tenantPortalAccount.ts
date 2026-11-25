import { userConflictMessage } from "@/lib/userConflicts";

/** Shown when a tenant that already has a portal login is given another. */
export const TENANT_ALREADY_HAS_ACCOUNT = userConflictMessage(
  { kind: "tenant-account" },
  "This tenant already has a portal account — choose another tenant.",
);

/**
 * يتعرّف على رفض قاعدة البيانات لحساب بوابة ثانٍ لنفس المستأجر.
 *
 * Matches the index from migration 224 by name as well as 23505, so another
 * unique violation on `profiles` (a taken username, say) keeps its own message.
 */
export function isTenantAccountConflict(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  return error?.code === "23505" && Boolean(error.message?.includes("profiles_tenant_id_unique"));
}
