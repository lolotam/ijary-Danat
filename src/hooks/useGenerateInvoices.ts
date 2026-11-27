import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { logAuditForCurrentSession } from "@/lib/audit";
import { generateInvoicesForCurrentSession } from "@/lib/generateInvoices";
import { PERMISSIONS } from "@/lib/permissions";
import { invalidatePortalViews } from "@/lib/portalQueryKeys";

export function useGenerateInvoices() {
  const queryClient = useQueryClient();
  const permissions = usePermissions();
  return useMutation({
    mutationFn: async (input: { year: number }) => {
      if (!permissions.can(PERMISSIONS.INVOICES_CREATE)) throw new Error("Permission denied.");
      const result = await generateInvoicesForCurrentSession(input);
      await logAuditForCurrentSession({
        action: "invoice.generate",
        entityType: "invoice_batch",
        after: { input, job_request_id: result.jobRequestId },
      });
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoices"] });
      void invalidatePortalViews(queryClient);
      queryClient.invalidateQueries({ queryKey: ["invoice-month-summary"] });
    },
  });
}
