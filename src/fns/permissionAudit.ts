import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/integrations/supabase/database.types";

/**
 * تسجيل رفض الصلاحيات في سجل التدقيق.
 *
 * `audit_logs` has carried `result` and `error_code` columns since migration 03
 * and, until now, only notification dispatch ever used them. A refused action
 * therefore left no trace at all: the Audit screen could show what a person
 * did, never what they were stopped from doing.
 *
 * Every write here is best-effort: an audit outage must never turn a refused
 * action into an allowed one.
 *
 * Money paths deliberately do NOT come through here. `reverse_payment` and
 * `apply_payment_allocation` write their own rows from inside SQL (migration
 * 213), because both are granted to `authenticated` and a direct PostgREST call
 * would otherwise move money with nothing recorded.
 */

/** الإجراء المسجَّل لكل محاولة رُفضت لنقص الصلاحية. */
export const PERMISSION_DENIED_ACTION = "permission.denied";

/** عميل Supabase مقيَّد بالمستخدم الحالي، كما تبنيه وسيطة المصادقة. */
type UserScopedClient = SupabaseClient<Database>;

/**
 * يكتب صف تدقيق واحداً دون أن يُفشل المسار الذي استدعاه.
 *
 * Split out from `recordPermissionDenied` so the swallow-and-log decision has
 * one home even though one caller remains.
 */
async function writeAuditRow(
  supabase: UserScopedClient,
  args: {
    action: string;
    entityType: string | null;
    entityId: string | null;
    after: Json | null;
    // `error` is an audit_result the schema has carried since migration 03 and
    // that only notification dispatch ever used — it is exactly right for "the
    // check never ran", as distinct from "the check said no". There is no
    // `success` arm: every row written from here records a refusal.
    result: "failure" | "error";
    errorCode: string | null;
  },
): Promise<void> {
  try {
    const { error } = await supabase.rpc("write_audit", {
      p_action: args.action,
      p_entity_type: args.entityType,
      p_entity_id: args.entityId,
      p_before: null,
      p_after: args.after,
      p_result: args.result,
      p_error_code: args.errorCode,
    });
    if (error) console.error(`Audit write failed for ${args.action}`, error.message);
  } catch (error) {
    console.error(`Audit write failed for ${args.action}`, error);
  }
}

export interface PermissionDenialInput {
  supabase: UserScopedClient;
  /** رمز الصلاحية المفقودة، مثل "payments.reverse". */
  permission: string;
  /** العملية التي حاول المستخدم تنفيذها، مثل "payment.reverse". */
  attempted: string;
  /**
   * هل صدر القرار فعلاً، أم تعذّر التحقق من الصلاحية أصلاً.
   *
   * Review finding on PR #206: the call sites refuse on
   * `permissionError || !allowed`, which merges two different facts. When the
   * `has_permission` RPC itself errors, the user's permissions were never
   * evaluated — recording that as a denial would put a decision in the security
   * trail that nobody made. The action is still refused either way; only the
   * error code distinguishes them.
   */
  outcome: "denied" | "check-failed";
  entityType?: string | null;
  entityId?: string | null;
}

/**
 * يسجّل محاولة رُفضت لنقص الصلاحية.
 *
 * Most callers now reach this through `requirePermission`, which runs the
 * check, records the refusal and throws in one call. This stays exported for
 * the handful of gates that are not a plain `has_permission` question — and
 * because the record and the refusal are separable, which is what let the
 * `Response` → `Error` change (audit H2) land before this consolidation.
 */
export async function recordPermissionDenied(input: PermissionDenialInput): Promise<void> {
  await writeAuditRow(input.supabase, {
    action: PERMISSION_DENIED_ACTION,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    after: { attempted: input.attempted, permission: input.permission },
    result: input.outcome === "denied" ? "failure" : "error",
    errorCode: input.outcome === "denied" ? "FORBIDDEN" : "PERMISSION_CHECK_FAILED",
  });
}
