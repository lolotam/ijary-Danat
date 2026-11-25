import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { logAuditForCurrentSession } from "@/lib/audit";
import { evaluateOverdueForCurrentSession } from "@/lib/evaluateOverdue";
import { PERMISSIONS } from "@/lib/permissions";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

export function useEvaluateOverdue() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: { asOf?: string | null }) => {
      if (!permissions.can(PERMISSIONS.INVOICES_UPDATE)) throw new Error("Permission denied.");
      const rows = await evaluateOverdueForCurrentSession(input);
      await logAuditForCurrentSession({
        action: "invoice.evaluate_overdue",
        entityType: "invoice_batch",
        after: { asOf: input.asOf ?? null, changed: rows.length },
      });
      return rows;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void invalidatePortalViews(queryClient);
      queryClient.invalidateQueries({ queryKey: ["invoice-month-summary"] });
    },
  });
}
