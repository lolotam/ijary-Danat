import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { runScheduledReportsForCurrentSession } from "@/lib/scheduledReportsJob";
import { PERMISSIONS } from "@/lib/permissions";

export function useRunScheduledReports() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!permissions.can(PERMISSIONS.REPORTS_READ)) throw new Error("Permission denied.");
      return runScheduledReportsForCurrentSession({ asOf: null });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["generated-reports"] });
      queryClient.invalidateQueries({ queryKey: ["report-schedules"] });
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}
