import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { dispatchNotificationRecord } from "@/fns/dispatchNotification.server";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const schema = z.object({ notificationId: z.string().uuid() });

export type DispatchNotificationInput = z.infer<typeof schema>;

/**
 * دالة الخادم التي يستدعيها المتصفح لإرسال صف إشعار واحد، بشرط صلاحية الإرسال.
 */
export const dispatchNotification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(schema)
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "notifications.send",
      attempted: "notification.dispatch",
      refusal: "You do not have permission to send notifications.",
    });
    return dispatchNotificationRecord(data.notificationId);
  });
