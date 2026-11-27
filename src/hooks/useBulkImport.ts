import { useMutation, useQueryClient } from "@tanstack/react-query";

import { bulkImportRows } from "@/lib/bulkImport";
import type { BulkImportInput } from "@/fns/bulkImport";

/**
 * خطاف React Query لتنفيذ الاستيراد الجماعي وتحديث الكاش عند النتيجة الفورية.
 */
export function useBulkImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkImportInput) => bulkImportRows(input),
    onSuccess: (result, input) => {
      if ("queued" in result && result.queued) return;
      queryClient.invalidateQueries({ queryKey: [input.entity] });
      if (["properties", "buildings", "units"].includes(input.entity)) {
        queryClient.invalidateQueries({ queryKey: ["properties"] });
        queryClient.invalidateQueries({ queryKey: ["buildings"] });
        queryClient.invalidateQueries({ queryKey: ["units"] });
      }
      if (input.entity === "contracts") {
        // An imported `active` contract flips its unit to occupied through
        // migration 76's trigger, and the tenants list derives its lifecycle,
        // buildings and units from contracts — both go stale otherwise.
        queryClient.invalidateQueries({ queryKey: ["tenants"] });
        queryClient.invalidateQueries({ queryKey: ["units"] });
        queryClient.invalidateQueries({ queryKey: ["insurance_payments"] });
      }
      if (input.entity === "expenses" || input.entity === "deposits") {
        queryClient.invalidateQueries({ queryKey: ["budget"] });
        queryClient.invalidateQueries({ queryKey: ["report-preview"] });
      }
    },
  });
}
