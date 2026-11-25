import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePermissions } from "@/hooks/usePermissions";
import type { SendNotificationInput } from "@/fns/sendNotification";
import { PERMISSIONS } from "@/lib/permissions";
import { sendNotificationForCurrentSession } from "@/lib/sendNotification";

export function useSendManualNotification() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SendNotificationInput) => {
      if (!permissions.can(PERMISSIONS.NOTIFICATIONS_SEND)) throw new Error("Permission denied.");
      return sendNotificationForCurrentSession(input);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
}
