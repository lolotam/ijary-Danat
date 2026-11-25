import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import { runContractExpiryForCurrentSession } from "@/lib/contractExpiryJob";
import { PERMISSIONS } from "@/lib/permissions";

export function useRunContractExpiry() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (!permissions.can(PERMISSIONS.NOTIFICATIONS_CREATE)) throw new Error("Permission denied.");
      return runContractExpiryForCurrentSession({ asOf: null });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}
