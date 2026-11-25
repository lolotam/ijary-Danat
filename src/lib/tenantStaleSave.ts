import type { Tables } from "@/integrations/supabase/database.types";

/**
 * خطأ يعني أن صف المستأجر تغيّر منذ فُتح النموذج، فلا يُكتب فوق تعديل شخص آخر.
 *
 * The tenant form refuses a save whose `updated_at` no longer matches.
 */
export class TenantStaleSaveError extends Error {
  constructor() {
    super("Tenant was changed by someone else since it was opened.");
    this.name = "TenantStaleSaveError";
  }
}

/** يتحقق من أن الخطأ رفضُ حفظٍ قديم لصف المستأجر. */
export function isTenantStaleSave(error: unknown): error is TenantStaleSaveError {
  return error instanceof TenantStaleSaveError;
}

/**
 * خطأ يعني أن المستأجر حُفظ فعلاً لكن تعذّر تسجيل صف التدقيق.
 *
 * The row is saved, so callers must take its new revision.
 */
export class TenantSavedAuditFailedError extends Error {
  readonly tenant: Tables<"tenants">;
  constructor(tenant: Tables<"tenants">, cause: unknown) {
    super("Tenant was saved, but its audit row could not be written.");
    this.name = "TenantSavedAuditFailedError";
    this.tenant = tenant;
    this.cause = cause;
  }
}

/** يتحقق من أن الخطأ يعني أن صف المستأجر حُفظ فعلاً لكن تدقيقه لم يُسجَّل. */
export function isTenantSavedAuditFailed(error: unknown): error is TenantSavedAuditFailedError {
  return error instanceof TenantSavedAuditFailedError;
}
