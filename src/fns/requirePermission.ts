import type { SupabaseClient } from "@supabase/supabase-js";

import { recordPermissionDenied } from "@/fns/permissionAudit";
import type { AppRole, Database } from "@/integrations/supabase/database.types";

/**
 * بوابة الصلاحيات الموحّدة لدوال الخادم: تتحقق، وتسجّل الرفض، وترمي خطأً.
 *
 * Before this, the same preamble was written out in 48 files in three
 * incompatible variants: some destructured the RPC result, some kept it whole,
 * and only ten recorded the denial. The other thirty-eight refused silently, so
 * the Audit screen could show what a person did and never what they were
 * stopped from doing — and the refusal reached the browser as a thrown
 * `Response`, which TanStack Start resolves as SUCCESS (`x-tss-raw`), firing
 * the caller's success toast over an action that never happened.
 *
 * `permissionAudit.ts` deliberately stopped short of this wrapper, on the
 * grounds that turning `Response` into `Error` was a separate change from
 * recording the refusal. That change landed first (audit H2); this is the
 * consolidation it was waiting for.
 */

/** عميل Supabase مقيَّد بالمستخدم الحالي، كما تبنيه وسيطة المصادقة. */
type UserScopedClient = SupabaseClient<Database>;

/** ما تحتاجه البوابة من سياق دالة الخادم — العميل ومعرّف المستخدم فقط. */
export interface PermissionContext {
  supabase: UserScopedClient;
  userId: string;
}

export interface RequirePermissionInput {
  /** رمز الصلاحية المطلوبة، مثل "notifications.send". */
  code: string;
  /** العملية التي حاولها المستخدم، كما تُسجَّل في التدقيق — مثل "notification.send". */
  attempted: string;
  /**
   * الجملة التي يراها المستخدم عند الرفض.
   *
   * Required rather than derived from `code`: this reaches an operator as a
   * toast, and "You do not have permission to notifications.send" is not a
   * sentence. Follow `deleteAppUser.ts` and name the refused action.
   */
  refusal: string;
  entityType?: string | null;
  entityId?: string | null;
}

/**
 * يرفض التنفيذ إن لم يملك المستخدم الصلاحية، بعد تسجيل المحاولة.
 *
 * Throws an `Error`, never a `Response`. An errored RPC and a `false` answer
 * both refuse, but they are recorded differently: a check that never ran is not
 * a decision anybody made, and putting it in the security trail as a denial
 * would invent one.
 */
export async function requirePermission(
  context: PermissionContext,
  input: RequirePermissionInput,
): Promise<void> {
  const { data: allowed, error } = await context.supabase.rpc("has_permission", {
    _code: input.code,
    _user_id: context.userId,
  });
  if (!error && allowed) return;

  await recordPermissionDenied({
    supabase: context.supabase,
    permission: input.code,
    attempted: input.attempted,
    // An errored check is not a decision; only `allowed === false` is.
    outcome: error ? "check-failed" : "denied",
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
  });
  throw new Error(input.refusal);
}

export interface RequireAnyPermissionInput extends Omit<RequirePermissionInput, "code"> {
  /** الصلاحيات المقبولة بالترتيب؛ تكفي أيٌّ منها. */
  codes: readonly [string, ...string[]];
}

/**
 * يقبل المستخدم إن ملك أيّاً من الصلاحيات المذكورة، ويسجّل الرفض مرة واحدة.
 *
 * For the senders one action reaches from two screens: a deposit confirmed at
 * creation needs `deposits.create`, one confirmed later `deposits.update`.
 * Only the last code's refusal is recorded. The earlier ones are not a
 * decision about this action — they are why the next question was asked — and
 * one refused action must be one row on the Audit screen, not two.
 */
export async function requireAnyPermission(
  context: PermissionContext,
  input: RequireAnyPermissionInput,
): Promise<void> {
  const { codes, ...refusal } = input;
  const earlier = codes.slice(0, -1);
  for (const code of earlier) {
    const { data: allowed, error } = await context.supabase.rpc("has_permission", {
      _code: code,
      _user_id: context.userId,
    });
    if (!error && allowed) return;
  }
  await requirePermission(context, { ...refusal, code: codes[codes.length - 1] });
}

/** ما تحتاجه بوابات الأدوار: العملية المحاوَلة، وجملة الرفض، والكيان إن وُجد. */
export type RequireRoleInput = Omit<RequirePermissionInput, "code">;

/**
 * يسجّل رفضاً صدر عن فحص دور، ثم يرمي بالجملة التي يراها المستخدم.
 *
 * Role refusals are recorded as the permission `role:<name>`. A role is not a
 * permission code — there is no `admin` row in `permissions` — but the Audit
 * screen's denials view is keyed on "what was the caller missing", and the
 * prefix keeps a role gate from being mistaken for a grantable code. Same
 * denied / check-failed split as requirePermission.
 */
async function refuseRole(
  context: PermissionContext,
  input: RequireRoleInput & { roleLabel: string; checkFailed: boolean },
): Promise<never> {
  await recordPermissionDenied({
    supabase: context.supabase,
    permission: `role:${input.roleLabel}`,
    attempted: input.attempted,
    outcome: input.checkFailed ? "check-failed" : "denied",
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
  });
  throw new Error(input.refusal);
}

/**
 * يرفض التنفيذ إن لم يحمل المستخدم الدور المطلوب، بعد تسجيل المحاولة.
 *
 * Nineteen server functions gated on `has_role` / `is_staff` by hand and
 * refused silently, so the Audit screen never showed who was stopped from
 * erasing data, restoring a backup or deleting a user — the gates that most
 * need a trail (audit Pass 2 residual).
 */
export async function requireRole(
  context: PermissionContext,
  role: AppRole,
  input: RequireRoleInput,
): Promise<void> {
  const { data: held, error } = await context.supabase.rpc("has_role", {
    _role: role,
    _user_id: context.userId,
  });
  if (!error && held) return;
  await refuseRole(context, { ...input, roleLabel: role, checkFailed: Boolean(error) });
}

/**
 * يرفض التنفيذ إن لم يكن المستخدم من الموظفين، بعد تسجيل المحاولة.
 *
 * `is_staff` is its own RPC (any non-tenant role), so it is not expressible as
 * one `has_role` call.
 */
export async function requireStaff(
  context: PermissionContext,
  input: RequireRoleInput,
): Promise<void> {
  const { data: staff, error } = await context.supabase.rpc("is_staff", {
    _user_id: context.userId,
  });
  if (!error && staff) return;
  await refuseRole(context, { ...input, roleLabel: "staff", checkFailed: Boolean(error) });
}
