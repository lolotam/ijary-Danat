import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { notifyMaintenanceRequestRecord } from "@/fns/notifyMaintenanceRequest.server";
import { requirePermission } from "@/fns/requirePermission";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const schema = z.object({ requestId: z.string().uuid() });

/** دالة خادم محمية بصلاحية الصيانة تطلق تنبيه طلب الصيانة الجديد من الواجهة. */
export const notifyMaintenanceRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => schema.parse(input))
  .handler(async ({ data, context }) => {
    await requirePermission(context, {
      code: "maintenance.create",
      attempted: "notification.maintenance_request",
      refusal: "You do not have permission to create a maintenance request.",
    });
    return notifyMaintenanceRequestRecord(data.requestId);
  });
