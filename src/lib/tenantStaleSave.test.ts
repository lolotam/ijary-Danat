import { describe, expect, it } from "vitest";

import type { Tables } from "@/integrations/supabase/database.types";
import {
  isTenantSavedAuditFailed,
  isTenantStaleSave,
  TenantSavedAuditFailedError,
  TenantStaleSaveError,
} from "@/lib/tenantStaleSave";

/**
 * يتحقق من التعرّف على رفض حفظ صف مستأجر تغيّر منذ فُتح النموذج.
 *
 * The guard has to be narrow: a false positive turns an ordinary database
 * failure into "somebody else changed this tenant", and a false negative lets
 * the stale form overwrite the other person's change.
 */
describe("tenantStaleSave", () => {
  it("recognises the refused save of a stale tenant row", () => {
    expect(isTenantStaleSave(new TenantStaleSaveError())).toBe(true);
  });

  it("does not claim an ordinary error or a thrown string", () => {
    expect(isTenantStaleSave(new Error("Database timeout"))).toBe(false);
    expect(isTenantStaleSave("Database timeout")).toBe(false);
  });

  it("names the error so it can be told apart in a stack trace", () => {
    expect(new TenantStaleSaveError().name).toBe("TenantStaleSaveError");
  });
});

/**
 * يتحقق من خطأ «حُفظ الصفّ لكن تعذّر تسجيل التدقيق» — الصف محفوظ فعلاً، فحمله
 * مراجعته الجديدة هو ما يمنع رفض الحفظ التالي كأنه قديم.
 *
 * The error is the only signal that the write landed, so it has to carry the
 * saved row and the audit failure that caused it.
 */
describe("tenantSavedAuditFailed", () => {
  // الصفّ المصغّر يكفي: ما يهمّ هذا الاختبار هو الصفّ المحفوظ نفسه.
  // A trimmed row is enough — what matters here is the saved row itself.
  const savedTenant = {
    id: "tenant-1",
    updated_at: "2026-01-01T00:00:00.000Z",
  } as unknown as Tables<"tenants">;

  it("carries the saved tenant and the audit failure behind it", () => {
    const cause = new Error("audit insert failed");
    const error = new TenantSavedAuditFailedError(savedTenant, cause);
    expect(error.tenant).toBe(savedTenant);
    expect(error.cause).toBe(cause);
  });

  it("names the error so it can be told apart in a stack trace", () => {
    const error = new TenantSavedAuditFailedError(savedTenant, new Error("audit insert failed"));
    expect(error.name).toBe("TenantSavedAuditFailedError");
  });

  it("recognises the saved-but-unaudited error only", () => {
    const error = new TenantSavedAuditFailedError(savedTenant, new Error("audit insert failed"));
    expect(isTenantSavedAuditFailed(error)).toBe(true);
    expect(isTenantSavedAuditFailed(new TenantStaleSaveError())).toBe(false);
    expect(isTenantSavedAuditFailed(new Error("Database timeout"))).toBe(false);
  });
});
