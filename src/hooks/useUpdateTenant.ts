import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import type { TablesUpdate } from "@/integrations/supabase/database.types";
import { logAuditForCurrentSession } from "@/lib/audit";
import { PERMISSIONS } from "@/lib/permissions";
import {
  isTenantSavedAuditFailed,
  isTenantStaleSave,
  TenantSavedAuditFailedError,
  TenantStaleSaveError,
} from "@/lib/tenantStaleSave";

/**
 * يعدّل صف المستأجر، ويرفض الحفظ إذا تغيّر الصف منذ أن فُتح النموذج.
 *
 * Optimistic concurrency on `tenants.updated_at`: the caller passes the
 * revision it loaded (`expectedUpdatedAt`) and the UPDATE only matches while
 * that revision still stands. A row someone else changed meanwhile makes the
 * write match nothing, so the save is refused with `TenantStaleSaveError`
 * instead of writing the form's stale values over their change — the same
 * shape as `save_shop_details_as_tenant` on the shop side.
 *
 * Without `expectedUpdatedAt` the update is unconditional, which is what the
 * call sites that hold no loaded revision ask for.
 */
export function useUpdateTenant() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async ({
      id,
      updates,
      expectedUpdatedAt,
    }: {
      id: string;
      updates: TablesUpdate<"tenants">;
      expectedUpdatedAt?: string | null;
    }) => {
      if (!permissions.can(PERMISSIONS.TENANTS_UPDATE)) throw new Error("Permission denied.");
      const { data: before, error: beforeError } = await supabase
        .from("tenants")
        .select("*")
        .eq("id", id)
        .single();
      if (beforeError) throw beforeError;
      let query = supabase.from("tenants").update(updates).eq("id", id);
      // The revision guard: only write while the row still carries the
      // `updated_at` the form was loaded with.
      if (expectedUpdatedAt) query = query.eq("updated_at", expectedUpdatedAt);
      const { data: after, error } = await query.select("*").maybeSingle();
      if (error) throw error;
      // No row came back. A stale save is reported only when the revision
      // really moved since the form was loaded; any other zero-row update
      // (row-level security, a missing row) is a plain failure, not a retry.
      if (!after) {
        if (!expectedUpdatedAt) throw new Error("Tenant update was not applied.");
        const { data: current, error: currentError } = await supabase
          .from("tenants")
          .select("updated_at")
          .eq("id", id)
          .maybeSingle();
        if (currentError) throw currentError;
        if (current && current.updated_at !== expectedUpdatedAt) throw new TenantStaleSaveError();
        throw new Error("Tenant update was not applied.");
      }
      // حُفظ الصف فعلاً؛ فشل تسجيل التدقيق وحده. نُغلّفه في خطأ يحمل الصف
      // الجديد حتى لا يُرفَض الحفظ التالي كأنه قديم.
      // The row is saved; only the audit write failed. Wrapping it carries the
      // new revision so the next save is not refused as stale.
      try {
        await logAuditForCurrentSession({
          action: "tenant.update",
          entityType: "tenant",
          entityId: id,
          before: { ...before },
          after: { ...after },
        });
      } catch (auditError) {
        throw new TenantSavedAuditFailedError(after, auditError);
      }
      return after;
    },
    onSuccess: (tenant) => {
      queryClient.invalidateQueries({ queryKey: ["tenants"] });
      queryClient.setQueryData(["tenant", tenant.id], tenant);
    },
    // رُفض الحفظ لأن الصف تغيّر في الأثناء، فنُبطل الذاكرة المؤقتة حتى تُحمَّل القيم والمراجعة الحالية عند إعادة فتح النموذج.
    // A refused stale save leaves the cache holding the old row, so invalidating here makes reopening the form load the current revision.
    onError: async (error, variables) => {
      // حُفظ المستأجر فعلاً ولم يُسجَّل تدقيقه: نضع الصف المحفوظ في الذاكرة
      // المؤقتة حتى يحمل الحفظ التالي المراجعة الجديدة بدل أن يُرفَض كقديم.
      // The tenant was saved and only the audit failed, so the saved row goes
      // into the cache and the next save is guarded by its new revision.
      if (isTenantSavedAuditFailed(error)) {
        queryClient.setQueryData(["tenant", error.tenant.id], error.tenant);
        await queryClient.invalidateQueries({ queryKey: ["tenants"] });
        return;
      }
      if (!isTenantStaleSave(error)) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["tenants"] }),
        queryClient.invalidateQueries({ queryKey: ["tenant", variables.id] }),
      ]);
    },
  });
}
