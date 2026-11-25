import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import {
  sendBulkNotification,
  type SendBulkNotificationInput,
  type SendBulkNotificationResult,
} from "@/fns/sendBulkNotification";
import { usePermissions } from "@/hooks/usePermissions";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * يغلّف إرسال الرسائل الجماعية بصلاحية notifications.send وبطلب الخادم.
 *
 * Result includes drainCapacity / exceedsDrainCapacity so the dialog can warn
 * when the batch will not fit inside the 72h stale-cancel window.
 */
export function useSendBulkNotification() {
  const permissions = usePermissions();
  const queryClient = useQueryClient();
  const sendBulk = useServerFn(sendBulkNotification);

  return useMutation({
    mutationFn: async (input: SendBulkNotificationInput): Promise<SendBulkNotificationResult> => {
      if (!permissions.can(PERMISSIONS.NOTIFICATIONS_SEND)) {
        throw new Error("Permission denied.");
      }
      return (await sendBulk({ data: input })) as SendBulkNotificationResult;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}
